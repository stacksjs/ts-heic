/**
 * Public HEIC decoding API: container walk, HEVC intra decode of every tile,
 * grid stitching, conformance-window crop, YCbCr to RGBA conversion, and the
 * irot/imir display transforms.
 */
import type { GridInfo, HeicInfo } from './container/heic'
import type { SpsInfo } from './hevc/sps'
import { applyOrientation, yuv420ToRgba } from './color'
import { getHeicInfo, getItemPayload } from './container/heic'
import { parseISOBMFF, validateFtyp } from './container/heif'
import { deblockPicture } from './hevc/deblock'
import { isSliceNal, splitLengthPrefixed } from './hevc/nal'
import { PictureDecoder } from './hevc/picture'
import { parsePps } from './hevc/pps'
import { applySao } from './hevc/sao'
import { parseSps } from './hevc/sps'

export interface HeicMetadata extends HeicInfo {
  /** Parsed from the primary item's SPS; cross-checks the container. */
  sps: SpsInfo | null
  /** Coded slice NAL count of the primary (or first tile) item. */
  sliceNalCount: number
}

/** Whether a buffer looks like a HEIC/HEIF file. */
export function isHeic(buffer: Uint8Array): boolean {
  if (buffer.length < 12 || !validateFtyp(buffer))
    return false
  const brand = String.fromCharCode(buffer[8], buffer[9], buffer[10], buffer[11])
  return ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)
}

/**
 * Parse everything knowable without entropy-decoding pixels: dimensions,
 * grid layout, rotation/mirror, bit depth, and the HEVC parameter sets.
 */
export function getHeicMetadata(buffer: Uint8Array): HeicMetadata {
  if (!isHeic(buffer))
    throw new Error('ts-heic: not a HEIC file (ftyp brand mismatch)')

  const boxes = parseISOBMFF(buffer)
  const info = getHeicInfo(buffer, boxes)

  let sps: SpsInfo | null = null
  let sliceNalCount = 0

  if (info.hvcC) {
    if (info.hvcC.sps.length > 0)
      sps = parseSps(info.hvcC.sps[0])

    const codedItemId = info.grid ? info.grid.tileItemIds[0] : info.primaryItemId
    const payload = getItemPayload(buffer, boxes, codedItemId)
    if (payload) {
      const nals = splitLengthPrefixed(payload, info.hvcC.nalLengthSize)
      sliceNalCount = nals.filter(n => isSliceNal(n.type)).length
    }
  }

  return { ...info, sps, sliceNalCount }
}

export interface HeicImageData {
  data: Uint8Array
  width: number
  height: number
  hasAlpha: boolean
  bitDepth: 8 | 10 | 12
}

export interface DecodeOptions {
  /**
   * Apply the irot/imir display transforms (default true). When false the
   * pixels stay in coded orientation.
   */
  applyTransforms?: boolean
}

interface Planes {
  y: Uint8Array
  cb: Uint8Array
  cr: Uint8Array
  width: number
  height: number
}

function decodeItemPlanes(
  buffer: Uint8Array,
  boxes: ReturnType<typeof parseISOBMFF>,
  info: HeicInfo,
  itemId: number,
): Planes {
  const payload = getItemPayload(buffer, boxes, itemId)
  if (!payload)
    throw new Error(`ts-heic: item ${itemId} has no payload`)
  const nals = splitLengthPrefixed(payload, info.hvcC!.nalLengthSize)
  const slices = nals.filter(n => isSliceNal(n.type)).map(n => n.data)
  if (slices.length === 0)
    throw new Error(`ts-heic: item ${itemId} carries no coded slices`)

  const sps = parseSps(info.hvcC!.sps[0])
  const pps = parsePps(info.hvcC!.pps[0])
  const pic = new PictureDecoder(sps, pps).decode(slices)
  // In-loop filters run on the fully reconstructed tile: deblock first, then
  // SAO reads the deblocked samples (8.7).
  deblockPicture(pic, pps)
  applySao(pic, sps)
  return { y: pic.y, cb: pic.cb, cr: pic.cr, width: pic.width, height: pic.height }
}

