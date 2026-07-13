import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { getHeicInfo, getItemPayload } from '../src/container/heic'
import { parseISOBMFF } from '../src/container/heif'
import { deblockPicture } from '../src/hevc/deblock'
import { isSliceNal, splitLengthPrefixed } from '../src/hevc/nal'
import { PictureDecoder } from '../src/hevc/picture'
import { parsePps } from '../src/hevc/pps'
import { applySao } from '../src/hevc/sao'
import { parseSps } from '../src/hevc/sps'

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(import.meta.dir, 'fixtures', name)))

function decodeTile(buffer: Uint8Array, tileIndex: number, filter = false) {
  const boxes = parseISOBMFF(buffer)
  const info = getHeicInfo(buffer, boxes)
  const sps = parseSps(info.hvcC!.sps[0])
  const pps = parsePps(info.hvcC!.pps[0])
  const itemId = info.grid ? info.grid.tileItemIds[tileIndex] : info.primaryItemId
  const payload = getItemPayload(buffer, boxes, itemId)!
  const nals = splitLengthPrefixed(payload, info.hvcC!.nalLengthSize)
  const slices = nals.filter(n => isSliceNal(n.type)).map(n => n.data)
  const pic = new PictureDecoder(sps, pps).decode(slices)
  if (filter) {
    deblockPicture(pic, pps)
    applySao(pic, sps)
  }
  return pic
}

describe('PictureDecoder', () => {
  it('decodes tile 0 of iphone-small bit-exactly (verified vs libde265)', () => {
    const pic = decodeTile(fixture('iphone-small.heic'), 0)
    expect(pic.width).toBe(640)
    expect(pic.height).toBe(896)
    // SHA-256 of Y+Cb+Cr planes, identical to libde265's pre-loop-filter
    // reconstruction of the same tile (--disable-deblocking --disable-sao).
    const hash = createHash('sha256').update(pic.y).update(pic.cb).update(pic.cr).digest('hex')
    expect(hash).toBe('9fa68e415559979da659909f50f6a22049f0bd72c7ec6dbd0dab823e93c01dc2')
  })

  it('matches libde265 bit-exactly after deblocking + SAO', () => {
    const pic = decodeTile(fixture('iphone-small.heic'), 0, true)
    // SHA-256 of the fully filtered tile, identical to libde265's default
    // (deblock + SAO) reconstruction.
    const hash = createHash('sha256').update(pic.y).update(pic.cb).update(pic.cr).digest('hex')
    expect(hash).toBe('57f19be89b92c4b126628c762972faf1b553cc1935d54ec183eaaae74c84ac66')
  })

  it('decodes every tile of both fixtures without CABAC desync', () => {
    // The decoder throws on any end_of_slice/end_of_subset mismatch, so a
    // clean run is itself a strong bitstream-conformance check.
    for (const name of ['iphone-small.heic', 'iphone-grid.heic']) {
      const buffer = fixture(name)
      const boxes = parseISOBMFF(buffer)
      const info = getHeicInfo(buffer, boxes)
      const tiles = info.grid ? info.grid.tileItemIds.length : 1
      for (let t = 0; t < tiles; t++) {
        const pic = decodeTile(buffer, t)
        expect(pic.y.length).toBe(pic.width * pic.height)
      }
    }
  }, 120000)
})
