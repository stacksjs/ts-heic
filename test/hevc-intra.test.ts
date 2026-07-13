import type { IntraRefs } from '../src/hevc/intra'
import { describe, expect, it } from 'bun:test'
import { filterRefs, gatherRefs, INTRA_DC, INTRA_PLANAR, predictIntra } from '../src/hevc/intra'

function refsFrom(corner: number, left: number[], top: number[]): IntraRefs {
  return { corner, left: new Int32Array(left), top: new Int32Array(top) }
}

describe('gatherRefs substitution (8.4.4.2.2)', () => {
  const stride = 16
  const plane = new Uint8Array(stride * 16)
  for (let i = 0; i < plane.length; i++)
    plane[i] = (i * 7) & 0xFF

  it('fills mid-gray when nothing is available', () => {
    const refs = gatherRefs(plane, stride, 0, 0, 4, 8, () => false)
    expect(refs.corner).toBe(128)
    expect(Array.from(refs.left)).toEqual(Array.from({ length: 8 }, () => 128))
    expect(Array.from(refs.top)).toEqual(Array.from({ length: 8 }, () => 128))
  })

  it('reads real neighbors when available', () => {
    const refs = gatherRefs(plane, stride, 4, 4, 4, 8, (x, y) => y < 4 || x < 4)
    expect(refs.corner).toBe(plane[3 * stride + 3])
    expect(refs.top[0]).toBe(plane[3 * stride + 4])
    expect(refs.left[0]).toBe(plane[4 * stride + 3])
  })

  it('propagates from the bottom-left scan when partially available', () => {
    // Only the top row is available: left column takes the corner's value,
    // via the scan bottom-left -> corner -> top.
    const refs = gatherRefs(plane, stride, 4, 4, 4, 8, (_x, y) => y === 3)
    const corner = plane[3 * stride + 3]
    expect(refs.corner).toBe(corner)
    expect(Array.from(refs.left)).toEqual(Array.from({ length: 8 }, () => corner))
    expect(refs.top[2]).toBe(plane[3 * stride + 6])
    // Top extension beyond the picture edge copies the last real sample.
    expect(refs.top[7]).toBe(plane[3 * stride + 11])
  })
})

describe('reference filtering (8.4.4.2.3)', () => {
  it('applies [1 2 1] smoothing for planar at 8x8', () => {
    const left = Array.from({ length: 16 }, (_, i) => 10 + i * 4)
    const top = Array.from({ length: 16 }, (_, i) => 90 - i * 2)
    const refs = refsFrom(50, left, top)
    filterRefs(refs, 8, INTRA_PLANAR, 0, 8, false)
    // corner' = (left[0] + 2*corner + top[0] + 2) >> 2 = (10 + 100 + 90 + 2) >> 2
    expect(refs.corner).toBe(50)
    // left[0]' = (corner + 2*left[0] + left[1] + 2) >> 2 = (50 + 20 + 14 + 2) >> 2
    expect(refs.left[0]).toBe(21)
    // Last sample stays unfiltered.
    expect(refs.left[15]).toBe(10 + 15 * 4)
    expect(refs.top[15]).toBe(90 - 15 * 2)
  })

  it('skips filtering for DC, 4x4, chroma, and near-axis modes at 8x8', () => {
    for (const [size, mode, cIdx] of [[8, INTRA_DC, 0], [4, INTRA_PLANAR, 0], [8, INTRA_PLANAR, 1], [8, 25, 0]] as const) {
      const refs = refsFrom(0, Array.from({ length: size * 2 }, () => 100), Array.from({ length: size * 2 }, () => 200))
      filterRefs(refs, size, mode, cIdx, 8, false)
      expect(refs.corner).toBe(0) // untouched
    }
  })
})

