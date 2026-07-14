/**
 * The HEVC intra picture decoder: CTU wavefront loop, coding quadtree,
 * intra CU/PU/TU parsing, residual coding, and reconstruction into YUV
 * planes (7.3.8, 8.4, 8.6, 9.3).
 *
 * Scope: intra-only (I slices), 4:2:0, 8-bit — what HEIC still images use.
 * WPP (entropy_coding_sync), cu_qp_delta, and scaling lists are supported
 * because iPhone captures enable all three.
 */
import type { PpsInfo } from './pps'
import type { SliceHeader } from './slice-header'
import type { SpsInfo } from './sps'
import { CabacContexts, CabacDecoder, CTX } from './cabac'
import { filterRefs, gatherRefs, predictIntra } from './intra'
import { buildScalingFactors } from './scaling'
import { getScan, SCAN_DIAG } from './scan'
import { parseSliceHeader, SLICE_TYPE_I } from './slice-header'
import { dequantize, inverseTransform } from './transform'

const CTX_IDX_MAP_4X4 = [0, 1, 4, 5, 2, 3, 4, 5, 6, 6, 8, 8, 7, 7, 8, 8]

/** Table 8-10: chroma QP mapping for 4:2:0. */
const CHROMA_QP_TABLE = [29, 30, 31, 32, 33, 33, 34, 34, 35, 35, 36, 36, 37, 37]

function mapChromaQp(qpY: number, offset: number): number {
  const qPi = Math.min(57, Math.max(0, qpY + offset))
  if (qPi < 30)
    return qPi
  if (qPi > 43)
    return qPi - 6
  return CHROMA_QP_TABLE[qPi - 30]
}

export interface SaoParams {
  /** 0 none, 1 band, 2 edge; per component (cb/cr share type + eo class). */
  typeIdx: Int32Array
  /** Signed offsets, 4 per component. */
  offsets: Int32Array
  bandPos: Int32Array
  eoClass: Int32Array
}

export interface DecodedPicture {
  y: Uint8Array
  cb: Uint8Array
  cr: Uint8Array
  /** Coded (pre-crop) dimensions; chroma planes are half size. */
  width: number
  height: number
  /** Per-CTU SAO parameters (raster order), for the SAO stage. */
  sao: SaoParams[]
  /** Per-8x8 luma QP map, for the deblocking stage. */
  qpMap: Uint8Array
  /** Per-4x4 luma block: bit0 = left edge is a TU edge, bit1 = top edge. */
  tuEdgesY: Uint8Array
  /** Per-4x4 chroma block edge flags (chroma TBs). */
  tuEdgesC: Uint8Array
  sh: SliceHeader
}

export class PictureDecoder {
  private readonly sps: SpsInfo
  private readonly pps: PpsInfo
  private readonly bd = 8

  private readonly w: number
  private readonly h: number
  private readonly cw: number
  private readonly ch: number
  private readonly log2Ctb: number
  private readonly ctbSize: number
  private readonly widthInCtbs: number
  private readonly heightInCtbs: number

  private readonly y: Uint8Array
  private readonly cb: Uint8Array
  private readonly cr: Uint8Array

  private readonly decodedY: Uint8Array
  private readonly decodedC: Uint8Array
  private readonly bwY: number
  private readonly bhY: number
  private readonly bwC: number

  private readonly intraModeMap: Uint8Array
  private readonly ctDepthMap: Int8Array
  private readonly qpMap: Uint8Array
  private readonly tuEdgesY: Uint8Array
  private readonly tuEdgesC: Uint8Array

  private readonly scalingFactors: (Int32Array | null)[][]

  private readonly sao: SaoParams[]

  // Entropy state
  private ctxs = new CabacContexts()
  private cabac!: CabacDecoder
  private rowSnapshot: { pState: Uint8Array, valMps: Uint8Array } | null = null

  // Slice / CTU state
  private sh!: SliceHeader
  private ctbX = 0
  private ctbY = 0
  private lastQpY = 0

  // Quant group state
  private qgPredPending = false
  private isCuQpDeltaCoded = false
  private cuQpDeltaVal = 0
  private qgX = 0
  private qgY = 0
  private qpYPred = 0

  // Current CU state
  private cuQp = 0
  private cuChromaMode = 0

