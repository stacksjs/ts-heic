/**
 * Inverse transforms and dequantization (8.6).
 *
 * The DCT matrices are generated rather than hardcoded: even rows of T_N are
 * rows of T_{N/2} mirrored per the DCT-II symmetry, and odd rows fold the
 * angle k*(2n+1) into the quarter-wave tables below — reproducing the exact
 * hand-tuned integer values of the spec (the tables ARE those values).
 */

/** Quarter-wave odd-row values for each transform size. */
const ODD4 = [83, 36]
const ODD8 = [89, 75, 50, 18]
const ODD16 = [90, 87, 80, 70, 57, 43, 25, 9]
const ODD32 = [90, 90, 88, 85, 82, 78, 73, 67, 61, 54, 46, 38, 31, 22, 13, 4]

function buildDctMatrix(size: number): Int32Array {
  if (size === 2)
    return new Int32Array([64, 64, 64, -64])

  const half = buildDctMatrix(size >> 1)
  const odd = size === 4 ? ODD4 : size === 8 ? ODD8 : size === 16 ? ODD16 : ODD32
  const out = new Int32Array(size * size)

  for (let k = 0; k < size >> 1; k++) {
    for (let n = 0; n < size >> 1; n++) {
      const v = half[k * (size >> 1) + n]
      out[2 * k * size + n] = v
      // DCT-II symmetry: T[r][N-1-n] = (-1)^r * T[r][n]; r = 2k is even.
      out[2 * k * size + (size - 1 - n)] = v
    }
  }
  for (let k = 0; 2 * k + 1 < size; k++) {
    const r = 2 * k + 1
    for (let n = 0; n < size; n++) {
      // Fold angle r*(2n+1) mod 4N into [0, N) with the cosine's sign.
      let m = (r * (2 * n + 1)) % (4 * size)
      let sign = 1
      if (m > 2 * size)
        m = 4 * size - m
      if (m > size) {
        sign = -1
        m = 2 * size - m
      }
      out[r * size + n] = sign * odd[(m - 1) >> 1]
    }
  }
  return out
}

const dctCache = new Map<number, Int32Array>()
export function getDctMatrix(size: number): Int32Array {
  let m = dctCache.get(size)
  if (!m) {
    m = buildDctMatrix(size)
    dctCache.set(size, m)
  }
  return m
}

/** The 4x4 DST-VII matrix used for intra luma 4x4 blocks. */
export const DST4 = new Int32Array([
  29, 55, 74, 84,
  74, 74, 0, -74,
  84, -29, -74, 55,
  55, -84, 74, -29,
])

function clip16(v: number): number {
  return v < -32768 ? -32768 : v > 32767 ? 32767 : v
}

/**
 * One inverse-transform pass: out = in^T x T, with rounding shift and 16-bit
 * clip. Applying it twice yields T^T x C x T (8.6.4.2).
 */
function inversePass(matrix: Int32Array, input: Int32Array, output: Int32Array, size: number, shift: number): void {
  const add = 1 << (shift - 1)
  for (let j = 0; j < size; j++) {
    for (let n = 0; n < size; n++) {
      let sum = 0
      for (let k = 0; k < size; k++)
        sum += matrix[k * size + n] * input[k * size + j]
      output[j * size + n] = clip16((sum + add) >> shift)
    }
  }
}

/**
 * Inverse 2D transform of a dequantized coefficient block (raster order,
 * frequency domain) into spatial residuals, in place semantics via return.
 * Uses DST-VII for 4x4 intra luma, DCT-II otherwise.
 */
export function inverseTransform(coeffs: Int32Array, size: number, bitDepth: number, useDst: boolean): Int32Array {
  const matrix = useDst ? DST4 : getDctMatrix(size)
  const tmp = new Int32Array(size * size)
  const out = new Int32Array(size * size)
  inversePass(matrix, coeffs, tmp, size, 7)
  inversePass(matrix, tmp, out, size, 20 - bitDepth)
  return out
}

const LEVEL_SCALE = [40, 45, 51, 57, 64, 72]

/**
 * Dequantize a coefficient block (8.6.3). `scalingFactors` is the m[x][y]
 * matrix (16s when scaling lists are disabled). Uses float64 arithmetic to
 * dodge 32-bit overflow; exact for all conformant magnitudes.
 */
export function dequantize(
  levels: Int32Array,
  size: number,
  qp: number,
  bitDepth: number,
  scalingFactors: Int32Array | null,
): Int32Array {
  const log2Size = 31 - Math.clz32(size)
  const bdShift = bitDepth + log2Size - 5
  const add = 1 << (bdShift - 1)
  const scale = LEVEL_SCALE[qp % 6] * 2 ** Math.floor(qp / 6)
  const out = new Int32Array(size * size)
  const div = 2 ** bdShift
  for (let i = 0; i < size * size; i++) {
    const level = levels[i]
    if (level === 0)
      continue
    const m = scalingFactors ? scalingFactors[i] : 16
    out[i] = clip16(Math.floor((level * m * scale + add) / div))
  }
  return out
}
