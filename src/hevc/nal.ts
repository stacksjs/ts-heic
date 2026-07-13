/**
 * HEVC (H.265) NAL unit handling: splitting item payloads, unescaping RBSP,
 * and reading NAL headers. This layer is complete; the slice decoder that
 * consumes it lives in ./decoder.
 */

export enum NalType {
  TRAIL_N = 0,
  TRAIL_R = 1,
  IDR_W_RADL = 19,
  IDR_N_LP = 20,
  CRA_NUT = 21,
  VPS = 32,
  SPS = 33,
  PPS = 34,
  AUD = 35,
  PREFIX_SEI = 39,
  SUFFIX_SEI = 40,
}

export interface NalUnit {
  type: NalType
  /** Full NAL payload including the 2-byte header. */
  data: Uint8Array
}

/** Whether the NAL type carries a coded slice (what a still image decodes). */
export function isSliceNal(type: number): boolean {
  return (type >= 0 && type <= 9) || (type >= 16 && type <= 21)
}

/**
 * Split a length-prefixed HEVC item payload (as stored in HEIF `mdat`,
 * prefix size from `hvcC.nalLengthSize`) into NAL units.
 */
export function splitLengthPrefixed(payload: Uint8Array, nalLengthSize: number): NalUnit[] {
  const nals: NalUnit[] = []
  let p = 0
  while (p + nalLengthSize <= payload.length) {
    let len = 0
    for (let i = 0; i < nalLengthSize; i++)
      len = (len << 8) | payload[p + i]
    p += nalLengthSize
    if (len <= 0 || p + len > payload.length)
      break
    const data = payload.subarray(p, p + len)
    nals.push({ type: (data[0] >> 1) & 0x3F, data })
    p += len
  }
  return nals
}

/** Split an Annex-B stream (00 00 01 start codes) into NAL units. */
export function splitAnnexB(stream: Uint8Array): NalUnit[] {
  const nals: NalUnit[] = []
  const starts: number[] = []
  for (let i = 0; i + 3 < stream.length; i++) {
    if (stream[i] === 0 && stream[i + 1] === 0
      && (stream[i + 2] === 1 || (stream[i + 2] === 0 && stream[i + 3] === 1))) {
      starts.push(i + (stream[i + 2] === 1 ? 3 : 4))
      i += 2
    }
  }
  for (let s = 0; s < starts.length; s++) {
    let end = s + 1 < starts.length ? starts[s + 1] : stream.length
    // trim the next start code from this NAL's tail
    while (end > starts[s] && stream[end - 1] === 0) end--
    if (s + 1 < starts.length)
      end = Math.min(end, starts[s + 1] - 3)
    const data = stream.subarray(starts[s], end)
    if (data.length >= 2)
      nals.push({ type: (data[0] >> 1) & 0x3F, data })
  }
  return nals
}

/**
 * Strip emulation-prevention bytes (00 00 03 → 00 00) from a NAL payload,
 * returning the raw byte sequence payload (RBSP) after the 2-byte header.
 */
export function toRbsp(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length - 2)
  let o = 0
  let zeros = 0
  for (let i = 2; i < nal.length; i++) {
    const b = nal[i]
    if (zeros >= 2 && b === 0x03) {
      zeros = 0
      continue // skip the emulation prevention byte
    }
    out[o++] = b
    zeros = b === 0 ? zeros + 1 : 0
  }
  return out.subarray(0, o)
}

/** MSB-first bit reader with Exp-Golomb support, used across the decoder. */
export class BitReader {
  private pos = 0
  constructor(private data: Uint8Array) {}

  readBit(): number {
    const byte = this.data[this.pos >> 3]
    const bit = (byte >> (7 - (this.pos & 7))) & 1
    this.pos++
    return bit
  }

  readBits(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++)
      v = (v << 1) | this.readBit()
    return v >>> 0
  }

  /** ue(v): unsigned Exp-Golomb. */
  ue(): number {
    let zeros = 0
    while (this.readBit() === 0 && zeros < 32) zeros++
    let v = (1 << zeros) - 1
    if (zeros > 0)
      v += this.readBits(zeros)
    return v
  }

  /** se(v): signed Exp-Golomb. */
  se(): number {
    const k = this.ue()
    return (k & 1) ? (k + 1) >> 1 : -(k >> 1)
  }

  get bitPosition(): number {
    return this.pos
  }
}