  constructor(sps: SpsInfo, pps: PpsInfo) {
    this.sps = sps
    this.pps = pps
    if (sps.chromaFormatIdc !== 1 || sps.bitDepthLuma !== 8 || sps.bitDepthChroma !== 8)
      throw new Error('ts-heic: only 4:2:0 8-bit HEVC is supported')
    if (sps.pcmEnabled)
      throw new Error('ts-heic: PCM coding is not supported')

    this.w = sps.picWidthInLumaSamples
    this.h = sps.picHeightInLumaSamples
    this.cw = this.w >> 1
    this.ch = this.h >> 1
    this.log2Ctb = sps.log2CtbSize
    this.ctbSize = 1 << sps.log2CtbSize
    this.widthInCtbs = Math.ceil(this.w / this.ctbSize)
    this.heightInCtbs = Math.ceil(this.h / this.ctbSize)

    this.y = new Uint8Array(this.w * this.h)
    this.cb = new Uint8Array(this.cw * this.ch)
    this.cr = new Uint8Array(this.cw * this.ch)

    this.bwY = this.w >> 2
    this.bhY = this.h >> 2
    this.bwC = this.cw >> 2
    this.decodedY = new Uint8Array(this.bwY * this.bhY)
    this.decodedC = new Uint8Array(this.bwC * (this.ch >> 2))

    this.intraModeMap = new Uint8Array(this.bwY * this.bhY).fill(1)
    this.ctDepthMap = new Int8Array(this.bwY * this.bhY).fill(-1)
    this.qpMap = new Uint8Array((this.w >> 3) * (this.h >> 3))
    this.tuEdgesY = new Uint8Array(this.bwY * this.bhY)
    this.tuEdgesC = new Uint8Array(this.bwC * (this.ch >> 2))

    const data = pps.scalingListData ?? sps.scalingListData
    this.scalingFactors = []
    for (let sizeId = 0; sizeId < 4; sizeId++) {
      this.scalingFactors[sizeId] = []
      for (let matrixId = 0; matrixId < 3; matrixId++)
        this.scalingFactors[sizeId][matrixId] = data ? buildScalingFactors(data, sizeId, matrixId) : null
    }

    this.sao = Array.from({ length: this.widthInCtbs * this.heightInCtbs }, () => ({
      typeIdx: new Int32Array(3),
      offsets: new Int32Array(12),
      bandPos: new Int32Array(3),
      eoClass: new Int32Array(3),
    }))
  }

  /** Decode all slice NALs of one coded picture. */
  decode(sliceNals: Uint8Array[]): DecodedPicture {
    for (const nal of sliceNals) {
      const sh = parseSliceHeader(nal, this.sps, this.pps)
      if (sh.sliceType !== SLICE_TYPE_I)
        throw new Error('ts-heic: non-intra slice in still image')
      this.decodeSlice(sh)
    }
    return {
      y: this.y,
      cb: this.cb,
      cr: this.cr,
      width: this.w,
      height: this.h,
      sao: this.sao,
      qpMap: this.qpMap,
      tuEdgesY: this.tuEdgesY,
      tuEdgesC: this.tuEdgesC,
      sh: this.sh,
    }
  }

  private decodeSlice(sh: SliceHeader): void {
    this.sh = sh
    const totalCtbs = this.widthInCtbs * this.heightInCtbs
    let substreamIdx = 0
    this.ctxs.init(sh.sliceQpY)
    this.cabac = new CabacDecoder(sh.substreams[substreamIdx++], this.ctxs)
    this.lastQpY = sh.sliceQpY
    this.rowSnapshot = null

    for (let ctbAddr = sh.segmentAddress; ctbAddr < totalCtbs; ctbAddr++) {
      this.ctbX = ctbAddr % this.widthInCtbs
      this.ctbY = (ctbAddr / this.widthInCtbs) | 0

      if (this.pps.entropyCodingSyncEnabled && this.ctbX === 0 && ctbAddr !== sh.segmentAddress) {
        // New WPP row: fresh substream, contexts from the row above's
        // second CTU (or fresh init when that is unavailable).
        this.cabac = new CabacDecoder(sh.substreams[substreamIdx++], this.ctxs)
        if (this.rowSnapshot && this.widthInCtbs > 1)
          this.ctxs.restore(this.rowSnapshot)
        else
          this.ctxs.init(sh.sliceQpY)
        this.lastQpY = sh.sliceQpY
      }

      if (this.sps.sampleAdaptiveOffsetEnabled && (sh.saoLuma || sh.saoChroma))
        this.parseSao()

      this.codingQuadtree(this.ctbX << this.log2Ctb, this.ctbY << this.log2Ctb, this.log2Ctb, 0)

      if (this.pps.entropyCodingSyncEnabled && this.ctbX === 1)
        this.rowSnapshot = this.ctxs.save()

      const end = this.cabac.decodeTerminate()
      if (ctbAddr === totalCtbs - 1) {
        if (end !== 1)
          throw new Error(`ts-heic: CABAC desync — end_of_slice_segment_flag not set at the last CTU (${this.ctbX},${this.ctbY})`)
      }
      else if (end === 1) {
        // Slice segment ended before the picture did (multi-slice picture).
        return
      }
      else if (this.pps.entropyCodingSyncEnabled && this.ctbX === this.widthInCtbs - 1) {
        if (this.cabac.decodeTerminate() !== 1)
          throw new Error(`ts-heic: CABAC desync — end_of_subset_one_bit missing at row ${this.ctbY}`)
      }
    }
  }

