import { describe, expect, it } from 'bun:test'
import { getFtypInfo, parseISOBMFF, validateFtyp } from '../src/container/heif'
import { isHeic } from '../src/decoder'

function ftyp(majorBrand: string, compatibleBrands: string[] = []): Uint8Array {
  const out = new Uint8Array(16 + compatibleBrands.length * 4)
  const view = new DataView(out.buffer)
  view.setUint32(0, out.length)
  out.set(new TextEncoder().encode('ftyp'), 4)
  out.set(new TextEncoder().encode(majorBrand), 8)
  for (let i = 0; i < compatibleBrands.length; i++)
    out.set(new TextEncoder().encode(compatibleBrands[i]), 16 + i * 4)
  return out
}

describe('ftyp', () => {
  it('recognizes HEIC in either the major or compatible brands', () => {
    expect(isHeic(ftyp('heic'))).toBe(true)
    expect(isHeic(ftyp('mif1', ['heic', 'miaf']))).toBe(true)
  })

  it('does not treat a generic HEIF brand as HEIC by itself', () => {
    const generic = ftyp('mif1', ['miaf'])
    expect(validateFtyp(generic)).toBe(true)
    expect(isHeic(generic)).toBe(false)
  })

  it('rejects truncated and misaligned brand tables', () => {
    expect(getFtypInfo(new Uint8Array(12))).toBeNull()

    const truncated = ftyp('heic')
    new DataView(truncated.buffer).setUint32(0, truncated.length + 4)
    expect(validateFtyp(truncated)).toBe(false)

    const misaligned = new Uint8Array(18)
    misaligned.set(ftyp('heic'))
    new DataView(misaligned.buffer).setUint32(0, misaligned.length)
    expect(validateFtyp(misaligned)).toBe(false)
  })
})

describe('parseISOBMFF', () => {
  it('parses a header-only box', () => {
    const box = new Uint8Array(8)
    new DataView(box.buffer).setUint32(0, 8)
    box.set(new TextEncoder().encode('free'), 4)
    expect(parseISOBMFF(box)).toMatchObject([{ type: 'free', size: 8, offset: 0 }])
  })

  it('stops safely at malformed or truncated boxes', () => {
    const undersized = new Uint8Array(8)
    new DataView(undersized.buffer).setUint32(0, 4)
    expect(parseISOBMFF(undersized)).toEqual([])

    const truncatedLargeSize = new Uint8Array(12)
    new DataView(truncatedLargeSize.buffer).setUint32(0, 1)
    expect(parseISOBMFF(truncatedLargeSize)).toEqual([])
  })
})
