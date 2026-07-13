import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  decodeHeic,
  getHeicMetadata,
  isHeic,
  isSliceNal,
  parseISOBMFF,
  splitLengthPrefixed,
} from '../src'

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(import.meta.dir, 'fixtures', name)))

// Real iPhone captures. Display dimensions verified out-of-band:
//   iphone-small.heic  2048x1536 (single hvc1 item)
//   iphone-grid.heic   3024x4032 (tiled grid capture)
const small = fixture('iphone-small.heic')
const grid = fixture('iphone-grid.heic')

describe('isHeic', () => {
  it('recognizes iPhone captures', () => {
    expect(isHeic(small)).toBe(true)
    expect(isHeic(grid)).toBe(true)
  })

  it('rejects non-HEIC data', () => {
    expect(isHeic(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false)
    expect(isHeic(new Uint8Array(4))).toBe(false)
  })
})

describe('getHeicMetadata', () => {
  it('reads dimensions and codec config from a single-item capture', () => {
    const meta = getHeicMetadata(small)
    expect(meta.width).toBe(2048)
    expect(meta.height).toBe(1536)
    expect(meta.bitDepth).toBe(8)
    expect(meta.hvcC).not.toBeNull()
    expect(meta.hvcC!.sps.length).toBeGreaterThan(0)
    expect(meta.hvcC!.pps.length).toBeGreaterThan(0)
    expect(meta.sliceNalCount).toBeGreaterThan(0)
  })

  it('resolves the tile layout of a grid capture', () => {
    const meta = getHeicMetadata(grid)
    expect(meta.width).toBe(3024)
    expect(meta.height).toBe(4032)
    expect(meta.primaryItemType).toBe('grid')
    expect(meta.grid).not.toBeNull()
    const g = meta.grid!
    expect(g.tileItemIds.length).toBe(g.rows * g.columns)
    expect(g.columns * g.tileWidth).toBeGreaterThanOrEqual(g.outputWidth)
    expect(g.rows * g.tileHeight).toBeGreaterThanOrEqual(g.outputHeight)
    expect(g.outputWidth).toBe(3024)
    expect(g.outputHeight).toBe(4032)
  })

  it('cross-checks SPS dimensions against the container', () => {
    for (const buffer of [small, grid]) {
      const meta = getHeicMetadata(buffer)
      expect(meta.sps).not.toBeNull()
      const sps = meta.sps!
      // For grids the SPS describes one TILE; otherwise the full image.
      const expectedW = meta.grid ? meta.grid.tileWidth : meta.width
      const expectedH = meta.grid ? meta.grid.tileHeight : meta.height
      expect(sps.width).toBe(expectedW)
      expect(sps.height).toBe(expectedH)
      expect(sps.bitDepthLuma).toBe(8)
      expect(sps.chromaFormatIdc).toBe(1) // 4:2:0
    }
  })
})

describe('parameter sets', () => {
  const { parsePps } = require('../src/hevc/pps') as typeof import('../src/hevc/pps')

  it('parses the PPS of iPhone captures field-by-field', () => {
    for (const buffer of [small, grid]) {
      const meta = getHeicMetadata(buffer)
      const pps = parsePps(meta.hvcC!.pps[0])
      expect(pps.ppsId).toBe(0)
      expect(pps.spsId).toBe(0)
      // iPhone still encodes: WPP + cu_qp_delta on; tiles/sign-hiding off.
      expect(pps.entropyCodingSyncEnabled).toBe(true)
      expect(pps.tilesEnabled).toBe(false)
      expect(pps.cuQpDeltaEnabled).toBe(true)
      expect(pps.signDataHidingEnabled).toBe(false)
      expect(pps.transformSkipEnabled).toBe(false)
      expect(pps.transquantBypassEnabled).toBe(false)
      expect(pps.dependentSliceSegmentsEnabled).toBe(false)
      expect(pps.initQp).toBe(16)
      expect(pps.cbQpOffset).toBe(2)
      expect(pps.crQpOffset).toBe(2)
      expect(pps.deblockingFilterDisabled).toBe(false)
    }
  })

  it('parses the SPS tail: scaling lists, smoothing, VUI colour', () => {
    for (const buffer of [small, grid]) {
      const meta = getHeicMetadata(buffer)
      const sps = meta.sps!
      // sps_scaling_list_enabled without explicit data = DEFAULT lists.
      expect(sps.scalingListEnabled).toBe(true)
      expect(sps.scalingListData).not.toBeNull()
      expect(sps.scalingListData!.lists[1][0][63]).toBe(115) // default intra 8x8 corner
      expect(sps.scalingListData!.lists[0][0][0]).toBe(16) // 4x4 stays flat
      expect(sps.strongIntraSmoothingEnabled).toBe(false)
      expect(sps.pcmEnabled).toBe(false)
      expect(sps.sampleAdaptiveOffsetEnabled).toBe(true)
      // Apple signals full-range BT.601 matrix coefficients.
      expect(sps.color).not.toBeNull()
      expect(sps.color!.videoFullRange).toBe(true)
      expect(sps.color!.matrixCoeffs).toBe(6)
      expect(sps.picWidthInLumaSamples).toBe(sps.width)
      expect(sps.picHeightInLumaSamples).toBe(sps.height)
    }
  })
})

describe('slice segment header', () => {
  const { parsePps } = require('../src/hevc/pps') as typeof import('../src/hevc/pps')
  const { parseSliceHeader } = require('../src/hevc/slice-header') as typeof import('../src/hevc/slice-header')
  const { getItemPayload } = require('../src/container/heic') as typeof import('../src/container/heic')

  it('parses tile slice headers and splits WPP substreams per CTU row', () => {
    for (const buffer of [small, grid]) {
      const meta = getHeicMetadata(buffer)
      const boxes = parseISOBMFF(buffer)
      const pps = parsePps(meta.hvcC!.pps[0])
      const tileId = meta.grid ? meta.grid.tileItemIds[0] : meta.primaryItemId
      const payload = getItemPayload(buffer, boxes, tileId)!
      const nals = splitLengthPrefixed(payload, meta.hvcC!.nalLengthSize)
      const slice = nals.find(n => isSliceNal(n.type))!
      const sh = parseSliceHeader(slice.data, meta.sps!, pps)

      expect(sh.firstSliceInPic).toBe(true)
      expect(sh.sliceType).toBe(2) // I slice
      expect(sh.sliceQpY).toBe(16)
      expect(sh.saoLuma).toBe(true)
      expect(sh.saoChroma).toBe(true)
      // WPP: one substream per CTU row.
      const ctuRows = Math.ceil(meta.sps!.picHeightInLumaSamples / 32)
      expect(sh.substreams.length).toBe(ctuRows)
      // Substreams tile the remainder of the NAL (minus header + EPBs).
      const total = sh.substreams.reduce((s, x) => s + x.length, 0)
      expect(total).toBeLessThanOrEqual(slice.data.length)
      expect(total).toBeGreaterThan(slice.data.length - 64 - ctuRows * 3)
    }
  })
})

describe('NAL layer', () => {
  it('splits every tile payload into valid slice NALs', () => {
    const meta = getHeicMetadata(grid)
    const boxes = parseISOBMFF(grid)
    const { getItemPayload } = require('../src/container/heic') as typeof import('../src/container/heic')

    let slices = 0
    for (const tileId of meta.grid!.tileItemIds) {
      const payload = getItemPayload(grid, boxes, tileId)
      expect(payload).not.toBeNull()
      const nals = splitLengthPrefixed(payload!, meta.hvcC!.nalLengthSize)
      expect(nals.length).toBeGreaterThan(0)
      slices += nals.filter(n => isSliceNal(n.type)).length
    }
    expect(slices).toBeGreaterThanOrEqual(meta.grid!.tileItemIds.length)
  })
})

describe('decodeHeic', () => {
  it('decodes iphone-small.heic within 30dB PSNR of the ground truth', async () => {
    const { decode: decodeJpeg } = await import('ts-jpeg')
    const { applyOrientation } = await import('../src/color')
    const img = decodeHeic(small)
    // irot=3 (90 degrees clockwise): 2048x1536 coded -> 1536x2048 displayed.
    expect(img.width).toBe(1536)
    expect(img.height).toBe(2048)

    // The ground truth JPEG raster is in coded orientation with EXIF
    // Orientation=6; bring it into display orientation the same way.
    const jpg = decodeJpeg(readFileSync(join(import.meta.dir, 'fixtures', 'iphone-small.groundtruth.jpg')), { useTArray: true })
    const ref = applyOrientation(new Uint8Array(jpg.data), jpg.width, jpg.height, 3, null)
    expect(ref.width).toBe(img.width)
    expect(ref.height).toBe(img.height)

    let se = 0
    const n = img.width * img.height
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) {
        const d = img.data[i * 4 + c] - ref.data[i * 4 + c]
        se += d * d
      }
    }
    const psnr = 10 * Math.log10((255 * 255) / (se / (n * 3)))
    expect(psnr).toBeGreaterThanOrEqual(30)
  }, 30000)

  it('decodes and stitches the tiled grid capture', () => {
    const img = decodeHeic(grid)
    expect(img.width).toBe(3024) // no rotation on this capture
    expect(img.height).toBe(4032)
    expect(img.data.length).toBe(3024 * 4032 * 4)
    // Not a blank canvas: real image content has spread-out luma.
    let min = 255
    let max = 0
    for (let i = 0; i < img.data.length; i += 4001 * 4) {
      const v = img.data[i]
      if (v < min)
        min = v
      if (v > max)
        max = v
    }
    expect(max - min).toBeGreaterThan(64)
  }, 60000)
})
