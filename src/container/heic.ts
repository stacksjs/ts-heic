/**
 * HEIC-specific HEIF container parsing, layered on the shared ISOBMFF
 * walker in ./heif. Handles what iPhone HEICs actually ship:
 *
 *   - `pitm` primary item selection
 *   - `ipma` item ↔ property association (the first `ispe` in `ipco` is the
 *     TILE size on grid images, so properties must be resolved per item)
 *   - `iref` `dimg` references (grid → tile items)
 *   - `grid` derived-image body (rows/columns/output size)
 *   - `hvcC` HEVC decoder configuration (VPS/SPS/PPS arrays, NAL length size)
 *   - `irot` / `imir` display transforms
 */
import type { ISOBMFFBox } from './heif'
import { findBox, parseIinf, parseIloc, parseIspe, parsePixi } from './heif'

export interface HvcCConfig {
  configurationVersion: number
  generalProfileIdc: number
  generalLevelIdc: number
  chromaFormatIdc: number
  bitDepthLumaMinus8: number
  bitDepthChromaMinus8: number
  /** Bytes prefixed to each NAL unit length in the item payload (1, 2, or 4). */
  nalLengthSize: number
  /** Parameter set NAL units by type: vps (32), sps (33), pps (34). */
  vps: Uint8Array[]
  sps: Uint8Array[]
  pps: Uint8Array[]
}

export interface GridInfo {
  rows: number
  columns: number
  outputWidth: number
  outputHeight: number
  /** Tile item ids in raster order (from the `dimg` reference). */
  tileItemIds: number[]
  tileWidth: number
  tileHeight: number
}

export interface HeicInfo {
  primaryItemId: number
  /** 'hvc1' for a single-coded image, 'grid' for tiled iPhone captures. */
  primaryItemType: string
  /** Upright display dimensions of the primary image (before irot/imir). */
  width: number
  height: number
  bitDepth: number
  /** 90-degree counter-clockwise rotation count from `irot` (0-3). */
  rotation: number
  /** Mirror axis from `imir` (0 vertical, 1 horizontal), or null. */
  mirror: number | null
  hasAlpha: boolean
  hvcC: HvcCConfig | null
  grid: GridInfo | null
}

interface ItemReference {
  referenceType: string
  fromItemId: number
  toItemIds: number[]
}

interface PropertyAssociation {
  itemId: number
  /** 1-based indexes into ipco's child boxes. */
  propertyIndexes: number[]
}

function u16(data: Uint8Array, off: number): number {
  return (data[off] << 8) | data[off + 1]
}

function u32(data: Uint8Array, off: number): number {
  return (((data[off] << 24) | (data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3])) >>> 0
}

/** Parse `pitm` (primary item id). */
export function parsePitm(data: Uint8Array): number {
  const version = data[0]
  return version === 0 ? u16(data, 4) : u32(data, 4)
}

/** Parse `iref` child boxes into flat references. */
export function parseIref(box: ISOBMFFBox): ItemReference[] {
  const version = box.data[0]
  const idSize = version === 0 ? 2 : 4
  const refs: ItemReference[] = []

  // Children of iref are the individual reference boxes (dimg, thmb, cdsc, …)
  for (const child of box.children ?? []) {
    const d = child.data
    let p = 0
    const fromItemId = idSize === 2 ? u16(d, p) : u32(d, p)
    p += idSize
    const count = u16(d, p)
    p += 2
    const toItemIds: number[] = []
    for (let i = 0; i < count; i++) {
      toItemIds.push(idSize === 2 ? u16(d, p) : u32(d, p))
      p += idSize
    }
    refs.push({ referenceType: child.type, fromItemId, toItemIds })
  }
  return refs
}

/** Parse `ipma` associations (which ipco properties apply to which item). */
export function parseIpma(data: Uint8Array): PropertyAssociation[] {
  const version = data[0]
  const flags = (data[1] << 16) | (data[2] << 8) | data[3]
  let p = 4
  const entryCount = u32(data, p)
  p += 4

  const out: PropertyAssociation[] = []
  for (let e = 0; e < entryCount; e++) {
    const itemId = version < 1 ? u16(data, p) : u32(data, p)
    p += version < 1 ? 2 : 4
    const associationCount = data[p++]
    const propertyIndexes: number[] = []
    for (let a = 0; a < associationCount; a++) {
      if (flags & 1) {
        // 15-bit index (top bit = essential flag)
        propertyIndexes.push(u16(data, p) & 0x7FFF)
        p += 2
      }
      else {
        propertyIndexes.push(data[p++] & 0x7F)
      }
    }
    out.push({ itemId, propertyIndexes })
  }
  return out
}

