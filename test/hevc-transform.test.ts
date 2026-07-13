import { describe, expect, it } from 'bun:test'
import { getScan, SCAN_DIAG, SCAN_HORIZ, SCAN_VERT } from '../src/hevc/scan'
import { dequantize, DST4, getDctMatrix, inverseTransform } from '../src/hevc/transform'

describe('DCT matrix generation', () => {
  it('reproduces the canonical 4x4 matrix', () => {
    expect(Array.from(getDctMatrix(4))).toEqual([
      64, 64, 64, 64,
      83, 36, -36, -83,
      64, -64, -64, 64,
      36, -83, 83, -36,
    ])
  })

  it('reproduces canonical 8x8 rows', () => {
    const t = getDctMatrix(8)
    expect(Array.from(t.slice(8, 16))).toEqual([89, 75, 50, 18, -18, -50, -75, -89])
    expect(Array.from(t.slice(24, 32))).toEqual([75, -18, -89, -50, 50, 89, 18, -75])
    expect(Array.from(t.slice(56, 64))).toEqual([18, -50, 75, -89, 89, -75, 50, -18])
  })

  it('spot-checks the 16 and 32 point matrices', () => {
    const t16 = getDctMatrix(16)
    expect(t16[16 * 1 + 0]).toBe(90)
    expect(t16[16 * 15 + 0]).toBe(9)
    expect(t16[16 * 8 + 0]).toBe(64) // row 8 = T2 row 0 stretched
    const t32 = getDctMatrix(32)
    expect(t32[32 * 1 + 0]).toBe(90)
    expect(t32[32 * 31 + 0]).toBe(4)
    expect(t32[32 * 16 + 0]).toBe(64)
    expect(t32[32 * 2 + 0]).toBe(90) // row 2 = T16 row 1
    // Every row of an even/odd-symmetric transform sums consistently: row 0 only.
    for (let k = 1; k < 32; k++) {
      let sum = 0
      for (let x = 0; x < 32; x++) sum += t32[k * 32 + x]
      expect(Math.abs(sum)).toBeLessThan(70) // AC rows nearly cancel
    }
  })

  it('rows are near-orthogonal at the integer scale', () => {
    for (const size of [4, 8, 16, 32]) {
      const t = getDctMatrix(size)
      const s = 64 * 64 * size
      for (let a = 0; a < size; a++) {
        for (let b = 0; b < size; b++) {
          let dot = 0
          for (let x = 0; x < size; x++) dot += t[a * size + x] * t[b * size + x]
          if (a === b)
            expect(Math.abs(dot - s) / s).toBeLessThan(0.02)
          else
            expect(Math.abs(dot) / s).toBeLessThan(0.02)
        }
      }
    }
  })
})

