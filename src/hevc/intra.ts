/**
 * Intra prediction (8.4.4.2): reference-sample gathering with the spec's
 * substitution scan, [1 2 1] / strong bilinear smoothing, and the 35
 * prediction modes (planar, DC, 33 angular) including the luma boundary
 * filters for DC / pure-horizontal / pure-vertical.
 */

export const INTRA_PLANAR = 0
export const INTRA_DC = 1
export const INTRA_ANGULAR_HOR = 10
export const INTRA_ANGULAR_VER = 26

/** Table 8-5: intraPredAngle by mode (2..34). */
const PRED_ANGLE = [
  32, 26, 21, 17, 13, 9, 5, 2, 0, -2, -5, -9, -13, -17, -21, -26, -32,
  -26, -21, -17, -13, -9, -5, -2, 0, 2, 5, 9, 13, 17, 21, 26, 32,
]

/** Table 8-6: invAngle by mode (11..25). */
const INV_ANGLE = [
  -4096, -1638, -910, -630, -482, -390, -315, -256,
  -315, -390, -482, -630, -910, -1638, -4096,
]

export interface IntraRefs {
  /** left[y] = p[-1][y], y in 0..2N-1 */
  left: Int32Array
  /** top[x] = p[x][-1], x in 0..2N-1 */
  top: Int32Array
  /** p[-1][-1] */
  corner: number
}

/**
 * Gather and substitute reference samples (8.4.4.2.2). `available(px,py)`
 * answers whether the reconstructed sample at plane position (px,py) can be
 * referenced (inside the picture and already decoded).
 */
export function gatherRefs(
  plane: Uint8Array,
  stride: number,
  x0: number,
  y0: number,
  size: number,
  bitDepth: number,
  available: (px: number, py: number) => boolean,
): IntraRefs {
  const n2 = size * 2
  // Linear order = the substitution scan: bottom-left up the left column,
  // corner, then across the top row.
  const count = n2 * 2 + 1
  const vals = new Int32Array(count)
  const avail = new Uint8Array(count)

  for (let i = 0; i < n2; i++) {
    const py = y0 + n2 - 1 - i
    if (available(x0 - 1, py)) {
      vals[i] = plane[py * stride + x0 - 1]
      avail[i] = 1
    }
  }
  if (available(x0 - 1, y0 - 1)) {
    vals[n2] = plane[(y0 - 1) * stride + x0 - 1]
    avail[n2] = 1
  }
  for (let j = 0; j < n2; j++) {
    if (available(x0 + j, y0 - 1)) {
      vals[n2 + 1 + j] = plane[(y0 - 1) * stride + x0 + j]
      avail[n2 + 1 + j] = 1
    }
  }

  if (!avail[0]) {
    let first = -1
    for (let i = 1; i < count; i++) {
      if (avail[i]) {
        first = i
        break
      }
    }
    if (first === -1) {
      vals.fill(1 << (bitDepth - 1))
    }
    else {
      vals[0] = vals[first]
    }
    avail[0] = 1
  }
  for (let i = 1; i < count; i++) {
    if (!avail[i])
      vals[i] = vals[i - 1]
  }

  const left = new Int32Array(n2)
  const top = new Int32Array(n2)
  for (let y = 0; y < n2; y++)
    left[y] = vals[n2 - 1 - y]
  for (let x = 0; x < n2; x++)
    top[x] = vals[n2 + 1 + x]
  return { left, top, corner: vals[n2] }
}

/** Table 8-7 intraHorVerDistThres by nTbS. */
function filterThreshold(size: number): number {
  return size === 8 ? 7 : size === 16 ? 1 : 0
}