  // ---------------------------------------------------------------- SAO

  private parseSao(): void {
    const idx = this.ctbY * this.widthInCtbs + this.ctbX
    const params = this.sao[idx]
    const { sh } = this

    let merged = false
    if (this.ctbX > 0) {
      const left = this.cabac.decodeBin(CTX.SAO_MERGE)
      if (left === 1) {
        this.copySao(this.sao[idx - 1], params)
        merged = true
      }
    }
    if (!merged && this.ctbY > 0) {
      const up = this.cabac.decodeBin(CTX.SAO_MERGE)
      if (up === 1) {
        this.copySao(this.sao[idx - this.widthInCtbs], params)
        merged = true
      }
    }
    if (merged)
      return

    for (let cIdx = 0; cIdx < 3; cIdx++) {
      if ((cIdx === 0 && !sh.saoLuma) || (cIdx > 0 && !sh.saoChroma))
        continue
      if (cIdx === 2) {
        // Cr shares type and EO class with Cb; offsets are its own.
        params.typeIdx[2] = params.typeIdx[1]
        params.eoClass[2] = params.eoClass[1]
      }
      else {
        let type = 0
        if (this.cabac.decodeBin(CTX.SAO_TYPE_IDX) === 1)
          type = this.cabac.decodeBypass() === 1 ? 2 : 1
        params.typeIdx[cIdx] = type
      }
      const type = params.typeIdx[cIdx]
      if (type === 0)
        continue

      const offsets = [0, 0, 0, 0]
      for (let i = 0; i < 4; i++) {
        // TR cMax 7, bypass
        let v = 0
        while (v < 7 && this.cabac.decodeBypass() === 1)
          v++
        offsets[i] = v
      }
      if (type === 1) {
        for (let i = 0; i < 4; i++) {
          if (offsets[i] !== 0 && this.cabac.decodeBypass() === 1)
            offsets[i] = -offsets[i]
        }
        params.bandPos[cIdx] = this.cabac.decodeBypassBits(5)
      }
      else {
        // Edge offsets: first two positive, last two negative.
        offsets[2] = -offsets[2]
        offsets[3] = -offsets[3]
        if (cIdx < 2)
          params.eoClass[cIdx] = this.cabac.decodeBypassBits(2)
      }
      for (let i = 0; i < 4; i++)
        params.offsets[cIdx * 4 + i] = offsets[i]
    }
  }

  private copySao(from: SaoParams, to: SaoParams): void {
    to.typeIdx.set(from.typeIdx)
    to.offsets.set(from.offsets)
    to.bandPos.set(from.bandPos)
    to.eoClass.set(from.eoClass)
  }

  // ------------------------------------------------------ coding quadtree

  private codingQuadtree(x0: number, y0: number, log2CbSize: number, ctDepth: number): void {
    const size = 1 << log2CbSize
    const inside = x0 + size <= this.w && y0 + size <= this.h

    let split: boolean
    if (inside && log2CbSize > this.sps.log2MinLumaCodingBlockSize) {
      const condL = x0 > 0 && this.ctDepthAt(x0 - 1, y0) > ctDepth ? 1 : 0
      const condA = y0 > 0 && this.ctDepthAt(x0, y0 - 1) > ctDepth ? 1 : 0
      split = this.cabac.decodeBin(CTX.SPLIT_CU + condL + condA) === 1
    }
    else {
      split = log2CbSize > this.sps.log2MinLumaCodingBlockSize
    }

    if (this.pps.cuQpDeltaEnabled && log2CbSize >= this.log2Ctb - this.pps.diffCuQpDeltaDepth) {
      this.isCuQpDeltaCoded = false
      this.cuQpDeltaVal = 0
      this.qgX = x0
      this.qgY = y0
      this.qgPredPending = true
    }

    if (split) {
      const half = size >> 1
      // Children are recursed only when they start inside the picture.
      this.recurseChild(x0, y0, log2CbSize - 1, ctDepth + 1)
      this.recurseChild(x0 + half, y0, log2CbSize - 1, ctDepth + 1)
      this.recurseChild(x0, y0 + half, log2CbSize - 1, ctDepth + 1)
      this.recurseChild(x0 + half, y0 + half, log2CbSize - 1, ctDepth + 1)
    }
    else {
      this.codingUnit(x0, y0, log2CbSize, ctDepth)
    }
  }

  private recurseChild(x: number, y: number, log2: number, depth: number): void {
    if (x < this.w && y < this.h)
      this.codingQuadtree(x, y, log2, depth)
  }

  private ctDepthAt(x: number, y: number): number {
    return this.ctDepthMap[(y >> 2) * this.bwY + (x >> 2)]
  }

