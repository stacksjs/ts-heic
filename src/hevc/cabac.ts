/**
 * CABAC entropy decoding (9.3): the binary arithmetic decoder engine,
 * context-model storage with the I-slice (initType 0) initialization values
 * from Tables 9-5..9-32, and WPP context snapshot/restore.
 */

/** Table 9-46: rangeTabLps[pStateIdx][qRangeIdx]. */
const RANGE_TAB_LPS = new Uint8Array([
  128, 176, 208, 240, 128, 167, 197, 227, 128, 158, 187, 216, 123, 150, 178, 205,
  116, 142, 169, 195, 111, 135, 160, 185, 105, 128, 152, 175, 100, 122, 144, 166,
  95, 116, 137, 158, 90, 110, 130, 150, 85, 104, 123, 142, 81, 99, 117, 135,
  77, 94, 111, 128, 73, 89, 105, 122, 69, 85, 100, 116, 66, 80, 95, 110,
  62, 76, 90, 104, 59, 72, 86, 99, 56, 69, 81, 94, 53, 65, 77, 89,
  51, 62, 73, 85, 48, 59, 69, 80, 46, 56, 66, 76, 43, 53, 63, 72,
  41, 50, 59, 69, 39, 48, 56, 65, 37, 45, 54, 62, 35, 43, 51, 59,
  33, 41, 48, 56, 32, 39, 46, 53, 30, 37, 43, 50, 29, 35, 41, 48,
  27, 33, 39, 45, 26, 31, 37, 43, 24, 30, 35, 41, 23, 28, 33, 39,
  22, 27, 32, 37, 21, 26, 30, 35, 20, 24, 29, 33, 19, 23, 27, 31,
  18, 22, 26, 30, 17, 21, 25, 28, 16, 20, 23, 27, 15, 19, 22, 25,
  14, 18, 21, 24, 14, 17, 20, 23, 13, 16, 19, 22, 12, 15, 18, 21,
  12, 14, 17, 20, 11, 14, 16, 19, 11, 13, 15, 18, 10, 12, 15, 17,
  10, 12, 14, 16, 9, 11, 13, 15, 9, 11, 12, 14, 8, 10, 12, 14,
  8, 9, 11, 13, 7, 9, 11, 12, 7, 9, 10, 12, 7, 8, 10, 11,
  6, 8, 9, 11, 6, 7, 9, 10, 6, 7, 8, 9, 2, 2, 2, 2,
])

/** Table 9-47: state transition on an LPS decode. */
const TRANS_IDX_LPS = new Uint8Array([
  0, 0, 1, 2, 2, 4, 4, 5, 6, 7, 8, 9, 9, 11, 11, 12,
  13, 13, 15, 15, 16, 16, 18, 18, 19, 19, 21, 21, 22, 22, 23, 24,
  24, 25, 26, 26, 27, 27, 28, 29, 29, 30, 30, 30, 31, 32, 32, 33,
  33, 33, 34, 34, 35, 35, 35, 36, 36, 36, 37, 37, 37, 38, 38, 63,
])

// Context table layout: one flat array, sections per syntax element.
let n = 0
function section(count: number): number {
  const at = n
  n += count
  return at
}

export const CTX = {
  SAO_MERGE: section(1),
  SAO_TYPE_IDX: section(1),
  SPLIT_CU: section(3),
  TQ_BYPASS: section(1),
  PART_MODE: section(1),
  PREV_INTRA_LUMA_PRED: section(1),
  INTRA_CHROMA_PRED_MODE: section(1),
  SPLIT_TRANSFORM: section(3),
  CBF_LUMA: section(2),
  CBF_CHROMA: section(5),
  TRANSFORM_SKIP: section(2),
  CU_QP_DELTA: section(2),
  LAST_SIG_X: section(18),
  LAST_SIG_Y: section(18),
  CODED_SUB_BLOCK: section(4),
  SIG_COEFF: section(42),
  GREATER1: section(24),
  GREATER2: section(6),
} as const

export const NUM_CTX = n

/**
 * initValue per context for I slices (initType 0), concatenated in the CTX
 * layout order above. Sources: H.265 Tables 9-5..9-32 / HM INIT_* row 0.
 */
const INIT_VALUES_I = new Uint8Array([
  // SAO_MERGE, SAO_TYPE_IDX
  153, 200,
  // SPLIT_CU
  139, 141, 157,
  // TQ_BYPASS, PART_MODE, PREV_INTRA_LUMA_PRED, INTRA_CHROMA_PRED_MODE
  154, 184, 184, 63,
  // SPLIT_TRANSFORM
  153, 138, 138,
  // CBF_LUMA
  111, 141,
  // CBF_CHROMA (5th entry is the RExt filler)
  94, 138, 182, 154, 154,
  // TRANSFORM_SKIP (luma, chroma)
  139, 139,
  // CU_QP_DELTA
  154, 154,
  // LAST_SIG_X (15 luma + 3 chroma)
  110, 110, 124, 125, 140, 153, 125, 127, 140, 109, 111, 143, 127, 111, 79, 108, 123, 63,
  // LAST_SIG_Y
  110, 110, 124, 125, 140, 153, 125, 127, 140, 109, 111, 143, 127, 111, 79, 108, 123, 63,
  // CODED_SUB_BLOCK (2 luma + 2 chroma)
  91, 171, 134, 141,
  // SIG_COEFF (27 luma + 15 chroma)
  111, 111, 125, 110, 110, 94, 124, 108, 124, 107, 125, 141, 179, 153, 125, 107, 125,
  141, 179, 153, 125, 107, 125, 141, 179, 153, 125, 140, 139, 182, 182, 152, 136, 152,
  136, 153, 136, 139, 111, 136, 139, 111,
  // GREATER1 (16 luma + 8 chroma)
  140, 92, 137, 138, 140, 152, 138, 139, 153, 74, 149, 92, 139, 107, 122, 152,
  140, 179, 166, 182, 140, 227, 122, 197,
  // GREATER2 (4 luma + 2 chroma)
  138, 153, 136, 167, 152, 152,
])