describe('intra prediction modes', () => {
  it('DC: averages the two edges and smooths luma boundaries', () => {
    const refs = refsFrom(99, Array.from({ length: 8 }, () => 40), Array.from({ length: 8 }, () => 80))
    const out = predictIntra(refs, 4, INTRA_DC, 0, 8)
    const dc = 60
    expect(out[1 * 4 + 1]).toBe(dc)
    expect(out[0]).toBe((40 + 2 * dc + 80 + 2) >> 2) // corner sample
    expect(out[1]).toBe((80 + 3 * dc + 2) >> 2) // first row
    expect(out[4]).toBe((40 + 3 * dc + 2) >> 2) // first column
    // Chroma: no boundary smoothing.
    const chroma = predictIntra(refs, 4, INTRA_DC, 1, 8)
    expect(chroma[0]).toBe(dc)
  })

  it('planar: bilinear blend of the four references', () => {
    const left = [10, 20, 30, 40, 50, 60, 70, 80]
    const top = [200, 190, 180, 170, 160, 150, 140, 130]
    const refs = refsFrom(128, left, top)
    const out = predictIntra(refs, 4, INTRA_PLANAR, 0, 8)
    // pred[0][0] = (3*left[0] + 1*top[4] + 3*top[0] + 1*left[4] + 4) >> 3
    expect(out[0]).toBe((3 * 10 + 160 + 3 * 200 + 50 + 4) >> 3)
    // pred[3][3] = (0*left[3] + 4*top[4] + 0*top[3] + 4*left[4] + 4) >> 3
    expect(out[15]).toBe((4 * 160 + 4 * 50 + 4) >> 3)
  })

  it('vertical (26): copies the top row and filters the left edge for luma', () => {
    const left = [100, 110, 120, 130, 140, 150, 160, 170]
    const top = [50, 60, 70, 80, 90, 95, 96, 97]
    const refs = refsFrom(90, left, top)
    const out = predictIntra(refs, 4, 26, 0, 8)
    expect(out[1]).toBe(60)
    expect(out[2]).toBe(70)
    expect(out[1 * 4 + 3]).toBe(80)
    // Edge filter: pred[0][y] = clip(top[0] + ((left[y] - corner) >> 1))
    expect(out[0]).toBe(50 + ((100 - 90) >> 1))
    expect(out[3 * 4]).toBe(50 + ((130 - 90) >> 1))
    // Chroma skips the edge filter.
    const chroma = predictIntra(refs, 4, 26, 1, 8)
    expect(chroma[0]).toBe(50)
  })

  it('horizontal (10): copies the left column and filters the top edge', () => {
    const left = [100, 110, 120, 130, 140, 150, 160, 170]
    const top = [50, 60, 70, 80, 90, 95, 96, 97]
    const refs = refsFrom(90, left, top)
    const out = predictIntra(refs, 4, 10, 0, 8)
    expect(out[1 * 4 + 1]).toBe(110)
    expect(out[2 * 4 + 3]).toBe(120)
    // Edge filter row 0: clip(left[0] + ((top[x] - corner) >> 1))
    expect(out[1]).toBe(100 + ((60 - 90) >> 1))
  })

  it('mode 2 (diagonal from bottom-left): pred[x][y] = p[-1][x+y+1]', () => {
    const left = [10, 20, 30, 40, 50, 60, 70, 80]
    const top = Array.from({ length: 8 }, () => 0)
    const refs = refsFrom(0, left, top)
    const out = predictIntra(refs, 4, 2, 0, 8)
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++)
        expect(out[y * 4 + x]).toBe(left[x + y + 1])
    }
  })

  it('mode 34 (diagonal from top-right): pred[x][y] = p[x+y+1][-1]', () => {
    const top = [10, 20, 30, 40, 50, 60, 70, 80]
    const left = Array.from({ length: 8 }, () => 0)
    const refs = refsFrom(0, left, top)
    const out = predictIntra(refs, 4, 34, 0, 8)
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++)
        expect(out[y * 4 + x]).toBe(top[x + y + 1])
    }
  })

  it('negative-angle modes reach into the side reference via invAngle', () => {
    // Mode 18 (angle -32): pred[x][y] uses ref[x - y]; ref[-i] = left[i - 1].
    const left = [11, 22, 33, 44, 55, 66, 77, 88]
    const top = [111, 122, 133, 144, 155, 166, 177, 188]
    const refs = refsFrom(99, left, top)
    const out = predictIntra(refs, 4, 18, 0, 8)
    expect(out[0]).toBe(99) // ref[0] = corner
    expect(out[1]).toBe(111) // top[0]
    expect(out[1 * 4]).toBe(11) // left[0]
    expect(out[3 * 4]).toBe(33) // pred[0][3] = ref[-3] = left[2]
  })
})
