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
| HEVC SPS parsing (dimensions, chroma, bit depth) | Done, cross-checked against container |
| HEVC slice decoding (CABAC, intra prediction, transforms, deblock/SAO) | **In progress** |

`getHeicMetadata()` works today. `decodeHeic()` throws a descriptive error
until the entropy decoder lands; `test/fixtures/` carries a ground-truth
image and a PSNR-gated `it.todo` so the decoder can be verified the moment
it produces pixels.

## Usage

```ts
import { getHeicMetadata, isHeic } from '@stacksjs/ts-heic'

const buffer = new Uint8Array(await Bun.file('photo.heic').arrayBuffer())

if (isHeic(buffer)) {
  const meta = getHeicMetadata(buffer)
  console.log(meta.width, meta.height) // display dimensions
  console.log(meta.grid?.tileItemIds.length) // e.g. 48 tiles on an iPhone capture
  console.log(meta.rotation, meta.mirror) // irot / imir display transforms
  console.log(meta.sps?.bitDepthLuma) // parsed straight from the HEVC SPS
}
```

## Testing

```bash
bun test
```

Fixtures are real iPhone captures (single-item and 48-tile grid) with
out-of-band verified dimensions.

## License

MIT
