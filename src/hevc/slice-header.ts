/**
 * Slice segment header parsing (7.3.6.1) for intra still images, including
 * the WPP/tile entry points iPhone captures rely on.
 *
 * Entry point offsets count bytes of the ESCAPED NAL payload (emulation
 * prevention bytes included, 7.4.7.1), so the header is parsed from the RBSP
 * while tracking the RBSP -> raw byte mapping, and each substream is
 * unescaped independently.
 */
import type { PpsInfo } from './pps'
import type { SpsInfo } from './sps'
import { BitReader } from './nal'
import { skipShortTermRefPicSet } from './sps'

export interface SliceHeader {
  firstSliceInPic: boolean
  dependentSliceSegment: boolean
  /** CTB raster index where this segment starts. */
  segmentAddress: number
  sliceType: number
  sliceQpY: number
  cbQpOffset: number
  crQpOffset: number
  saoLuma: boolean
  saoChroma: boolean
  deblockingDisabled: boolean
  betaOffsetDiv2: number
  tcOffsetDiv2: number
  loopFilterAcrossSlices: boolean
  /**
   * CABAC substreams (one per WPP row / tile, or a single one), already
   * unescaped and ready for entropy decoding.
   */
  substreams: Uint8Array[]
}

export const SLICE_TYPE_B = 0
export const SLICE_TYPE_P = 1
export const SLICE_TYPE_I = 2

interface Rbsp {
  data: Uint8Array
  /** rawIndex[i] = byte offset in `nal` that produced rbsp byte i. */
  rawIndex: Int32Array
}

/** Unescape a NAL payload (after the 2-byte header), keeping a raw map. */
function toRbspMapped(nal: Uint8Array): Rbsp {
  const data = new Uint8Array(nal.length - 2)
  const rawIndex = new Int32Array(nal.length - 2)
  let o = 0
  let zeros = 0
  for (let i = 2; i < nal.length; i++) {
    const b = nal[i]
    if (zeros >= 2 && b === 0x03) {
      zeros = 0
      continue
    }
    rawIndex[o] = i
    data[o++] = b
    zeros = b === 0 ? zeros + 1 : 0
  }
  return { data: data.subarray(0, o), rawIndex: rawIndex.subarray(0, o) }
}

/** Strip emulation prevention bytes from a raw byte range of the NAL. */
function unescapeRange(nal: Uint8Array, start: number, end: number): Uint8Array {
  const out = new Uint8Array(end - start)
  let o = 0
  let zeros = 0
  for (let i = start; i < end; i++) {
    const b = nal[i]
    if (zeros >= 2 && b === 0x03) {
      zeros = 0
      continue
    }
    out[o++] = b
    zeros = b === 0 ? zeros + 1 : 0
  }
  return out.subarray(0, o)
}

function isIrap(nalType: number): boolean {
  return nalType >= 16 && nalType <= 23
}

function isIdr(nalType: number): boolean {
  return nalType === 19 || nalType === 20
}

