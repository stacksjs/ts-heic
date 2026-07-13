# ts-heic

> Decode HEIC and HEIF images in pure TypeScript, with no native modules, WebAssembly, or runtime dependencies.

`@stacksjs/ts-heic` reads HEIF containers, decodes HEVC intra pictures, stitches tiled images, applies display transforms, and returns portable RGBA pixels. It is designed for the 8-bit HEIC still images produced by devices such as iPhones.

## Highlights

- Pure TypeScript with zero runtime dependencies
- Full HEIC-to-RGBA decoding through `decodeHeic()`
- Fast metadata inspection without decoding pixels
- HEIF tile-grid stitching for high-resolution captures
- `irot` and `imir` orientation handling
- HEVC deblocking and sample adaptive offset (SAO) filters
- Low-level container, NAL, SPS, PPS, and picture-decoder exports
- Works with any runtime that can provide a `Uint8Array`

## Install

```bash
bun add @stacksjs/ts-heic
```

```bash
npm install @stacksjs/ts-heic
```

```bash
pnpm add @stacksjs/ts-heic
```

## Quick start

```ts
import { readFile } from 'node:fs/promises'
import { decodeHeic, isHeic } from '@stacksjs/ts-heic'

const input = await readFile('photo.heic')

if (!isHeic(input))
  throw new Error('Expected a HEIC image')

const image = decodeHeic(input)

console.log(image.width, image.height)
console.log(image.data) // Uint8Array of RGBA8888 pixels
```

The decoded result has this shape:

```ts
interface HeicImageData {
  data: Uint8Array
  width: number
  height: number
  hasAlpha: boolean
  bitDepth: 8 | 10 | 12
}
```

Pixels are tightly packed in row-major `R, G, B, A` order, so `data.length` is always `width * height * 4`.

## Use the result in a browser

```ts
import { decodeHeic } from '@stacksjs/ts-heic'

async function drawHeic(file: File, canvas: HTMLCanvasElement) {
  const input = new Uint8Array(await file.arrayBuffer())
  const image = decodeHeic(input)

  canvas.width = image.width
  canvas.height = image.height

  const context = canvas.getContext('2d')!
  const pixels = new Uint8ClampedArray(image.data)
  context.putImageData(new ImageData(pixels, image.width, image.height), 0, 0)
}
```

## Read metadata without decoding

`getHeicMetadata()` walks the container and parameter sets without running the pixel decoder.

```ts
import { getHeicMetadata } from '@stacksjs/ts-heic'

const metadata = getHeicMetadata(input)

console.log({
  width: metadata.width,
  height: metadata.height,
  bitDepth: metadata.bitDepth,
  rotation: metadata.rotation,
  mirror: metadata.mirror,
  itemType: metadata.primaryItemType,
  tileCount: metadata.grid?.tileItemIds.length ?? 1,
  sliceCount: metadata.sliceNalCount,
})
```

Metadata dimensions describe the stored image before `irot` and `imir` are applied. `decodeHeic()` applies those transforms by default, so a quarter-turn rotation swaps the decoded width and height.

## Control display transforms

To keep pixels in their stored orientation, disable transforms during decoding:

```ts
const image = decodeHeic(input, { applyTransforms: false })
```

You can also apply transforms manually with the exported `applyOrientation()` helper. Rotation is expressed as counter-clockwise quarter turns; mirror axis `0` is vertical and `1` is horizontal.

## Supported images

The decoder currently targets HEVC Main-profile still images with:

- Intra-coded I-slices
- 8-bit YCbCr 4:2:0 pixels
- Single coded images and HEIF `grid` derived images
- Wavefront parallel processing (WPP)
- Scaling lists and quantization groups
- Deblocking and SAO in-loop filters
- BT.601 and BT.709 color matrices, in full or limited range
- HEIF conformance-window cropping, rotation, and mirroring

The following are outside the current decoding scope:

- Inter-predicted HEVC frames
- 10-bit and 12-bit pixel decoding
- YCbCr 4:2:2 and 4:4:4
- PCM-coded blocks and transform bypass
- Auxiliary alpha-plane decoding
- Animated image sequences

Unsupported bitstreams fail with an error instead of silently producing partial pixels.

## API overview

| Export | Purpose |
| --- | --- |
| `isHeic(buffer)` | Check the `ftyp` major and compatible brands |
| `getHeicMetadata(buffer)` | Inspect dimensions, grid layout, transforms, and codec metadata |
| `decodeHeic(buffer, options?)` | Decode a HEIC image into RGBA pixels |
| `yuv420ToRgba(...)` | Convert planar 8-bit YCbCr 4:2:0 into RGBA |
| `applyOrientation(...)` | Apply HEIF rotation and mirror transforms |
| `parseISOBMFF(buffer)` | Walk the ISOBMFF box hierarchy |
| `getFtypInfo(buffer)` | Read the major and compatible file-type brands |
| `splitAnnexB(...)` / `splitLengthPrefixed(...)` | Split HEVC NAL units |
| `parseSps(...)` / `parsePps(...)` | Inspect HEVC parameter sets |
| `PictureDecoder` | Decode intra HEVC picture planes directly |

Additional container and HEVC primitives are exported for applications that need lower-level control.

## Correctness

The test suite uses real iPhone captures, including 8-tile and 48-tile grids. Decoder output is checked in several ways:

- Golden SHA-256 hashes pin reconstructed Y, Cb, and Cr planes before and after loop filtering.
- Tile reconstruction is bit-exact against libde265 for the tested captures.
- End-to-end RGBA output is compared with a ground-truth image using a 30 dB PSNR threshold; the current fixture decodes at roughly 47 dB.
- Container, color conversion, orientation, NAL splitting, CABAC, prediction, transforms, and malformed-input boundaries have focused regression tests.

Run the project checks locally:

```bash
bun install
bun test
bun run typecheck
bun run lint
bun run build
```

## Acknowledgements

The HEIF container groundwork was informed by the [`ts-avif`](https://github.com/stacksjs/ts-avif) project. HEIC and AVIF share the same HEIF/ISOBMFF container model while using different image codecs.

## License

MIT © Open Web Foundation. See [LICENSE.md](./LICENSE.md).
