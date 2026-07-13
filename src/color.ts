/**
 * YCbCr 4:2:0 to RGBA conversion. iPhone HEICs signal full-range BT.601
 * matrix coefficients in the VUI (matrix_coeffs 6, video_full_range 1);
 * BT.709 and limited range are supported for other encoders.
 */

export interface ColorOptions {
  /** VUI matrix_coeffs; 1 = BT.709, 5/6 = BT.601. Defaults to BT.601. */
  matrixCoeffs?: number
  fullRange?: boolean
}

function imagePixelCount(width: number, height: number): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
    throw new RangeError('ts-heic: image dimensions must be positive integers')

  const pixels = width * height
  if (!Number.isSafeInteger(pixels))
    throw new RangeError('ts-heic: image dimensions are too large')
  return pixels
}

/**
 * Convert planar YUV420 (chroma at half resolution, nearest-sample upsample)
 * into RGBA8888.
 */
export function yuv420ToRgba(
  y: Uint8Array,
  cb: Uint8Array,
  cr: Uint8Array,
  width: number,
  height: number,
  options: ColorOptions = {},
): Uint8Array {
  const pixels = imagePixelCount(width, height)
  const cw = Math.ceil(width / 2)
  const ch = Math.ceil(height / 2)
  if (y.length < pixels || cb.length < cw * ch || cr.length < cw * ch)
    throw new RangeError('ts-heic: YUV planes are smaller than the requested image dimensions')

  const matrix = options.matrixCoeffs ?? 6
  const fullRange = options.fullRange ?? true

  // Kr/Kb per matrix: BT.709 = 0.2126/0.0722, BT.601 = 0.299/0.114.
  const kr = matrix === 1 ? 0.2126 : 0.299
  const kb = matrix === 1 ? 0.0722 : 0.114
  const crR = 2 * (1 - kr)
  const cbB = 2 * (1 - kb)
  const crG = (2 * kr * (1 - kr)) / (1 - kr - kb)
  const cbG = (2 * kb * (1 - kb)) / (1 - kr - kb)

  // Limited range expands 16..235 (luma) / 16..240 (chroma) to 0..255.
  const yScale = fullRange ? 1 : 255 / 219
  const cScale = fullRange ? 1 : 255 / 224
  const yOffset = fullRange ? 0 : 16

  const out = new Uint8Array(pixels * 4)
  let o = 0
  for (let py = 0; py < height; py++) {
    const cRow = (py >> 1) * cw
    const yRow = py * width
    for (let px = 0; px < width; px++) {
      const lum = (y[yRow + px] - yOffset) * yScale
      const cIdx = cRow + (px >> 1)
      const u = (cb[cIdx] - 128) * cScale
      const v = (cr[cIdx] - 128) * cScale

      const r = lum + crR * v
      const g = lum - cbG * u - crG * v
      const b = lum + cbB * u
      out[o] = r < 0 ? 0 : r > 255 ? 255 : (r + 0.5) | 0
      out[o + 1] = g < 0 ? 0 : g > 255 ? 255 : (g + 0.5) | 0
      out[o + 2] = b < 0 ? 0 : b > 255 ? 255 : (b + 0.5) | 0
      out[o + 3] = 255
      o += 4
    }
  }
  return out
}

export interface OrientedImage {
  data: Uint8Array
  width: number
  height: number
}

/**
 * Apply the HEIF display transforms: `irot` (90-degree counter-clockwise
 * rotation count) followed by `imir` (0 = mirror about a vertical axis,
 * 1 = about a horizontal axis).
 */
export function applyOrientation(
  rgba: Uint8Array,
  width: number,
  height: number,
  rotation: number,
  mirror: number | null,
): OrientedImage {
  const pixels = imagePixelCount(width, height)
  if (rgba.length < pixels * 4)
    throw new RangeError('ts-heic: RGBA buffer is smaller than the requested image dimensions')
  if (!Number.isInteger(rotation))
    throw new RangeError('ts-heic: rotation must be an integer number of quarter turns')
  if (mirror !== null && mirror !== 0 && mirror !== 1)
    throw new RangeError('ts-heic: mirror must be 0, 1, or null')

  let data = rgba
  let w = width
  let h = height
  const rot = ((rotation % 4) + 4) % 4

  if (rot !== 0) {
    const dw = rot % 2 === 0 ? w : h
    const dh = rot % 2 === 0 ? h : w
    const out = new Uint8Array(dw * dh * 4)
    for (let dy = 0; dy < dh; dy++) {
      for (let dx = 0; dx < dw; dx++) {
        let sx: number
        let sy: number
        if (rot === 1) {
          // 90 CCW: dst(x,y) <- src(w-1-y, x)
          sx = w - 1 - dy
          sy = dx
        }
        else if (rot === 2) {
          sx = w - 1 - dx
          sy = h - 1 - dy
        }
        else {
          // 270 CCW (= 90 CW): dst(x,y) <- src(y, h-1-x)
          sx = dy
          sy = h - 1 - dx
        }
        const s = (sy * w + sx) * 4
        const d = (dy * dw + dx) * 4
        out[d] = data[s]
        out[d + 1] = data[s + 1]
        out[d + 2] = data[s + 2]
        out[d + 3] = data[s + 3]
      }
    }
    data = out
    w = dw
    h = dh
  }

  if (mirror !== null && mirror !== undefined) {
    const out = new Uint8Array(w * h * 4)
    for (let yPos = 0; yPos < h; yPos++) {
      for (let xPos = 0; xPos < w; xPos++) {
        const sx = mirror === 0 ? w - 1 - xPos : xPos
        const sy = mirror === 0 ? yPos : h - 1 - yPos
        const s = (sy * w + sx) * 4
        const d = (yPos * w + xPos) * 4
        out[d] = data[s]
        out[d + 1] = data[s + 1]
        out[d + 2] = data[s + 2]
        out[d + 3] = data[s + 3]
      }
    }
    data = out
  }

  return { data, width: w, height: h }
}
