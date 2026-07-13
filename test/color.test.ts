import { describe, expect, it } from 'bun:test'
import { applyOrientation, yuv420ToRgba } from '../src/color'

describe('yuv420ToRgba', () => {
  it('uses ceil-divided chroma planes for odd image dimensions', () => {
    const y = new Uint8Array([
      10, 20, 30,
      40, 50, 60,
      70, 80, 90,
    ])
    const neutralChroma = new Uint8Array(4).fill(128)
    const rgba = yuv420ToRgba(y, neutralChroma, neutralChroma, 3, 3)

    for (let i = 0; i < y.length; i++)
      expect(Array.from(rgba.subarray(i * 4, i * 4 + 4))).toEqual([y[i], y[i], y[i], 255])
  })

  it('rejects invalid dimensions and undersized planes', () => {
    expect(() => yuv420ToRgba(new Uint8Array(), new Uint8Array(), new Uint8Array(), 0, 1)).toThrow(RangeError)
    expect(() => yuv420ToRgba(new Uint8Array(9), new Uint8Array(1), new Uint8Array(1), 3, 3)).toThrow(RangeError)
  })
})

describe('applyOrientation', () => {
  const pixels = new Uint8Array([
    1, 0, 0, 255,
    2, 0, 0, 255,
    3, 0, 0, 255,
    4, 0, 0, 255,
    5, 0, 0, 255,
    6, 0, 0, 255,
  ])

  it('normalizes negative quarter turns', () => {
    const negative = applyOrientation(pixels, 3, 2, -2, null)
    const positive = applyOrientation(pixels, 3, 2, 2, null)
    expect(negative).toEqual(positive)
    expect(Array.from(negative.data.filter((_, i) => i % 4 === 0))).toEqual([6, 5, 4, 3, 2, 1])
  })

  it('rejects invalid transforms and undersized buffers', () => {
    expect(() => applyOrientation(new Uint8Array(4), 2, 2, 0, null)).toThrow(RangeError)
    expect(() => applyOrientation(pixels, 3, 2, 0.5, null)).toThrow(RangeError)
    expect(() => applyOrientation(pixels, 3, 2, 0, 2)).toThrow(RangeError)
  })
})