describe('inverse transform', () => {
  it('turns a lone DC coefficient into a flat block', () => {
    for (const size of [4, 8, 16, 32]) {
      const coeffs = new Int32Array(size * size)
      coeffs[0] = 256
      const out = inverseTransform(coeffs, size, 8, false)
      // (256+1)>>1 = 128 after pass 1; (64*128 + 2048) >> 12 = 2 after pass 2.
      for (const v of out)
        expect(v).toBe(2)
    }
  })

  it('matches the ideal float inverse DCT within integer rounding', () => {
    // T ~ 64*sqrt(N) * orthonormal DCT, so b = T'CT >> 19 ~ (N/128) * IDCT(C).
    let seed = 12345
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
      return (seed % 201) - 100
    }
    for (const size of [4, 8, 16, 32]) {
      const coeffs = new Int32Array(size * size)
      for (let i = 0; i < size * size; i++) coeffs[i] = rand()
      const out = inverseTransform(coeffs, size, 8, false)

      // Float reference: orthonormal IDCT-II.
      const d = (k: number, n: number) =>
        Math.sqrt((k === 0 ? 1 : 2) / size) * Math.cos((Math.PI * k * (2 * n + 1)) / (2 * size))
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          let v = 0
          for (let ky = 0; ky < size; ky++) {
            for (let kx = 0; kx < size; kx++)
              v += coeffs[ky * size + kx] * d(ky, y) * d(kx, x)
          }
          const expected = (size / 128) * v
          expect(Math.abs(out[y * size + x] - expected)).toBeLessThanOrEqual(2)
        }
      }
    }
  })

  it('matches the ideal float inverse DST for 4x4 luma blocks', () => {
    const coeffs = new Int32Array([64, -30, 12, 5, 22, 0, -8, 3, -17, 9, 4, -2, 6, -5, 1, 0])
    const out = inverseTransform(coeffs, 4, 8, true)
    const s = (k: number, n: number) =>
      (2 / 3) * Math.sin((Math.PI * (2 * n + 1) * (k + 1)) / 9)
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        let v = 0
        for (let ky = 0; ky < 4; ky++) {
          for (let kx = 0; kx < 4; kx++)
            v += coeffs[ky * 4 + kx] * s(ky, y) * s(kx, x)
        }
        // DST4 ~ 128 * orthonormal DST-VII rows -> same 4/128 scale as DCT4.
        const expected = (4 / 128) * v
        expect(Math.abs(out[y * 4 + x] - expected)).toBeLessThanOrEqual(2)
      }
    }
  })

  it('DST4 matrix rows are near-orthogonal', () => {
    const s = 128 * 128
    for (let a = 0; a < 4; a++) {
      for (let b = 0; b < 4; b++) {
        let dot = 0
        for (let x = 0; x < 4; x++) dot += DST4[a * 4 + x] * DST4[b * 4 + x]
        if (a === b)
          expect(Math.abs(dot - s) / s).toBeLessThan(0.05)
        else
          expect(Math.abs(dot) / s).toBeLessThan(0.05)
      }
    }
  })
})

describe('dequantize', () => {
  it('applies levelScale and the bit-depth shift', () => {
    const levels = new Int32Array(64)
    levels[0] = 1
    levels[9] = -3
    // qp 16: per = 2, rem = 4 -> levelScale 64. 8x8 at 8-bit: bdShift = 6.
    const out = dequantize(levels, 8, 16, 8, null)
    expect(out[0]).toBe(Math.floor((1 * 16 * 64 * 4 + 32) / 64)) // 64
    expect(out[9]).toBe(Math.floor((-3 * 16 * 64 * 4 + 32) / 64)) // -191
  })

  it('honors scaling factors per coefficient', () => {
    const levels = new Int32Array(16).fill(10)
    const factors = new Int32Array(16).fill(16)
    factors[5] = 32
    const flat = dequantize(levels, 4, 20, 8, null)
    const scaled = dequantize(levels, 4, 20, 8, factors)
    expect(scaled[0]).toBe(flat[0])
    expect(scaled[5]).toBeGreaterThan(flat[5] * 2 - 2)
  })
})

describe('scan orders', () => {
  it('generates the spec up-right diagonal 4x4 scan', () => {
    const scan = getScan(SCAN_DIAG, 4)
    const coords = Array.from(scan).map(p => [p % 4, p >> 2])
    expect(coords.slice(0, 6)).toEqual([[0, 0], [0, 1], [1, 0], [0, 2], [1, 1], [2, 0]])
    expect(coords[15]).toEqual([3, 3])
  })

  it('horizontal and vertical scans cover all positions', () => {
    for (const idx of [SCAN_HORIZ, SCAN_VERT]) {
      const scan = getScan(idx, 8)
      expect(new Set(Array.from(scan)).size).toBe(64)
    }
    expect(getScan(SCAN_VERT, 4)[1]).toBe(4) // (0,1) comes second column-wise
    expect(getScan(SCAN_HORIZ, 4)[1]).toBe(1)
  })
})