  // ------------------------------------------------------------ coding unit

  private codingUnit(x0: number, y0: number, log2CbSize: number, ctDepth: number): void {
    const size = 1 << log2CbSize
    if (this.pps.transquantBypassEnabled && this.cabac.decodeBin(CTX.TQ_BYPASS) === 1)
      throw new Error('ts-heic: cu_transquant_bypass is not supported')

    // part_mode: only signalled at the minimum CB size for intra.
    let partNxN = false
    if (log2CbSize === this.sps.log2MinLumaCodingBlockSize) {
      partNxN = this.cabac.decodeBin(CTX.PART_MODE) === 0
    }

    // QP prediction for this quant group (8.6.1).
    if (this.pps.cuQpDeltaEnabled) {
      if (this.qgPredPending) {
        this.qpYPred = this.predictQp()
        this.qgPredPending = false
      }
      this.cuQp = (this.qpYPred + this.cuQpDeltaVal + 52) % 52
    }
    else {
      this.cuQp = this.sh.sliceQpY
    }

    // Luma intra modes (7.4.9.5, 8.4.2).
    const nPu = partNxN ? 2 : 1
    const pbSize = size >> (partNxN ? 1 : 0)
    const prevFlags: boolean[] = []
    const mpmIdx: number[] = []
    const remMode: number[] = []
    for (let i = 0; i < nPu * nPu; i++) {
      const f = this.cabac.decodeBin(CTX.PREV_INTRA_LUMA_PRED)
      prevFlags.push(f === 1)
    }
    for (let i = 0; i < nPu * nPu; i++) {
      if (prevFlags[i]) {
        // mpm_idx: TR cMax 2, bypass bins.
        let v = 0
        if (this.cabac.decodeBypass() === 1) {
          v = 1
          if (this.cabac.decodeBypass() === 1)
            v = 2
        }
        mpmIdx.push(v)
        remMode.push(0)
      }
      else {
        mpmIdx.push(-1)
        const rem = this.cabac.decodeBypassBits(5)
        remMode.push(rem)
      }
    }

    const puModes: number[] = []
    for (let i = 0; i < nPu * nPu; i++) {
      const xPb = x0 + (i % nPu) * pbSize
      const yPb = y0 + ((i / nPu) | 0) * pbSize
      const cand = this.mpmCandidates(xPb, yPb)
      let mode: number
      if (prevFlags[i]) {
        mode = cand[mpmIdx[i]]
      }
      else {
        cand.sort((a, b) => a - b)
        mode = remMode[i]
        for (const c of cand) {
          if (mode >= c)
            mode++
        }
      }
      puModes.push(mode)
      this.setIntraModes(xPb, yPb, pbSize, mode)
    }

    // Chroma mode (one for 4:2:0), derived from PU0's luma mode.
    const lumaMode0 = puModes[0]
    if (this.cabac.decodeBin(CTX.INTRA_CHROMA_PRED_MODE) === 0) {
      this.cuChromaMode = lumaMode0
    }
    else {
      const idx = this.cabac.decodeBypassBits(2)
      const list = [0, 26, 10, 1]
      const chosen = list[idx]
      this.cuChromaMode = chosen === lumaMode0 ? 34 : chosen
    }

    // Transform tree. MaxTrafoDepth = max_transform_hierarchy_depth_intra
    // + IntraSplitFlag; an NxN CU forces the first split.
    const maxTrafoDepth = this.sps.maxTransformHierarchyDepthIntra + (partNxN ? 1 : 0)
    this.transformTree(x0, y0, x0, y0, log2CbSize, 0, 0, partNxN, maxTrafoDepth, puModes, true, true)

    // Bookkeeping for neighbors and the loop filters.
    this.setCtDepth(x0, y0, size, ctDepth)
    const qw = this.w >> 3
    for (let by = y0 >> 3; by < (y0 + size) >> 3; by++) {
      for (let bx = x0 >> 3; bx < (x0 + size) >> 3; bx++)
        this.qpMap[by * qw + bx] = this.cuQp
    }
    this.lastQpY = this.cuQp
  }

  private predictQp(): number {
    const qw = this.w >> 3
    const inCtbX = (x: number): boolean => (x >> this.log2Ctb) === this.ctbX
    const inCtbY = (y: number): boolean => (y >> this.log2Ctb) === this.ctbY

    const availA = this.qgX > 0 && inCtbX(this.qgX - 1) && inCtbY(this.qgY)
    const qpA = availA ? this.qpMap[(this.qgY >> 3) * qw + ((this.qgX - 1) >> 3)] : this.lastQpY
    const availB = this.qgY > 0 && inCtbY(this.qgY - 1) && inCtbX(this.qgX)
    const qpB = availB ? this.qpMap[((this.qgY - 1) >> 3) * qw + (this.qgX >> 3)] : this.lastQpY
    return (qpA + qpB + 1) >> 1
  }

