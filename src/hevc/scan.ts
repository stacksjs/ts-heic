/**
 * Coefficient scan orders (6.5.3-6.5.5): up-right diagonal, horizontal, and
 * vertical, generated for every block size the residual decoder touches.
 * Scans are stored as arrays of raster positions (y * size + x) indexed by
 * scan position.
 */

export const SCAN_DIAG = 0
export const SCAN_HORIZ = 1
export const SCAN_VERT = 2

/** Up-right diagonal scan order (6.5.3). */
function diagScan(size: number): Int32Array {
  const out = new Int32Array(size * size)
  let i = 0
  let x = 0
  let y = 0
  while (i < size * size) {
    while (y >= 0) {
      if (x < size && y < size)
        out[i++] = y * size + x
      y--
      x++
    }
    y = x
    x = 0
  }
  return out
}

function horizScan(size: number): Int32Array {
  const out = new Int32Array(size * size)
  for (let p = 0; p < size * size; p++)
    out[p] = p
  return out
}

function vertScan(size: number): Int32Array {
  const out = new Int32Array(size * size)
  let i = 0
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++)
      out[i++] = y * size + x
  }
  return out
}

/** scanOrder[scanIdx][log2Size] -> raster positions by scan position. */
const cache = new Map<number, Int32Array>()

export function getScan(scanIdx: number, size: number): Int32Array {
  const key = scanIdx * 64 + size
  const hit = cache.get(key)
  if (hit)
    return hit
  const scan = scanIdx === SCAN_HORIZ ? horizScan(size) : scanIdx === SCAN_VERT ? vertScan(size) : diagScan(size)
  cache.set(key, scan)
  return scan
}