/** Parse the `hvcC` HEVCDecoderConfigurationRecord. */
export function parseHvcC(data: Uint8Array): HvcCConfig {
  const configurationVersion = data[0]
  const generalProfileIdc = data[1] & 0x1F
  const generalLevelIdc = data[12]
  const chromaFormatIdc = data[16] & 0x03
  const bitDepthLumaMinus8 = data[17] & 0x07
  const bitDepthChromaMinus8 = data[18] & 0x07
  const nalLengthSize = (data[21] & 0x03) + 1
  const numArrays = data[22]

  const vps: Uint8Array[] = []
  const sps: Uint8Array[] = []
  const pps: Uint8Array[] = []

  let p = 23
  for (let i = 0; i < numArrays; i++) {
    const nalType = data[p] & 0x3F
    p += 1
    const numNalus = u16(data, p)
    p += 2
    for (let n = 0; n < numNalus; n++) {
      const len = u16(data, p)
      p += 2
      const nal = data.subarray(p, p + len)
      p += len
      if (nalType === 32)
        vps.push(nal)
      else if (nalType === 33)
        sps.push(nal)
      else if (nalType === 34)
        pps.push(nal)
    }
  }

  return {
    configurationVersion,
    generalProfileIdc,
    generalLevelIdc,
    chromaFormatIdc,
    bitDepthLumaMinus8,
    bitDepthChromaMinus8,
    nalLengthSize,
    vps,
    sps,
    pps,
  }
}

/** Parse a `grid` derived-image item body. */
export function parseGridBody(data: Uint8Array): Omit<GridInfo, 'tileItemIds' | 'tileWidth' | 'tileHeight'> {
  // ImageGrid: version(1) flags(1) rows_minus_one(1) columns_minus_one(1)
  // then output width/height as 16 or 32 bit depending on flags bit 0.
  const flags = data[1]
  const rows = data[2] + 1
  const columns = data[3] + 1
  const fieldSize = (flags & 1) ? 4 : 2
  const outputWidth = fieldSize === 2 ? u16(data, 4) : u32(data, 4)
  const outputHeight = fieldSize === 2 ? u16(data, 4 + fieldSize) : u32(data, 4 + fieldSize)
  return { rows, columns, outputWidth, outputHeight }
}

/**
 * Resolve the full picture of a HEIC file's primary image: dimensions,
 * codec configuration, grid layout, and display transforms.
 */