/** CABAC context state: probability index + MPS per context. */
export class CabacContexts {
  pState: Uint8Array
  valMps: Uint8Array

  constructor() {
    this.pState = new Uint8Array(NUM_CTX)
    this.valMps = new Uint8Array(NUM_CTX)
  }

  /** 9.3.2.2 initialization from initValue at the slice QP. */
  init(sliceQpY: number): void {
    const qp = Math.min(51, Math.max(0, sliceQpY))
    for (let i = 0; i < NUM_CTX; i++) {
      const initValue = INIT_VALUES_I[i]
      const m = (initValue >> 4) * 5 - 45
      const nOff = ((initValue & 15) << 3) - 16
      let preCtxState = ((m * qp) >> 4) + nOff
      preCtxState = Math.min(126, Math.max(1, preCtxState))
      if (preCtxState <= 63) {
        this.valMps[i] = 0
        this.pState[i] = 63 - preCtxState
      }
      else {
        this.valMps[i] = 1
        this.pState[i] = preCtxState - 64
      }
    }
  }

  /** Snapshot for WPP row synchronization. */
  save(): { pState: Uint8Array, valMps: Uint8Array } {
    return { pState: this.pState.slice(), valMps: this.valMps.slice() }
  }

  restore(snapshot: { pState: Uint8Array, valMps: Uint8Array }): void {
    this.pState.set(snapshot.pState)
    this.valMps.set(snapshot.valMps)
  }
}

/**
 * The binary arithmetic decoding engine (9.3.4.3), reading one byte-aligned
 * substream. Context state lives in a shared CabacContexts so WPP rows can
 * hand state across engines.
 */
export class CabacDecoder {
  private data: Uint8Array
  private bytePos = 0
  private bitsLeft = 0
  private cache = 0
  private range = 510
  private offset = 0

  constructor(data: Uint8Array, public ctx: CabacContexts) {
    this.data = data
    this.offset = this.readBits(9)
  }

  private readBit(): number {
    if (this.bitsLeft === 0) {
      // Past the end, feed zeros (only reachable on the final alignment bits).
      this.cache = this.bytePos < this.data.length ? this.data[this.bytePos++] : 0
      this.bitsLeft = 8
    }
    this.bitsLeft--
    return (this.cache >> this.bitsLeft) & 1
  }

  private readBits(count: number): number {
    let v = 0
    for (let i = 0; i < count; i++)
      v = (v << 1) | this.readBit()
    return v
  }

  /** 9.3.4.3.2 DecodeDecision. */
  decodeBin(ctxIdx: number): number {
    const pState = this.ctx.pState[ctxIdx]
    const lpsRange = RANGE_TAB_LPS[(pState << 2) | ((this.range >> 6) & 3)]
    this.range -= lpsRange

    let bin: number
    if (this.offset >= this.range) {
      // LPS path
      bin = 1 - this.ctx.valMps[ctxIdx]
      this.offset -= this.range
      this.range = lpsRange
      if (pState === 0)
        this.ctx.valMps[ctxIdx] = 1 - this.ctx.valMps[ctxIdx]
      this.ctx.pState[ctxIdx] = TRANS_IDX_LPS[pState]
    }
    else {
      // MPS path
      bin = this.ctx.valMps[ctxIdx]
      if (pState < 62)
        this.ctx.pState[ctxIdx] = pState + 1
    }

    while (this.range < 256) {
      this.range <<= 1
      this.offset = (this.offset << 1) | this.readBit()
    }
    return bin
  }

  /** 9.3.4.3.4 DecodeBypass. */
  decodeBypass(): number {
    this.offset = (this.offset << 1) | this.readBit()
    if (this.offset >= this.range) {
      this.offset -= this.range
      return 1
    }
    return 0
  }

  decodeBypassBits(count: number): number {
    let v = 0
    for (let i = 0; i < count; i++)
      v = (v << 1) | this.decodeBypass()
    return v
  }

  /** 9.3.4.3.5 DecodeTerminate (end_of_slice / end_of_subset). */
  decodeTerminate(): number {
    this.range -= 2
    if (this.offset >= this.range)
      return 1
    while (this.range < 256) {
      this.range <<= 1
      this.offset = (this.offset << 1) | this.readBit()
    }
    return 0
  }
}