function stitchGrid(
  buffer: Uint8Array,
  boxes: ReturnType<typeof parseISOBMFF>,
  info: HeicInfo,
  grid: GridInfo,
): Planes {
  const tileW = grid.tileWidth
  const tileH = grid.tileHeight
  const canvasW = grid.columns * tileW
  const canvasH = grid.rows * tileH
  const y = new Uint8Array(canvasW * canvasH)
  const cb = new Uint8Array((canvasW >> 1) * (canvasH >> 1))
  const cr = new Uint8Array((canvasW >> 1) * (canvasH >> 1))

  for (let t = 0; t < grid.tileItemIds.length; t++) {
    const tile = decodeItemPlanes(buffer, boxes, info, grid.tileItemIds[t])
    if (tile.width !== tileW || tile.height !== tileH)
      throw new Error(`ts-heic: tile ${t} is ${tile.width}x${tile.height}, expected ${tileW}x${tileH}`)
    const tx = (t % grid.columns) * tileW
    const ty = Math.floor(t / grid.columns) * tileH
    for (let row = 0; row < tileH; row++)
      y.set(tile.y.subarray(row * tileW, (row + 1) * tileW), (ty + row) * canvasW + tx)
    const cTileW = tileW >> 1
    const cCanvasW = canvasW >> 1
    for (let row = 0; row < tileH >> 1; row++) {
      const src = row * cTileW
      const dst = ((ty >> 1) + row) * cCanvasW + (tx >> 1)
      cb.set(tile.cb.subarray(src, src + cTileW), dst)
      cr.set(tile.cr.subarray(src, src + cTileW), dst)
    }
  }
  return { y, cb, cr, width: canvasW, height: canvasH }
}

function cropPlanes(planes: Planes, x0: number, y0: number, width: number, height: number): Planes {
  if (x0 === 0 && y0 === 0 && width === planes.width && height === planes.height)
    return planes
  const y = new Uint8Array(width * height)
  const cw = width >> 1
  const ch = height >> 1
  const cb = new Uint8Array(cw * ch)
  const cr = new Uint8Array(cw * ch)
  for (let row = 0; row < height; row++) {
    const src = (y0 + row) * planes.width + x0
    y.set(planes.y.subarray(src, src + width), row * width)
  }
  const srcCw = planes.width >> 1
  for (let row = 0; row < ch; row++) {
    const src = ((y0 >> 1) + row) * srcCw + (x0 >> 1)
    cb.set(planes.cb.subarray(src, src + cw), row * cw)
    cr.set(planes.cr.subarray(src, src + cw), row * cw)
  }
  return { y, cb, cr, width, height }
}

/** Decode a HEIC file to RGBA pixels. */
export function decodeHeic(buffer: Uint8Array, options: DecodeOptions = {}): HeicImageData {
  const boxes = parseISOBMFF(buffer)
  const info = getHeicInfo(buffer, boxes)
  if (!info.hvcC)
    throw new Error('ts-heic: primary item has no HEVC configuration (hvcC)')

  const sps = parseSps(info.hvcC.sps[0])

  let planes: Planes
  if (info.grid) {
    planes = stitchGrid(buffer, boxes, info, info.grid)
    planes = cropPlanes(planes, 0, 0, info.grid.outputWidth, info.grid.outputHeight)
  }
  else {
    planes = decodeItemPlanes(buffer, boxes, info, info.primaryItemId)
    // Conformance window (crop offsets are in chroma units for 4:2:0).
    const subW = sps.chromaFormatIdc === 1 || sps.chromaFormatIdc === 2 ? 2 : 1
    const subH = sps.chromaFormatIdc === 1 ? 2 : 1
    planes = cropPlanes(planes, subW * sps.cropLeft, subH * sps.cropTop, sps.width, sps.height)
  }

  const rgba = yuv420ToRgba(planes.y, planes.cb, planes.cr, planes.width, planes.height, {
    matrixCoeffs: sps.color?.matrixCoeffs ?? 6,
    fullRange: sps.color?.videoFullRange ?? true,
  })

  let data = rgba
  let width = planes.width
  let height = planes.height
  if (options.applyTransforms !== false && (info.rotation !== 0 || info.mirror !== null)) {
    const oriented = applyOrientation(rgba, width, height, info.rotation, info.mirror)
    data = oriented.data
    width = oriented.width
    height = oriented.height
  }

  return { data, width, height, hasAlpha: false, bitDepth: 8 }
}