/** Reference smoothing (8.4.4.2.3); mutates refs in place when it applies. */
export function filterRefs(
  refs: IntraRefs,
  size: number,
  mode: number,
  cIdx: number,
  bitDepth: number,
  strongSmoothingEnabled: boolean,
): void {
  if (cIdx !== 0 || size === 4 || mode === INTRA_DC)
    return
  const minDist = Math.min(Math.abs(mode - 26), Math.abs(mode - 10))
  if (mode !== INTRA_PLANAR && minDist <= filterThreshold(size))
    return

  const { left, top, corner } = refs
  const n2 = size * 2

  if (strongSmoothingEnabled && size === 32) {
    const threshold = 1 << (bitDepth - 5)
    const flatTop = Math.abs(corner + top[n2 - 1] - 2 * top[size - 1]) < threshold
    const flatLeft = Math.abs(corner + left[n2 - 1] - 2 * left[size - 1]) < threshold
    if (flatTop && flatLeft) {
      const lastLeft = left[n2 - 1]
      const lastTop = top[n2 - 1]
      for (let y = 0; y < n2 - 1; y++)
        left[y] = ((n2 - 1 - y) * corner + (y + 1) * lastLeft + 32) >> 6
      for (let x = 0; x < n2 - 1; x++)
        top[x] = ((n2 - 1 - x) * corner + (x + 1) * lastTop + 32) >> 6
      return
    }
  }

  const fCorner = (left[0] + 2 * corner + top[0] + 2) >> 2
  const fLeft = new Int32Array(n2)
  const fTop = new Int32Array(n2)
  for (let y = 0; y < n2 - 1; y++)
    fLeft[y] = ((y === 0 ? corner : left[y - 1]) + 2 * left[y] + left[y + 1] + 2) >> 2
  fLeft[n2 - 1] = left[n2 - 1]
  for (let x = 0; x < n2 - 1; x++)
    fTop[x] = ((x === 0 ? corner : top[x - 1]) + 2 * top[x] + top[x + 1] + 2) >> 2
  fTop[n2 - 1] = top[n2 - 1]

  refs.left.set(fLeft)
  refs.top.set(fTop)
  refs.corner = fCorner
}

/**
 * Predict one intra block into a scratch buffer (raster order). References
 * must already be gathered/filtered.
 */
export function predictIntra(
  refs: IntraRefs,
  size: number,
  mode: number,
  cIdx: number,
  bitDepth: number,
): Int32Array {
  const out = new Int32Array(size * size)
  const { left, top, corner } = refs
  const maxVal = (1 << bitDepth) - 1
  const clip = (v: number): number => v < 0 ? 0 : v > maxVal ? maxVal : v

  if (mode === INTRA_PLANAR) {
    const log2 = 31 - Math.clz32(size)
    const tr = top[size] // p[N][-1]
    const bl = left[size] // p[-1][N]
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        out[y * size + x] = (
          (size - 1 - x) * left[y] + (x + 1) * tr
          + (size - 1 - y) * top[x] + (y + 1) * bl + size
        ) >> (log2 + 1)
      }
    }
    return out
  }

  if (mode === INTRA_DC) {
    const log2 = 31 - Math.clz32(size)
    let sum = size
    for (let i = 0; i < size; i++)
      sum += top[i] + left[i]
    const dc = sum >> (log2 + 1)
    out.fill(dc)
    if (cIdx === 0 && size < 32) {
      out[0] = (left[0] + 2 * dc + top[0] + 2) >> 2
      for (let x = 1; x < size; x++)
        out[x] = (top[x] + 3 * dc + 2) >> 2
      for (let y = 1; y < size; y++)
        out[y * size] = (left[y] + 3 * dc + 2) >> 2
    }
    return out
  }

  const angle = PRED_ANGLE[mode - 2]
  const vertical = mode >= 18

  // Build the 1-D reference array (8.4.4.2.6), indices -N..2N.
  const ref = new Int32Array(3 * size + 1)
  const base = size // ref index i lives at ref[base + i]
  const main = vertical ? top : left
  const side = vertical ? left : top

  ref[base] = corner
  for (let i = 1; i <= size; i++)
    ref[base + i] = main[i - 1]
  if (angle < 0) {
    const lower = (size * angle) >> 5
    if (lower < -1) {
      const invAngle = INV_ANGLE[mode - 11]
      for (let i = -1; i >= lower; i--) {
        const idx = ((i * invAngle + 128) >> 8) - 1
        ref[base + i] = idx < 0 ? corner : side[idx]
      }
    }
  }
  else {
    for (let i = size + 1; i <= 2 * size; i++)
      ref[base + i] = main[i - 1]
  }

  for (let k = 0; k < size; k++) {
    const pos = (k + 1) * angle
    const iIdx = pos >> 5
    const iFact = pos & 31
    for (let j = 0; j < size; j++) {
      const a = ref[base + j + iIdx + 1]
      const value = iFact === 0
        ? a
        : ((32 - iFact) * a + iFact * ref[base + j + iIdx + 2] + 16) >> 5
      // vertical: k walks rows (y = k, x = j); horizontal: transposed.
      if (vertical)
        out[k * size + j] = value
      else
        out[j * size + k] = value
    }
  }

  if (cIdx === 0 && size < 32) {
    if (mode === INTRA_ANGULAR_VER) {
      for (let y = 0; y < size; y++)
        out[y * size] = clip(top[0] + ((left[y] - corner) >> 1))
    }
    else if (mode === INTRA_ANGULAR_HOR) {
      for (let x = 0; x < size; x++)
        out[x] = clip(left[0] + ((top[x] - corner) >> 1))
    }
  }

  return out
}
