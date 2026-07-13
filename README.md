# ts-heic

> A pure TypeScript HEIC/HEIF decoder with zero native dependencies.

Forked from the `ts-avif` container base (HEIC and AVIF share the HEIF/ISOBMFF
container; only the codec inside differs).

## Status

| Layer | Status |
| --- | --- |
| ISOBMFF/HEIF container (`meta`, `iinf`, `iloc`, `iref`, `ipma`, `pitm`, `idat`) | Done, tested against real iPhone captures |
| iPhone tile grids (`grid` derived items, `dimg` references) | Done |
| Display transforms (`irot`, `imir`) | Done |
| `hvcC` decoder configuration (VPS/SPS/PPS extraction) | Done |
| HEVC NAL splitting + RBSP unescaping | Done |
| HEVC SPS/PPS parsing (dimensions, chroma, bit depth, scaling lists, VUI) | Done, cross-checked against container |
| HEVC slice decoding (CABAC, intra prediction, inverse transforms) | Done, bit-exact vs libde265 |
| In-loop filters (deblocking, SAO) | Done, bit-exact vs libde265 |
| YCbCr 4:2:0 to RGBA, grid stitching, conformance-window crop | Done |

`decodeHeic()` fully decodes single-item and tiled iPhone captures to RGBA.
The intra decode path (entropy, prediction, transforms, and both in-loop
filters) is verified bit-exact against libde265's reconstruction of real
capture tiles, and `test/` gates the end-to-end pipeline at PSNR >= 30 dB
against a ground-truth image (it decodes to ~47 dB).

Scope: HEVC Main-profile intra still images (I-slices, 4:2:0, 8-bit), which
is what HEIC captures use. Inter prediction, 10/12-bit, and 4:2:2/4:4:4 are
out of scope.

## Usage

```ts
import { decodeHeic, getHeicMetadata, isHeic } from '@stacksjs/ts-heic'

const buffer = new Uint8Array(await Bun.file('photo.heic').arrayBuffer())

if (isHeic(buffer)) {
  // Metadata only (no pixel decode):
  const meta = getHeicMetadata(buffer)
  console.log(meta.width, meta.height) // display dimensions
  console.log(meta.grid?.tileItemIds.length) // e.g. 48 tiles on an iPhone capture
  console.log(meta.rotation, meta.mirror) // irot / imir display transforms

  // Full decode to RGBA (irot/imir applied by default):
  const image = decodeHeic(buffer)
  console.log(image.width, image.height) // display dimensions
  console.log(image.data.length) // width * height * 4 (RGBA8888)
}
```

## Testing

```bash
bun test
```

Fixtures are real iPhone captures (a 2048x1536 8-tile capture and a
3024x4032 48-tile grid). Correctness is pinned two ways: golden SHA-256
hashes of a decoded tile's planes (matching libde265's output before and
after loop filtering), and a PSNR check of the full pipeline against a
ground-truth image.

## License

MIT
