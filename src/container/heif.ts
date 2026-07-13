/** Generic ISOBMFF/HEIF container types (inherited from the ts-avif base). */
export interface ISOBMFFBox {
  type: string
  size: number
  offset: number
  data: Uint8Array
  children?: ISOBMFFBox[]
}

export interface ItemLocationExtent {
  extentOffset: number
  extentLength: number
}

export interface ItemLocation {
  itemId: number
  constructionMethod: number
  dataReferenceIndex: number
  baseOffset: number
  extents: ItemLocationExtent[]
}

export interface ItemInfo {
  itemId: number
  itemType: string
  itemName: string
  itemProtectionIndex: number
}

export interface ImageSpatialExtent {
  width: number
  height: number
}

export interface PixelInformation {
  bitsPerChannel: number[]
}


/**
 * Parse ISOBMFF (ISO Base Media File Format) boxes
 */
export function parseISOBMFF(buffer: Uint8Array): ISOBMFFBox[] {
  const boxes: ISOBMFFBox[] = []
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  let offset = 0

  while (offset < buffer.length - 8) {
    const size = view.getUint32(offset)
    const type = String.fromCharCode(
      buffer[offset + 4],
      buffer[offset + 5],
      buffer[offset + 6],
      buffer[offset + 7],
    )

    let boxSize = size
    let headerSize = 8

    if (size === 1) {
      // 64-bit size
      const highSize = view.getUint32(offset + 8)
      const lowSize = view.getUint32(offset + 12)
      boxSize = highSize * 0x100000000 + lowSize
      headerSize = 16
    }
    else if (size === 0) {
      // Box extends to end of file
      boxSize = buffer.length - offset
    }

    // subarray is a view into the same memory — slice would copy. For a
    // typical AVIF with a few dozen nested boxes this avoids ≈ N×fileSize
    // bytes of pointless allocation.
    const data = buffer.subarray(offset + headerSize, offset + boxSize)

    const box: ISOBMFFBox = {
      type,
      size: boxSize,
      offset,
      data,
    }

    // Parse container boxes
    if (isContainerBox(type)) {
      // ISOBMFF FullBoxes carry a 4-byte version+flags prefix before
      // their children. If we don't skip it, the version word gets
      // misinterpreted as the size field of a phantom first child,
      // which then masks every real child. `meta` and `iref` are the
      // FullBoxes in our `containerTypes` list — both need the skip.
      const isFullBoxContainer = type === 'meta' || type === 'iref'
      const childrenStart = isFullBoxContainer ? 4 : 0
      box.children = parseISOBMFF(data.subarray(childrenStart))
    }

    boxes.push(box)
    offset += boxSize
  }

  return boxes
}

function isContainerBox(type: string): boolean {
  const containerTypes = [
    'moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf',
    'meta', 'iprp', 'ipco', 'iref', 'grpl',
  ]
  return containerTypes.includes(type)
}

/**
 * Find a box by type
 */
export function findBox(boxes: ISOBMFFBox[], type: string): ISOBMFFBox | undefined {
  for (const box of boxes) {
    if (box.type === type) {
      return box
    }
    if (box.children) {
      const found = findBox(box.children, type)
      if (found) {
        return found
      }
    }
  }
  return undefined
}

/**
 * Find all boxes of a type
 */
export function findAllBoxes(boxes: ISOBMFFBox[], type: string): ISOBMFFBox[] {
  const result: ISOBMFFBox[] = []

  for (const box of boxes) {
    if (box.type === type) {
      result.push(box)
    }
    if (box.children) {
      result.push(...findAllBoxes(box.children, type))
    }
  }

  return result
}

/**
 * Validate AVIF file type
 */
export function validateFtyp(buffer: Uint8Array): boolean {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  // Read box header
  const size = view.getUint32(0)
  const type = String.fromCharCode(buffer[4], buffer[5], buffer[6], buffer[7])

  if (type !== 'ftyp') {
    return false
  }

  // Read major brand
  const majorBrand = String.fromCharCode(buffer[8], buffer[9], buffer[10], buffer[11])

  // Valid AVIF brands
  const validBrands = ['avif', 'avis', 'mif1', 'miaf']

  if (validBrands.includes(majorBrand)) {
    return true
  }

  // Check compatible brands
  const numBrands = (size - 16) / 4

  for (let i = 0; i < numBrands; i++) {
    const offset = 16 + i * 4
    const brand = String.fromCharCode(
      buffer[offset],
      buffer[offset + 1],
      buffer[offset + 2],
      buffer[offset + 3],
    )
    if (validBrands.includes(brand)) {
      return true
    }
  }

  return false
}

/**
 * Parse item location box (iloc)
 */
