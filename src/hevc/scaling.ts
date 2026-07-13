/**
 * Scaling lists (7.3.4, 7.4.5, 8.6.3). iPhone captures enable
 * sps_scaling_list_enabled_flag without shipping explicit data, which selects
 * the DEFAULT lists — the JPEG-like quantization matrices below — so dequant
 * must honor them, not the flat 16s.
 */
import type { BitReader } from './nal'
import { getScan, SCAN_DIAG } from './scan'

/** lists[sizeId][matrixId] is a raster-order size x size matrix. */
export interface ScalingListData {
  lists: Int32Array[][]
  /** dc[sizeId - 2][matrixId], sizeId 2 (16x16) and 3 (32x32). */
  dc: number[][]
}

/** Default 8x8 intra scaling matrix (Table 7-6), raster order (symmetric). */
const DEFAULT_INTRA_8X8 = new Int32Array([
  16, 16, 16, 16, 17, 18, 21, 24,
  16, 16, 16, 16, 17, 19, 22, 25,
  16, 16, 17, 18, 20, 22, 25, 29,
  16, 16, 18, 21, 24, 27, 31, 36,
  17, 17, 20, 24, 30, 35, 41, 47,
  18, 19, 22, 27, 35, 44, 54, 65,
  21, 22, 25, 31, 41, 54, 70, 88,
  24, 25, 29, 36, 47, 65, 88, 115,
])

/** Default 8x8 inter scaling matrix (Table 7-6), raster order (symmetric). */
const DEFAULT_INTER_8X8 = new Int32Array([
  16, 16, 16, 16, 17, 18, 20, 24,
  16, 16, 16, 17, 18, 20, 24, 25,
  16, 16, 17, 18, 20, 24, 25, 28,
  16, 17, 18, 20, 24, 25, 28, 33,
  17, 18, 20, 24, 25, 28, 33, 41,
  18, 20, 24, 25, 28, 33, 41, 54,
  20, 24, 25, 28, 33, 41, 54, 71,
  24, 25, 28, 33, 41, 54, 71, 91,
])

function defaultList(sizeId: number, matrixId: number): Int32Array {
  if (sizeId === 0)
    return new Int32Array(16).fill(16)
  return (matrixId < 3 ? DEFAULT_INTRA_8X8 : DEFAULT_INTER_8X8).slice()
}

/**
 * Parse scaling_list_data() from an SPS or PPS. Coefficients arrive in
 * up-right diagonal scan order and are stored raster-order.
 */
export function parseScalingListData(r: BitReader): ScalingListData {
  const lists: Int32Array[][] = []
  const dc: number[][] = [
    [16, 16, 16, 16, 16, 16],
    [16, 16, 16, 16, 16, 16],
  ]

  for (let sizeId = 0; sizeId < 4; sizeId++) {
    lists[sizeId] = []
    for (let matrixId = 0; matrixId < 6; matrixId += (sizeId === 3 ? 3 : 1)) {
      const predMode = r.readBit()
      if (predMode === 0) {
        const delta = r.ue() // scaling_list_pred_matrix_id_delta
        if (delta === 0) {
          lists[sizeId][matrixId] = defaultList(sizeId, matrixId)
        }
        else {
          const refId = matrixId - delta * (sizeId === 3 ? 3 : 1)
          lists[sizeId][matrixId] = lists[sizeId][refId].slice()
          if (sizeId >= 2)
            dc[sizeId - 2][matrixId] = dc[sizeId - 2][refId]
        }
      }
      else {
        const coefNum = Math.min(64, 1 << (4 + (sizeId << 1)))
        const size = sizeId === 0 ? 4 : 8
        const scan = getScan(SCAN_DIAG, size)
        let nextCoef = 8
        if (sizeId > 1) {
          nextCoef = r.se() + 8 // scaling_list_dc_coef_minus8
          dc[sizeId - 2][matrixId] = nextCoef
        }
        const list = new Int32Array(size * size)
        for (let i = 0; i < coefNum; i++) {
          nextCoef = (nextCoef + r.se() + 256) % 256
          list[scan[i]] = nextCoef
        }
        lists[sizeId][matrixId] = list
      }
    }
  }
  return { lists, dc }
}

/** The default scaling list data used when the SPS enables lists sans data. */
export function defaultScalingListData(): ScalingListData {
  const lists: Int32Array[][] = []
  const dc: number[][] = [
    [16, 16, 16, 16, 16, 16],
    [16, 16, 16, 16, 16, 16],
  ]
  for (let sizeId = 0; sizeId < 4; sizeId++) {
    lists[sizeId] = []
    for (let matrixId = 0; matrixId < 6; matrixId += (sizeId === 3 ? 3 : 1))
      lists[sizeId][matrixId] = defaultList(sizeId, matrixId)
  }
  return { lists, dc }
}

/**
 * Build the size x size ScalingFactor matrix (8.6.3) for a transform block.
 * sizeId: log2TrafoSize - 2. matrixId: 0-2 intra Y/Cb/Cr, 3-5 inter.
 */
export function buildScalingFactors(data: ScalingListData, sizeId: number, matrixId: number): Int32Array {
  const size = 4 << sizeId
  const out = new Int32Array(size * size)
  const list = data.lists[sizeId][sizeId === 3 ? (matrixId >= 3 ? 3 : 0) : matrixId]
  if (sizeId <= 1) {
    out.set(list)
    return out
  }
  const listSize = 8
  const shift = sizeId - 1 // 16x16: each entry covers 2x2; 32x32: 4x4
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++)
      out[y * size + x] = list[(y >> shift) * listSize + (x >> shift)]
  }
  out[0] = data.dc[sizeId - 2][sizeId === 3 ? (matrixId >= 3 ? 3 : 0) : matrixId]
  return out
}