  private mpmCandidates(xPb: number, yPb: number): number[] {
    // Left neighbor; above neighbor must be inside the current CTB row.
    const candA = xPb > 0 ? this.intraModeAt(xPb - 1, yPb) : 1
    const candB = yPb > 0 && (yPb - 1) >> this.log2Ctb === this.ctbY
      ? this.intraModeAt(xPb, yPb - 1)
      : 1

    if (candA === candB) {
      if (candA < 2)
        return [0, 1, 26]
      return [candA, 2 + ((candA + 29) % 32), 2 + ((candA - 2 + 1) % 32)]
    }
    const third = candA !== 0 && candB !== 0 ? 0 : (candA !== 1 && candB !== 1 ? 1 : 26)
    return [candA, candB, third]
  }

  private intraModeAt(x: number, y: number): number {
    return this.intraModeMap[(y >> 2) * this.bwY + (x >> 2)]
  }

  private setIntraModes(x: number, y: number, size: number, mode: number): void {
    for (let by = y >> 2; by < (y + size) >> 2; by++)
      this.intraModeMap.fill(mode, by * this.bwY + (x >> 2), by * this.bwY + ((x + size) >> 2))
  }

  private setCtDepth(x: number, y: number, size: number, depth: number): void {
    for (let by = y >> 2; by < (y + size) >> 2; by++)
      this.ctDepthMap.fill(depth, by * this.bwY + (x >> 2), by * this.bwY + ((x + size) >> 2))
  }

  // --------------------------------------------------------- transform tree

  private transformTree(
    x0: number,
    y0: number,
    xBase: number,
    yBase: number,
    log2Size: number,
    trafoDepth: number,
    blkIdx: number,
    intraSplit: boolean,
    maxTrafoDepth: number,
    puModes: number[],
    parentCbfCb: boolean,
    parentCbfCr: boolean,
  ): void {
    let split: boolean
    const forcedSplit = (intraSplit && trafoDepth === 0) || log2Size > this.sps.log2MaxTransformBlockSize
    if (forcedSplit) {
      split = true
    }
    else if (
      log2Size <= this.sps.log2MaxTransformBlockSize
        && log2Size > this.sps.log2MinTransformBlockSize
        && trafoDepth < maxTrafoDepth
    ) {
      split = this.cabac.decodeBin(CTX.SPLIT_TRANSFORM + (5 - log2Size)) === 1
    }
    else {
      split = false
    }

    // Chroma cbfs live at nodes with log2Size > 2 (4:2:0).
    let cbfCb = parentCbfCb
    let cbfCr = parentCbfCr
    if (log2Size > 2) {
      if (trafoDepth === 0 || parentCbfCb) {
        cbfCb = this.cabac.decodeBin(CTX.CBF_CHROMA + trafoDepth) === 1
      }
      else { cbfCb = false }
      if (trafoDepth === 0 || parentCbfCr) {
        cbfCr = this.cabac.decodeBin(CTX.CBF_CHROMA + trafoDepth) === 1
      }
      else { cbfCr = false }
    }

    if (split) {
      const half = 1 << (log2Size - 1)
      this.transformTree(x0, y0, x0, y0, log2Size - 1, trafoDepth + 1, 0, intraSplit, maxTrafoDepth, puModes, cbfCb, cbfCr)
      this.transformTree(x0 + half, y0, x0, y0, log2Size - 1, trafoDepth + 1, 1, intraSplit, maxTrafoDepth, puModes, cbfCb, cbfCr)
      this.transformTree(x0, y0 + half, x0, y0, log2Size - 1, trafoDepth + 1, 2, intraSplit, maxTrafoDepth, puModes, cbfCb, cbfCr)
      this.transformTree(x0 + half, y0 + half, x0, y0, log2Size - 1, trafoDepth + 1, 3, intraSplit, maxTrafoDepth, puModes, cbfCb, cbfCr)
      return
    }

    // cbf_luma: always signalled for intra CUs at the leaves.
    const cbfLuma = this.cabac.decodeBin(CTX.CBF_LUMA + (trafoDepth === 0 ? 1 : 0)) === 1
    this.transformUnit(x0, y0, xBase, yBase, log2Size, blkIdx, cbfLuma, cbfCb, cbfCr, puModes)
  }

  // --------------------------------------------------------- transform unit

