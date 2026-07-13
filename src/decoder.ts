/**
 * Public HEIC decoding API.
 *
 * Container + parameter-set layers are fully implemented and verified
 * against real iPhone captures. The HEVC slice decoder (CABAC entropy
 * decoding, intra prediction, inverse transforms, deblocking/SAO) is the
 * remaining piece — `decodeHeic` throws a clear error until it lands, while
 * `getHeicMetadata` works today.
 */
import type { HeicInfo } from './container/heic'
import type { SpsInfo } from './hevc/sps'
import { getHeicInfo, getItemPayload } from './container/heic'
import { parseISOBMFF, validateFtyp } from './container/heif'
import { isSliceNal, splitLengthPrefixed } from './hevc/nal'
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

/**
 * Decode a HEIC file to RGBA pixels.
 *
 * Not implemented yet: requires the HEVC intra slice decoder (see
 * src/hevc/). Track the metadata via {@link getHeicMetadata} meanwhile.
 */
export function decodeHeic(buffer: Uint8Array): HeicImageData {
  const metadata = getHeicMetadata(buffer)
  throw new Error(
    `ts-heic: HEVC slice decoding is not implemented yet `
    + `(${metadata.width}x${metadata.height}, ${metadata.grid ? `${metadata.grid.tileItemIds.length}-tile grid` : 'single item'}, `
    + `${metadata.sliceNalCount} slice NAL(s) parsed). `
    + `Container, hvcC, NAL, and SPS layers are complete — the entropy decoder is the remaining work.`,
  )
}