/** Parse one coded slice segment NAL into its header + CABAC substreams. */
export function parseSliceHeader(nal: Uint8Array, sps: SpsInfo, pps: PpsInfo): SliceHeader {
  const nalType = (nal[0] >> 1) & 0x3F
  const rbsp = toRbspMapped(nal)
  const r = new BitReader(rbsp.data)

  const firstSliceInPic = r.readBit() === 1
  if (isIrap(nalType))
    r.readBit() // no_output_of_prior_pics_flag
  r.ue() // slice_pic_parameter_set_id

  const ctbSize = 1 << sps.log2CtbSize
  const picWidthInCtbs = Math.ceil(sps.picWidthInLumaSamples / ctbSize)
  const picHeightInCtbs = Math.ceil(sps.picHeightInLumaSamples / ctbSize)
  const picSizeInCtbs = picWidthInCtbs * picHeightInCtbs

  let dependentSliceSegment = false
  let segmentAddress = 0
  if (!firstSliceInPic) {
    if (pps.dependentSliceSegmentsEnabled)
      dependentSliceSegment = r.readBit() === 1
    segmentAddress = r.readBits(Math.ceil(Math.log2(picSizeInCtbs)))
  }

  let sliceType = SLICE_TYPE_I
  let sliceQpY = pps.initQp
  let cbQpOffset = pps.cbQpOffset
  let crQpOffset = pps.crQpOffset
  let saoLuma = false
  let saoChroma = false
  let deblockingDisabled = pps.deblockingFilterDisabled
  let betaOffsetDiv2 = pps.betaOffsetDiv2
  let tcOffsetDiv2 = pps.tcOffsetDiv2
  let loopFilterAcrossSlices = pps.loopFilterAcrossSlicesEnabled

  if (!dependentSliceSegment) {
    for (let i = 0; i < pps.numExtraSliceHeaderBits; i++)
      r.readBit() // slice_reserved_flag

    sliceType = r.ue()
    if (sliceType !== SLICE_TYPE_I)
      throw new Error(`ts-heic: only intra (I) slices are supported, got slice_type ${sliceType}`)

    if (pps.outputFlagPresent)
      r.readBit() // pic_output_flag

    if (!isIdr(nalType)) {
      // CRA still images: POC + (empty) reference picture set machinery.
      r.readBits(sps.log2MaxPicOrderCntLsb) // slice_pic_order_cnt_lsb
      let useSpsSet = false
      if (sps.numShortTermRefPicSets > 0)
        useSpsSet = r.readBit() === 1 // short_term_ref_pic_set_sps_flag
      if (!useSpsSet) {
        const numDeltaPocs: number[] = []
        skipShortTermRefPicSet(r, sps.numShortTermRefPicSets, sps.numShortTermRefPicSets, numDeltaPocs)
      }
      else {
        r.readBits(Math.ceil(Math.log2(sps.numShortTermRefPicSets)))
      }
      // long-term / temporal MVP syntax would follow for real video; a still
      // image profile bitstream never sets those SPS flags.
    }

    if (sps.sampleAdaptiveOffsetEnabled) {
      saoLuma = r.readBit() === 1
      saoChroma = r.readBit() === 1
    }

    sliceQpY = pps.initQp + r.se()
    if (pps.sliceChromaQpOffsetsPresent) {
      cbQpOffset += r.se()
      crQpOffset += r.se()
    }

    let deblockingOverride = false
    if (pps.deblockingFilterOverrideEnabled)
      deblockingOverride = r.readBit() === 1
    if (deblockingOverride) {
      deblockingDisabled = r.readBit() === 1
      if (!deblockingDisabled) {
        betaOffsetDiv2 = r.se()
        tcOffsetDiv2 = r.se()
      }
    }

    if (pps.loopFilterAcrossSlicesEnabled && (saoLuma || saoChroma || !deblockingDisabled))
      loopFilterAcrossSlices = r.readBit() === 1
  }

  const entryPointOffsets: number[] = []
  if (pps.tilesEnabled || pps.entropyCodingSyncEnabled) {
    const numEntryPoints = r.ue()
    if (numEntryPoints > 0) {
      const offsetLen = r.ue() + 1
      for (let i = 0; i < numEntryPoints; i++)
        entryPointOffsets.push(r.readBits(offsetLen) + 1)
    }
  }

  if (pps.sliceSegmentHeaderExtensionPresent) {
    const extLength = r.ue()
    for (let i = 0; i < extLength; i++)
      r.readBits(8)
  }

  // byte_alignment(): a '1' bit then zeros to the next byte boundary.
  if (r.readBit() !== 1)
    throw new Error('ts-heic: slice header byte alignment bit missing')
  while (r.bitPosition % 8 !== 0)
    r.readBit()

  // Slice data begins here; map back to raw NAL bytes and split substreams.
  const dataStartRbsp = r.bitPosition >> 3
  const dataStartRaw = dataStartRbsp < rbsp.data.length ? rbsp.rawIndex[dataStartRbsp] : nal.length
  const substreams: Uint8Array[] = []
  let start = dataStartRaw
  for (const offset of entryPointOffsets) {
    substreams.push(unescapeRange(nal, start, start + offset))
    start += offset
  }
  substreams.push(unescapeRange(nal, start, nal.length))

  return {
    firstSliceInPic,
    dependentSliceSegment,
    segmentAddress,
    sliceType,
    sliceQpY,
    cbQpOffset,
    crQpOffset,
    saoLuma,
    saoChroma,
    deblockingDisabled,
    betaOffsetDiv2,
    tcOffsetDiv2,
    loopFilterAcrossSlices,
    substreams,
  }
}