  private transformUnit(
    x0: number,
    y0: number,
    xBase: number,
    yBase: number,
    log2Size: number,
    blkIdx: number,
    cbfLuma: boolean,
    cbfCb: boolean,
    cbfCr: boolean,
    puModes: number[],
  ): void {
    // cbfChroma refers to the PARENT node's chroma cbfs for 4x4 TUs at any
    // blkIdx (7.3.8.10) — the qp delta can be coded at blkIdx 0 even though
    // the chroma residual itself only follows at blkIdx 3.
    const chromaHere = log2Size > 2 || blkIdx === 3
    const cbfChroma = cbfCb || cbfCr

    if ((cbfLuma || cbfChroma) && this.pps.cuQpDeltaEnabled && !this.isCuQpDeltaCoded) {
      this.decodeCuQpDelta()
      this.cuQp = (this.qpYPred + this.cuQpDeltaVal + 52) % 52
    }

    // Luma TB: predict, then add residual when coded.
    const lumaMode = this.intraModeAt(x0, y0)
    let lumaLevels: Int32Array | null = null
    if (cbfLuma)
      lumaLevels = this.residualCoding(x0, y0, log2Size, 0, lumaMode)
    this.reconstruct(this.y, this.w, this.decodedY, this.bwY, this.tuEdgesY, x0, y0, 1 << log2Size, lumaMode, 0, lumaLevels, this.cuQp)

    if (!chromaHere)
      return

    // Chroma TBs: at this node (log2 > 2) or on the parent's area (blkIdx 3).
    const log2C = Math.max(2, log2Size - 1)
    const xC = (log2Size === 2 ? xBase : x0) >> 1
    const yC = (log2Size === 2 ? yBase : y0) >> 1
    const sizeC = 1 << log2C
    const qpCb = mapChromaQp(this.cuQp, this.sh.cbQpOffset)
    const qpCr = mapChromaQp(this.cuQp, this.sh.crQpOffset)

    let cbLevels: Int32Array | null = null
    let crLevels: Int32Array | null = null
    if (cbfCb)
      cbLevels = this.residualCoding(xC * 2, yC * 2, log2C, 1, this.cuChromaMode)
    if (cbfCr)
      crLevels = this.residualCoding(xC * 2, yC * 2, log2C, 2, this.cuChromaMode)

    this.reconstruct(this.cb, this.cw, this.decodedC, this.bwC, this.tuEdgesC, xC, yC, sizeC, this.cuChromaMode, 1, cbLevels, qpCb)
    this.reconstruct(this.cr, this.cw, this.decodedC, this.bwC, this.tuEdgesC, xC, yC, sizeC, this.cuChromaMode, 2, crLevels, qpCr)
  }

  private decodeCuQpDelta(): void {
    // cu_qp_delta_abs: TR prefix (cMax 5, ctx0 then ctx1) + EG0 suffix.
    let prefix = 0
    if (this.cabac.decodeBin(CTX.CU_QP_DELTA) === 1) {
      prefix = 1
      while (prefix < 5 && this.cabac.decodeBin(CTX.CU_QP_DELTA + 1) === 1)
        prefix++
    }
    let abs = prefix
    if (prefix === 5) {
      // EG0 suffix, bypass.
      let k = 0
      let value = 0
      while (this.cabac.decodeBypass() === 1) {
        value += 1 << k
        k++
      }
      abs = 5 + value + this.cabac.decodeBypassBits(k)
    }
    if (abs > 0 && this.cabac.decodeBypass() === 1)
      abs = -abs
    this.cuQpDeltaVal = abs
    this.isCuQpDeltaCoded = true
  }

  // -------------------------------------------------------- reconstruction

  private reconstruct(
    plane: Uint8Array,
    stride: number,
    decodedMap: Uint8Array,
    blockStride: number,
    edgeMap: Uint8Array,
    x: number,
    y: number,
    size: number,
    mode: number,
    cIdx: number,
    levels: Int32Array | null,
    qp: number,
  ): void {
    const planeH = cIdx === 0 ? this.h : this.ch
    const available = (px: number, py: number): boolean =>
    px >= 0 && py >= 0 && px < stride && py < planeH
      && decodedMap[(py >> 2) * blockStride + (px >> 2)] === 1

    const refs = gatherRefs(plane, stride, x, y, size, this.bd, available)
    filterRefs(refs, size, mode, cIdx, this.bd, this.sps.strongIntraSmoothingEnabled)
    const pred = predictIntra(refs, size, mode, cIdx, this.bd)

    let residual: Int32Array | null = null
    if (levels) {
      const sizeId = (31 - Math.clz32(size)) - 2
      const factors = this.scalingFactors[sizeId][cIdx]
      const deq = dequantize(levels, size, qp, this.bd, factors)
      residual = inverseTransform(deq, size, this.bd, cIdx === 0 && size === 4)
    }

    for (let dy = 0; dy < size; dy++) {
      const row = (y + dy) * stride + x
      for (let dx = 0; dx < size; dx++) {
        let v = pred[dy * size + dx]
        if (residual)
          v += residual[dy * size + dx]
        plane[row + dx] = v < 0 ? 0 : v > 255 ? 255 : v
      }
    }

    for (let by = y >> 2; by < (y + size) >> 2; by++)
      decodedMap.fill(1, by * blockStride + (x >> 2), by * blockStride + ((x + size) >> 2))

    // Record TU edges for deblocking (left edge, top edge).
    for (let by = y >> 2; by < (y + size) >> 2; by++)
      edgeMap[by * blockStride + (x >> 2)] |= 1
    for (let bx = x >> 2; bx < (x + size) >> 2; bx++)
      edgeMap[(y >> 2) * blockStride + bx] |= 2
  }

