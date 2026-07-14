/**
 * In-loop deblocking filter (8.7.2) for intra pictures.
 *
 * For an I-slice every transform/prediction-block edge on the 8x8 sample grid
 * has boundary strength 2, so the decoder's recorded TU edges (which for intra
 * are a superset of the PU/CU edges) drive the filter directly. Vertical edges
 * are filtered across the whole plane first, then horizontal edges read the
 * vertically-filtered samples, exactly as the spec orders them.
 */
import type { DecodedPicture } from './picture'
import type { PpsInfo } from './pps'

/** Table 8-23 beta' by Q. */
const BETA_TABLE = new Int32Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 7, 8,
  9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36,
  38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60, 62, 64,
])

/** Table 8-23 tC' by Q. */
const TC_TABLE = new Int32Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4,
  5, 5, 6, 6, 7, 8, 9, 10, 11, 13, 14, 16, 18, 20, 22, 24,
])

/** Table 8-10 chroma QP mapping (4:2:0). */
const TAB8_22 = [29, 30, 31, 32, 33, 33, 34, 34, 35, 35, 36, 36, 37, 37]
function table8_22(qPi: number): number {
  if (qPi < 30)
    return qPi
  if (qPi >= 43)
    return qPi - 6
  return TAB8_22[qPi - 30]
}