export function getHeicInfo(buffer: Uint8Array, boxes: ISOBMFFBox[]): HeicInfo {
  const metaBox = findBox(boxes, 'meta')
  if (!metaBox?.children)
    throw new Error('ts-heic: no meta box found')

  const pitmBox = findBox(metaBox.children, 'pitm')
  if (!pitmBox)
    throw new Error('ts-heic: no primary item (pitm) box found')
  const primaryItemId = parsePitm(pitmBox.data)

  const iinfBox = findBox(metaBox.children, 'iinf')
  const items = iinfBox ? parseIinf(iinfBox.data) : []
  const primaryItem = items.find(i => i.itemId === primaryItemId)
  if (!primaryItem)
    throw new Error(`ts-heic: primary item ${primaryItemId} not present in iinf`)

  const iprpBox = findBox(metaBox.children, 'iprp')
  const ipcoBox = iprpBox?.children ? findBox(iprpBox.children, 'ipco') : undefined
  const ipmaBox = iprpBox?.children ? findBox(iprpBox.children, 'ipma') : undefined
  if (!ipcoBox?.children || !ipmaBox)
    throw new Error('ts-heic: missing item properties (ipco/ipma)')

  const associations = parseIpma(ipmaBox.data)
  const propsFor = (itemId: number): ISOBMFFBox[] => {
    const assoc = associations.find(a => a.itemId === itemId)
    if (!assoc)
      return []
    return assoc.propertyIndexes
      .map(index => ipcoBox.children![index - 1])
      .filter(Boolean)
  }

  const primaryProps = propsFor(primaryItemId)
  const ispeBox = primaryProps.find(b => b.type === 'ispe')
  const extent = ispeBox ? parseIspe(ispeBox.data) : { width: 0, height: 0 }

  const pixiBox = primaryProps.find(b => b.type === 'pixi')
  let bitDepth = 8
  if (pixiBox) {
    const pixi = parsePixi(pixiBox.data)
    if (pixi.bitsPerChannel.length > 0)
      bitDepth = pixi.bitsPerChannel[0]
  }

  const irotBox = primaryProps.find(b => b.type === 'irot')
  const rotation = irotBox ? irotBox.data[0] & 0x03 : 0
  const imirBox = primaryProps.find(b => b.type === 'imir')
  const mirror = imirBox ? imirBox.data[0] & 0x01 : null

  const irefBox = findBox(metaBox.children, 'iref')
  const refs = irefBox ? parseIref(irefBox) : []
  const hasAlpha = items.some(i => i.itemType === 'auxl')

  let grid: GridInfo | null = null
  let hvcC: HvcCConfig | null = null

  if (primaryItem.itemType === 'grid') {
    const body = getItemPayload(buffer, boxes, primaryItemId)
    if (!body)
      throw new Error('ts-heic: grid item has no body')
    const gridBody = parseGridBody(body)

    const dimg = refs.find(r => r.referenceType === 'dimg' && r.fromItemId === primaryItemId)
    if (!dimg)
      throw new Error('ts-heic: grid image without dimg tile references')

    const firstTileProps = propsFor(dimg.toItemIds[0])
    const tileIspe = firstTileProps.find(b => b.type === 'ispe')
    const tileExtent = tileIspe ? parseIspe(tileIspe.data) : { width: 0, height: 0 }

    grid = {
      ...gridBody,
      tileItemIds: dimg.toItemIds,
      tileWidth: tileExtent.width,
      tileHeight: tileExtent.height,
    }

    const tileHvcc = firstTileProps.find(b => b.type === 'hvcC')
    if (tileHvcc)
      hvcC = parseHvcC(tileHvcc.data)
  }
  else {
    const hvccBox = primaryProps.find(b => b.type === 'hvcC')
    if (hvccBox)
      hvcC = parseHvcC(hvccBox.data)
  }

  return {
    primaryItemId,
    primaryItemType: primaryItem.itemType,
    width: extent.width || grid?.outputWidth || 0,
    height: extent.height || grid?.outputHeight || 0,
    bitDepth,
    rotation,
    mirror,
    hasAlpha,
    hvcC,
    grid,
  }
}

/**
 * Extract one item's payload, honoring the iloc construction method:
 * 0 = absolute file offsets (coded tiles in `mdat`), 1 = offsets into the
 * `idat` box inside `meta` (how iPhone grids store the tiny grid body).
 */
export function getItemPayload(buffer: Uint8Array, boxes: ISOBMFFBox[], itemId: number): Uint8Array | null {
  const metaBox = findBox(boxes, 'meta')
  if (!metaBox?.children)
    return null
  const ilocBox = findBox(metaBox.children, 'iloc')
  if (!ilocBox)
    return null

  const location = parseIloc(ilocBox.data).find(loc => loc.itemId === itemId)
  if (!location)
    return null

  if (location.constructionMethod === 1) {
    const idatBox = findBox(metaBox.children, 'idat')
    if (!idatBox)
      return null
    const parts = location.extents.map((extent) => {
      const start = location.baseOffset + extent.extentOffset
      return idatBox.data.subarray(start, start + extent.extentLength)
    })
    return concat(parts)
  }

  // construction_method 0: absolute file offsets.
  const parts = location.extents.map((extent) => {
    const start = location.baseOffset + extent.extentOffset
    return buffer.subarray(start, start + extent.extentLength)
  })
  return concat(parts)
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Re-export the iloc parser for consumers that walk items manually. */
export { parseIloc }