  // ------------------------------------------------------- residual coding

  private residualCoding(x0: number, y0: number, log2Size: number, cIdx: number, predMode: number): Int32Array {
    const size = 1 << log2Size
    const levels = new Int32Array(size * size)
    const cabac = this.cabac

    // Mode-dependent scan (7.4.9.11).
    let scanIdx = SCAN_DIAG
    if (log2Size === 2 || (log2Size === 3 && cIdx === 0)) {
      if (predMode >= 6 && predMode <= 14)
        scanIdx = 2
      else if (predMode >= 22 && predMode <= 30)
        scanIdx = 1
    }

    // Last significant coefficient position (9.3.4.2.3).
    let lastX = this.decodeLastPrefix(log2Size, cIdx, CTX.LAST_SIG_X)
    let lastY = this.decodeLastPrefix(log2Size, cIdx, CTX.LAST_SIG_Y)
    if (lastX > 3) {
      const bits = (lastX >> 1) - 1
      lastX = ((2 + (lastX & 1)) << bits) + cabac.decodeBypassBits(bits)
    }
    if (lastY > 3) {
      const bits = (lastY >> 1) - 1
      lastY = ((2 + (lastY & 1)) << bits) + cabac.decodeBypassBits(bits)
    }
    if (scanIdx === 2) {
      const t = lastX
      lastX = lastY
      lastY = t
    }

    const numSb = size >> 2
    const sbScan = getScan(scanIdx, numSb)
    const posScan = getScan(scanIdx, 4)

    const lastSbRaster = (lastY >> 2) * numSb + (lastX >> 2)
    const lastPosRaster = ((lastY & 3) << 2) + (lastX & 3)
    let lastSbIdx = -1
    for (let i = 0; i < numSb * numSb; i++) {
      if (sbScan[i] === lastSbRaster) {
        lastSbIdx = i
        break
      }
    }
    let lastPosIdx = -1
    for (let nIdx = 0; nIdx < 16; nIdx++) {
      if (posScan[nIdx] === lastPosRaster) {
        lastPosIdx = nIdx
        break
      }
    }

    const csbf = new Uint8Array(numSb * numSb)
    let prevSubsetG1 = false
    let firstSubset = true

    for (let i = lastSbIdx; i >= 0; i--) {
      const sbRaster = sbScan[i]
      const xS = sbRaster % numSb
      const yS = (sbRaster / numSb) | 0
      const csbfRight = xS + 1 < numSb ? csbf[sbRaster + 1] : 0
      const csbfBelow = yS + 1 < numSb ? csbf[sbRaster + numSb] : 0

      let inferSbDcSig = false
      if (i < lastSbIdx && i > 0) {
        const ctxInc = Math.min(1, csbfRight + csbfBelow) + (cIdx > 0 ? 2 : 0)
        const csbfBit = cabac.decodeBin(CTX.CODED_SUB_BLOCK + ctxInc)
        if (csbfBit === 0)
          continue
        csbf[sbRaster] = 1
        inferSbDcSig = true
      }
      else {
        csbf[sbRaster] = 1
      }

      // Significance map: positions n (descending scan order) with coeffs.
      const sigPos: number[] = []
      if (i === lastSbIdx)
        sigPos.push(lastPosIdx)
      const startN = i === lastSbIdx ? lastPosIdx - 1 : 15
      for (let pos = startN; pos >= 0; pos--) {
        if (pos > 0 || !inferSbDcSig) {
          const raster = posScan[pos]
          const xP = raster & 3
          const yP = raster >> 2
          const ctxInc = this.sigCtxInc(log2Size, cIdx, xS * 4 + xP, yS * 4 + yP, xP, yP, scanIdx, csbfRight, csbfBelow, xS, yS)
          const sigBit = cabac.decodeBin(CTX.SIG_COEFF + ctxInc)
          if (sigBit === 1) {
            sigPos.push(pos)
            inferSbDcSig = false
          }
        }
        else {
          sigPos.push(pos) // inferred significant DC
        }
      }
      if (sigPos.length === 0)
        continue

      // coeff_abs_level_greater1 (up to 8), greater2 (at most 1).
      let ctxSet = (i === 0 || cIdx > 0) ? 0 : 2
      if (!firstSubset && prevSubsetG1)
        ctxSet++
      firstSubset = false

      let g1Ctx = 1
      let firstG1 = -1
      const g1: number[] = []
      for (let c = 0; c < sigPos.length; c++) {
        if (c < 8) {
          const ctxInc = ctxSet * 4 + Math.min(3, g1Ctx) + (cIdx > 0 ? 16 : 0)
          const flag = cabac.decodeBin(CTX.GREATER1 + ctxInc)
          g1.push(flag)
          if (flag === 1) {
            if (firstG1 < 0)
              firstG1 = c
            g1Ctx = 0
          }
          else if (g1Ctx > 0) {
            g1Ctx++
          }
        }
        else {
          g1.push(0)
        }
      }
      prevSubsetG1 = firstG1 >= 0

      let g2 = 0
      if (firstG1 >= 0) {
        g2 = cabac.decodeBin(CTX.GREATER2 + ctxSet + (cIdx > 0 ? 4 : 0))
      }

      // Signs (sign hiding applies to the lowest scan position).
      const lastN = sigPos[0]
      const firstN = sigPos[sigPos.length - 1]
      const signHidden = this.pps.signDataHidingEnabled && lastN - firstN > 3
      const signs: number[] = []
      for (let c = 0; c < sigPos.length; c++) {
        if (signHidden && sigPos[c] === firstN)
          signs.push(0)
        else
          signs.push(cabac.decodeBypass())
      }

      // Levels: base + coeff_abs_level_remaining with Rice adaptation.
      let cRice = 0
      let sumAbs = 0
      const absLevels: number[] = []
      for (let c = 0; c < sigPos.length; c++) {
        const base = 1 + (c < 8 ? g1[c] : 0) + (c === firstG1 ? g2 : 0)
        const threshold = c < 8 ? (c === firstG1 ? 3 : 2) : 1
        let level = base
        if (base === threshold) {
          const rem = this.decodeRemaining(cRice)
          level += rem
          if (level > 3 * (1 << cRice))
            cRice = Math.min(cRice + 1, 4)
        }
        sumAbs += level
        absLevels.push(level)
      }

      for (let c = 0; c < sigPos.length; c++) {
        const pos = sigPos[c]
        const raster = posScan[pos]
        const xC = xS * 4 + (raster & 3)
        const yC = yS * 4 + (raster >> 2)
        let negative = signs[c] === 1
        if (signHidden && pos === firstN)
          negative = (sumAbs & 1) === 1
        levels[yC * size + xC] = negative ? -absLevels[c] : absLevels[c]
      }
    }

    return levels
  }