function clip3(lo: number, hi: number, v: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Apply the deblocking filter to a decoded picture, in place. */
export function deblockPicture(pic: DecodedPicture, pps: PpsInfo, bitDepth = 8): void {
  if (pic.sh.deblockingDisabled)
    return

  const betaOffset = pic.sh.betaOffsetDiv2 * 2
  const tcOffset = pic.sh.tcOffsetDiv2 * 2
  const shift = bitDepth - 8
  const maxVal = (1 << bitDepth) - 1

  const { y, cb, cr, width, height, tuEdgesY, qpMap } = pic
  const bwY = width >> 2
  const qw = width >> 3
  const clip = (v: number): number => v < 0 ? 0 : v > maxVal ? maxVal : v
  const qpAt = (px: number, py: number): number => qpMap[(py >> 3) * qw + (px >> 3)]

  // --- luma, both passes ---
  for (let pass = 0; pass < 2; pass++) {
    const vertical = pass === 0
    // Vertical edges step x by 8 (skip picture left border), y by 4.
    // Horizontal edges step y by 8 (skip top border), x by 4.
    const xStart = vertical ? 8 : 0
    const yStart = vertical ? 0 : 8
    const xStep = vertical ? 8 : 4
    const yStep = vertical ? 4 : 8

    for (let ey = yStart; ey < height; ey += yStep) {
      for (let ex = xStart; ex < width; ex += xStep) {
        const edgeBlock = tuEdgesY[(ey >> 2) * bwY + (ex >> 2)]
        if (vertical ? !(edgeBlock & 1) : !(edgeBlock & 2))
          continue

        const qpQ = qpAt(ex, ey)
        const qpP = vertical ? qpAt(ex - 1, ey) : qpAt(ex, ey - 1)
        const qpL = (qpQ + qpP + 1) >> 1
        const beta = BETA_TABLE[clip3(0, 51, qpL + betaOffset)] << shift
        const tc = TC_TABLE[clip3(0, 53, qpL + 2 + tcOffset)] << shift
        if (beta === 0)
          continue

        // Sample accessors: p is the decreasing side, q the increasing side.
        const p = (k: number, i: number): number =>
        vertical ? y[(ey + k) * width + (ex - 1 - i)] : y[(ey - 1 - i) * width + (ex + k)]
        const q = (k: number, i: number): number =>
        vertical ? y[(ey + k) * width + (ex + i)] : y[(ey + i) * width + (ex + k)]

        const dp0 = Math.abs(p(0, 2) - 2 * p(0, 1) + p(0, 0))
        const dp3 = Math.abs(p(3, 2) - 2 * p(3, 1) + p(3, 0))
        const dq0 = Math.abs(q(0, 2) - 2 * q(0, 1) + q(0, 0))
        const dq3 = Math.abs(q(3, 2) - 2 * q(3, 1) + q(3, 0))
        const dpq0 = dp0 + dq0
        const dpq3 = dp3 + dq3
        const d = dpq0 + dpq3
        if (d >= beta)
          continue

        const dp = dp0 + dp3
        const dq = dq0 + dq3
        const dSam0 = 2 * dpq0 < (beta >> 2)
          && Math.abs(p(0, 3) - p(0, 0)) + Math.abs(q(0, 0) - q(0, 3)) < (beta >> 3)
          && Math.abs(p(0, 0) - q(0, 0)) < ((5 * tc + 1) >> 1)
        const dSam3 = 2 * dpq3 < (beta >> 2)
          && Math.abs(p(3, 3) - p(3, 0)) + Math.abs(q(3, 0) - q(3, 3)) < (beta >> 3)
          && Math.abs(p(3, 0) - q(3, 0)) < ((5 * tc + 1) >> 1)
        const dE = dSam0 && dSam3 ? 2 : 1
        const dEp = dp < ((beta + (beta >> 1)) >> 3) ? 1 : 0
        const dEq = dq < ((beta + (beta >> 1)) >> 3) ? 1 : 0

        const setP = (k: number, i: number, v: number): void => {
          if (vertical)
            y[(ey + k) * width + (ex - 1 - i)] = v
          else
            y[(ey - 1 - i) * width + (ex + k)] = v
        }
        const setQ = (k: number, i: number, v: number): void => {
          if (vertical)
            y[(ey + k) * width + (ex + i)] = v
          else
            y[(ey + i) * width + (ex + k)] = v
        }

        for (let k = 0; k < 4; k++) {
          const p0 = p(k, 0)
          const p1 = p(k, 1)
          const p2 = p(k, 2)
          const p3 = p(k, 3)
          const q0 = q(k, 0)
          const q1 = q(k, 1)
          const q2 = q(k, 2)
          const q3 = q(k, 3)

          if (dE === 2) {
            setP(k, 0, clip3(p0 - 2 * tc, p0 + 2 * tc, (p2 + 2 * p1 + 2 * p0 + 2 * q0 + q1 + 4) >> 3))
            setP(k, 1, clip3(p1 - 2 * tc, p1 + 2 * tc, (p2 + p1 + p0 + q0 + 2) >> 2))
            setP(k, 2, clip3(p2 - 2 * tc, p2 + 2 * tc, (2 * p3 + 3 * p2 + p1 + p0 + q0 + 4) >> 3))
            setQ(k, 0, clip3(q0 - 2 * tc, q0 + 2 * tc, (p1 + 2 * p0 + 2 * q0 + 2 * q1 + q2 + 4) >> 3))
            setQ(k, 1, clip3(q1 - 2 * tc, q1 + 2 * tc, (p0 + q0 + q1 + q2 + 2) >> 2))
            setQ(k, 2, clip3(q2 - 2 * tc, q2 + 2 * tc, (p0 + q0 + q1 + 3 * q2 + 2 * q3 + 4) >> 3))
          }
          else {
            let delta = (9 * (q0 - p0) - 3 * (q1 - p1) + 8) >> 4
            if (Math.abs(delta) < tc * 10) {
              delta = clip3(-tc, tc, delta)
              setP(k, 0, clip(p0 + delta))
              setQ(k, 0, clip(q0 - delta))
              if (dEp === 1) {
                const dp2 = clip3(-(tc >> 1), tc >> 1, (((p2 + p0 + 1) >> 1) - p1 + delta) >> 1)
                setP(k, 1, clip(p1 + dp2))
              }
              if (dEq === 1) {
                const dq2 = clip3(-(tc >> 1), tc >> 1, (((q2 + q0 + 1) >> 1) - q1 - delta) >> 1)
                setQ(k, 1, clip(q1 + dq2))
              }
            }
          }
        }
      }
    }
  }

  // --- chroma, both passes (bS == 2 only, one weak filter per edge) ---
  const cw = width >> 1
  const ch = height >> 1
  const cMax = (1 << bitDepth) - 1
  const clipC = (v: number): number => v < 0 ? 0 : v > cMax ? cMax : v

  for (let pass = 0; pass < 2; pass++) {
    const vertical = pass === 0
    const plane = [cb, cr]
    const offsets = [pps.cbQpOffset, pps.crQpOffset]

    // Chroma edges lie on the 8-chroma-sample grid (= 16 luma).
    const cxStart = vertical ? 8 : 0
    const cyStart = vertical ? 0 : 8
    const cxStep = vertical ? 8 : 4
    const cyStep = vertical ? 4 : 8

    for (let cy = cyStart; cy < ch; cy += cyStep) {
      for (let cx = cxStart; cx < cw; cx += cxStep) {
        const lx = cx << 1
        const ly = cy << 1
        const edgeBlock = tuEdgesY[(ly >> 2) * bwY + (lx >> 2)]
        if (vertical ? !(edgeBlock & 1) : !(edgeBlock & 2))
          continue

        const qpQ = qpAt(lx, ly)
        const qpP = vertical ? qpAt(lx - 1, ly) : qpAt(lx, ly - 1)
        const qpAvg = (qpQ + qpP + 1) >> 1

        for (let c = 0; c < 2; c++) {
          const cPlane = plane[c]
          const qpC = table8_22(qpAvg + offsets[c])
          const tc = TC_TABLE[clip3(0, 53, qpC + 2 + tcOffset)] << shift
          if (tc === 0)
            continue

          for (let k = 0; k < 4; k++) {
            // p1 p0 | q0 q1 straddling the edge; k walks along it.
            const iP0 = vertical ? (cy + k) * cw + (cx - 1) : (cy - 1) * cw + (cx + k)
            const iP1 = vertical ? (cy + k) * cw + (cx - 2) : (cy - 2) * cw + (cx + k)
            const iQ0 = vertical ? (cy + k) * cw + cx : cy * cw + (cx + k)
            const iQ1 = vertical ? (cy + k) * cw + (cx + 1) : (cy + 1) * cw + (cx + k)
            const p0 = cPlane[iP0]
            const p1 = cPlane[iP1]
            const q0 = cPlane[iQ0]
            const q1 = cPlane[iQ1]
            const delta = clip3(-tc, tc, (((q0 - p0) * 4) + p1 - q1 + 4) >> 3)
            cPlane[iP0] = clipC(p0 + delta)
            cPlane[iQ0] = clipC(q0 - delta)
          }
        }
      }
    }
  }
}
