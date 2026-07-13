import { describe, expect, it } from 'bun:test'
import { NalType, splitAnnexB } from '../src/hevc/nal'

describe('splitAnnexB', () => {
  it('splits mixed three-byte and four-byte start codes', () => {
    const stream = new Uint8Array([
      0, 0, 0, 1,
      NalType.VPS << 1, 1, 0xAA,
      0, 0, 1,
      NalType.SPS << 1, 1, 0xBB,
    ])

    const nals = splitAnnexB(stream)
    expect(nals.map(nal => nal.type)).toEqual([NalType.VPS, NalType.SPS])
    expect(Array.from(nals[0].data)).toEqual([NalType.VPS << 1, 1, 0xAA])
    expect(Array.from(nals[1].data)).toEqual([NalType.SPS << 1, 1, 0xBB])
  })

  it('does not attach a four-byte prefix to the preceding NAL', () => {
    const stream = new Uint8Array([
      0, 0, 1,
      NalType.SPS << 1, 1, 0xCC,
      0, 0, 0, 1,
      NalType.PPS << 1, 1, 0xDD,
      0, 0,
    ])

    const nals = splitAnnexB(stream)
    expect(Array.from(nals[0].data)).toEqual([NalType.SPS << 1, 1, 0xCC])
    expect(Array.from(nals[1].data)).toEqual([NalType.PPS << 1, 1, 0xDD])
  })

  it('ignores empty units and data before the first start code', () => {
    const stream = new Uint8Array([
      0xFF,
      0, 0, 1,
      0, 0, 1,
      NalType.IDR_W_RADL << 1, 1, 0xEE,
    ])

    const nals = splitAnnexB(stream)
    expect(nals).toHaveLength(1)
    expect(nals[0].type).toBe(NalType.IDR_W_RADL)
  })
})