  private decodeLastPrefix(log2Size: number, cIdx: number, base: number): number {
    const cMax = (log2Size << 1) - 1
    const offset = cIdx === 0 ? 3 * (log2Size - 2) + ((log2Size - 1) >> 2) : 15
    const shift = cIdx === 0 ? (log2Size + 1) >> 2 : log2Size - 2
    let i = 0
    while (i < cMax && this.cabac.decodeBin(base + offset + (i >> shift)) === 1)
      i++
    return i
  }

  private sigCtxInc(
    log2Size: number,
    cIdx: number,
    xC: number,
    yC: number,
    xP: number,
    yP: number,
    scanIdx: number,
    csbfRight: number,
    csbfBelow: number,
    xS: number,
    yS: number,
  ): number {
    const chromaOffset = cIdx > 0 ? 27 : 0
    if (log2Size === 2)
      return CTX_IDX_MAP_4X4[(yC << 2) + xC] + chromaOffset
    if (xC + yC === 0)
      return chromaOffset

    const prevCsbf = csbfRight + 2 * csbfBelow
    let sigCtx: number
    if (prevCsbf === 0)
      sigCtx = xP + yP === 0 ? 2 : xP + yP < 3 ? 1 : 0
    else if (prevCsbf === 1)
      sigCtx = yP === 0 ? 2 : yP === 1 ? 1 : 0
    else if (prevCsbf === 2)
      sigCtx = xP === 0 ? 2 : xP === 1 ? 1 : 0
    else
      sigCtx = 2

    if (cIdx === 0 && (xS > 0 || yS > 0))
      sigCtx += 3
    if (log2Size === 3)
      sigCtx += scanIdx === SCAN_DIAG ? 9 : 15
    else
      sigCtx += cIdx === 0 ? 21 : 12
    return sigCtx + chromaOffset
  }

  private decodeRemaining(cRice: number): number {
    let prefix = 0
    while (prefix < 32 && this.cabac.decodeBypass() === 1)
      prefix++
    if (prefix <= 3)
      return (prefix << cRice) + this.cabac.decodeBypassBits(cRice)
    return (((1 << (prefix - 3)) + 2) << cRice) + this.cabac.decodeBypassBits(prefix - 3 + cRice)
  }
}