export function parseIloc(data: Uint8Array): ItemLocation[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  const version = data[0]
  const flags = (data[1] << 16) | (data[2] << 8) | data[3]

  const offsetSize = (data[4] >> 4) & 0x0F
  const lengthSize = data[4] & 0x0F
  const baseOffsetSize = (data[5] >> 4) & 0x0F
  const indexSize = version === 1 || version === 2 ? (data[5] & 0x0F) : 0

  let offset = 6
  let itemCount: number

  if (version < 2) {
    itemCount = view.getUint16(offset)
    offset += 2
  }
  else {
    itemCount = view.getUint32(offset)
    offset += 4
  }

  const items: ItemLocation[] = []

  for (let i = 0; i < itemCount; i++) {
    let itemId: number

    if (version < 2) {
      itemId = view.getUint16(offset)
      offset += 2
    }
    else {
      itemId = view.getUint32(offset)
      offset += 4
    }

    let constructionMethod = 0
    if (version === 1 || version === 2) {
      constructionMethod = view.getUint16(offset) & 0x0F
      offset += 2
    }

    const dataReferenceIndex = view.getUint16(offset)
    offset += 2

    let baseOffset = 0
    if (baseOffsetSize === 4) {
      baseOffset = view.getUint32(offset)
      offset += 4
    }
    else if (baseOffsetSize === 8) {
      baseOffset = view.getUint32(offset) * 0x100000000 + view.getUint32(offset + 4)
      offset += 8
    }

    const extentCount = view.getUint16(offset)
    offset += 2

    const extents: Array<{ extentOffset: number, extentLength: number }> = []

    for (let j = 0; j < extentCount; j++) {
      if (indexSize > 0) {
        offset += indexSize // Skip extent index
      }

      let extentOffset = 0
      if (offsetSize === 4) {
        extentOffset = view.getUint32(offset)
        offset += 4
      }
      else if (offsetSize === 8) {
        extentOffset = view.getUint32(offset) * 0x100000000 + view.getUint32(offset + 4)
        offset += 8
      }

      let extentLength = 0
      if (lengthSize === 4) {
        extentLength = view.getUint32(offset)
        offset += 4
      }
      else if (lengthSize === 8) {
        extentLength = view.getUint32(offset) * 0x100000000 + view.getUint32(offset + 4)
        offset += 8
      }

      extents.push({ extentOffset, extentLength })
    }

    items.push({
      itemId,
      constructionMethod,
      dataReferenceIndex,
      baseOffset,
      extents,
    })
  }

  return items
}

/**
 * Parse item info box (iinf)
 */
export function parseIinf(data: Uint8Array): ItemInfo[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  const version = data[0]

  let offset = 4
  let entryCount: number

  if (version === 0) {
    entryCount = view.getUint16(offset)
    offset += 2
  }
  else {
    entryCount = view.getUint32(offset)
    offset += 4
  }

  const items: ItemInfo[] = []

  for (let i = 0; i < entryCount; i++) {
    const entrySize = view.getUint32(offset)
    const entryType = String.fromCharCode(
      data[offset + 4],
      data[offset + 5],
      data[offset + 6],
      data[offset + 7],
    )

    if (entryType === 'infe') {
      const infeData = data.slice(offset + 8, offset + entrySize)
      const itemInfo = parseInfe(infeData)
      items.push(itemInfo)
    }

    offset += entrySize
  }

  return items
}

function parseInfe(data: Uint8Array): ItemInfo {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  const version = data[0]

  let offset = 4
  let itemId: number
  let itemProtectionIndex: number

  if (version < 2) {
    itemId = view.getUint16(offset)
    offset += 2
    itemProtectionIndex = view.getUint16(offset)
    offset += 2
  }
  else if (version === 2) {
    itemId = view.getUint16(offset)
    offset += 2
    itemProtectionIndex = view.getUint16(offset)
    offset += 2
  }
  else {
    itemId = view.getUint32(offset)
    offset += 4
    itemProtectionIndex = view.getUint16(offset)
    offset += 2
  }

  const itemType = String.fromCharCode(
    data[offset],
    data[offset + 1],
    data[offset + 2],
    data[offset + 3],
  )
  offset += 4

  // Read null-terminated item name
  let itemName = ''
  while (offset < data.length && data[offset] !== 0) {
    itemName += String.fromCharCode(data[offset])
    offset++
  }

  return {
    itemId,
    itemProtectionIndex,
    itemType,
    itemName,
  }
}

/**
 * Parse image spatial extent (ispe)
 */
export function parseIspe(data: Uint8Array): ImageSpatialExtent {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  // Skip version and flags
  const width = view.getUint32(4)
  const height = view.getUint32(8)

  return { width, height }
}

/**
 * Parse pixel information (pixi)
 */
export function parsePixi(data: Uint8Array): PixelInformation {
  // Skip version and flags
  const numChannels = data[4]
  const bitsPerChannel: number[] = []

  for (let i = 0; i < numChannels; i++) {
    bitsPerChannel.push(data[5 + i])
  }

  return { bitsPerChannel }
}



/**
 * Get image item data
 */
export function getImageData(
  buffer: Uint8Array,
  boxes: ISOBMFFBox[],
  itemId: number,
): Uint8Array | null {
  // Find meta box
  const metaBox = findBox(boxes, 'meta')
  if (!metaBox || !metaBox.children) {
    return null
  }

  // Find iloc box
  const ilocBox = findBox(metaBox.children, 'iloc')
  if (!ilocBox) {
    return null
  }

  const locations = parseIloc(ilocBox.data)
  const location = locations.find(loc => loc.itemId === itemId)

  if (!location) {
    return null
  }

  // For construction_method=0 the iloc extent_offset is an absolute file
  // offset (when base_offset_size=0) — we should NOT add mdat's location
  // again; doing so produced truncated reads, e.g. 75097 bytes returned
  // when the actual extent was 75379. Just trust iloc.
  const parts: Uint8Array[] = []

  for (const extent of location.extents) {
    const offset = location.baseOffset + extent.extentOffset
    const data = buffer.slice(offset, offset + extent.extentLength)
    parts.push(data)
  }

  // Concatenate parts
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0

  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }

  return result
}

