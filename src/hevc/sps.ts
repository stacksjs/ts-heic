/**
 * HEVC sequence parameter set parsing — enough of the SPS to recover the
 * coded picture dimensions, chroma format, and bit depths, cross-checkable
 * against the HEIF container's `ispe` values.
 */
import { BitReader, toRbsp } from './nal'

export interface SpsInfo {
  spsId: number
  chromaFormatIdc: number
  /** Final display width/height after the conformance window crop. */
  width: number
  height: number
  bitDepthLuma: number
  bitDepthChroma: number
  log2MaxPicOrderCntLsb: number
  log2MinLumaCodingBlockSize: number
  log2CtbSize: number
  log2MinTransformBlockSize: number
  log2MaxTransformBlockSize: number
  maxTransformHierarchyDepthIntra: number
  scalingListEnabled: boolean
  ampEnabled: boolean
  sampleAdaptiveOffsetEnabled: boolean
  pcmEnabled: boolean
  strongIntraSmoothingEnabled: boolean
}

/** Skip the fixed-size profile_tier_level structure. */
function skipProfileTierLevel(r: BitReader, maxSubLayersMinus1: number): void {
  r.readBits(2) // general_profile_space
  r.readBit() // general_tier_flag
  r.readBits(5) // general_profile_idc
  r.readBits(32) // general_profile_compatibility_flags
  r.readBits(32) // general constraint flags (part 1)
  r.readBits(16) // general constraint flags (part 2)
  r.readBits(8) // general_level_idc

  const subLayerProfilePresent: boolean[] = []
  const subLayerLevelPresent: boolean[] = []
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    subLayerProfilePresent.push(r.readBit() === 1)
    subLayerLevelPresent.push(r.readBit() === 1)
  }
  if (maxSubLayersMinus1 > 0) {
    for (let i = maxSubLayersMinus1; i < 8; i++)
      r.readBits(2) // reserved_zero_2bits
  }
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (subLayerProfilePresent[i]) {
      r.readBits(32)
      r.readBits(32)
      r.readBits(24)
    }
    if (subLayerLevelPresent[i])
      r.readBits(8)
  }
}

/** Parse an SPS NAL unit (including its 2-byte NAL header). */
export function parseSps(nal: Uint8Array): SpsInfo {
  const r = new BitReader(toRbsp(nal))

  r.readBits(4) // sps_video_parameter_set_id
  const maxSubLayersMinus1 = r.readBits(3)
  r.readBit() // sps_temporal_id_nesting_flag
  skipProfileTierLevel(r, maxSubLayersMinus1)

  const spsId = r.ue()
  const chromaFormatIdc = r.ue()
  if (chromaFormatIdc === 3)
    r.readBit() // separate_colour_plane_flag

  const picWidthInLumaSamples = r.ue()
  const picHeightInLumaSamples = r.ue()

  let cropLeft = 0
  let cropRight = 0
  let cropTop = 0
  let cropBottom = 0
  if (r.readBit() === 1) { // conformance_window_flag
    cropLeft = r.ue()
    cropRight = r.ue()
    cropTop = r.ue()
    cropBottom = r.ue()
  }

  const bitDepthLuma = r.ue() + 8
  const bitDepthChroma = r.ue() + 8
  const log2MaxPicOrderCntLsb = r.ue() + 4

  const subLayerOrderingPresent = r.readBit() === 1
  const first = subLayerOrderingPresent ? 0 : maxSubLayersMinus1
  for (let i = first; i <= maxSubLayersMinus1; i++) {
    r.ue() // sps_max_dec_pic_buffering_minus1
    r.ue() // sps_max_num_reorder_pics
    r.ue() // sps_max_latency_increase_plus1
  }

  const log2MinLumaCodingBlockSize = r.ue() + 3
  const log2CtbSize = log2MinLumaCodingBlockSize + r.ue()
  const log2MinTransformBlockSize = r.ue() + 2
  const log2MaxTransformBlockSize = log2MinTransformBlockSize + r.ue()
  r.ue() // max_transform_hierarchy_depth_inter
  const maxTransformHierarchyDepthIntra = r.ue()

  const scalingListEnabled = r.readBit() === 1
  if (scalingListEnabled && r.readBit() === 1) {
    // sps_scaling_list_data_present: skip scaling_list_data
    for (let sizeId = 0; sizeId < 4; sizeId++) {
      for (let matrixId = 0; matrixId < 6; matrixId += (sizeId === 3 ? 3 : 1)) {
        if (r.readBit() === 0) { // scaling_list_pred_mode_flag
          r.ue() // scaling_list_pred_matrix_id_delta
        }
        else {
          const coefNum = Math.min(64, 1 << (4 + (sizeId << 1)))
          if (sizeId > 1)
            r.se() // scaling_list_dc_coef_minus8
          for (let i = 0; i < coefNum; i++)
            r.se() // scaling_list_delta_coef
        }
      }
    }
  }

  const ampEnabled = r.readBit() === 1
  const sampleAdaptiveOffsetEnabled = r.readBit() === 1
  const pcmEnabled = r.readBit() === 1
  if (pcmEnabled) {
    r.readBits(4) // pcm_sample_bit_depth_luma_minus1
    r.readBits(4) // pcm_sample_bit_depth_chroma_minus1
    r.ue() // log2_min_pcm_luma_coding_block_size_minus3
    r.ue() // log2_diff_max_min_pcm_luma_coding_block_size
    r.readBit() // pcm_loop_filter_disabled_flag
  }

  const numShortTermRefPicSets = r.ue()
  // Still images (IDR-only) carry zero short-term ref pic sets; parsing the
  // general case isn't needed to recover dimensions and is left to the slice
  // decoder work.

  // SubWidthC/SubHeightC per chroma_format_idc (4:2:0 = 2/2, 4:2:2 = 2/1).
  const subW = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1
  const subH = chromaFormatIdc === 1 ? 2 : 1

  void numShortTermRefPicSets

  const width = picWidthInLumaSamples - subW * (cropLeft + cropRight)
  const height = picHeightInLumaSamples - subH * (cropTop + cropBottom)

  const strongIntraSmoothingEnabled = false // parsed later in the full decoder

  return {
    spsId,
    chromaFormatIdc,
    width,
    height,
    bitDepthLuma,
    bitDepthChroma,
    log2MaxPicOrderCntLsb,
    log2MinLumaCodingBlockSize,
    log2CtbSize,
    log2MinTransformBlockSize,
    log2MaxTransformBlockSize,
    maxTransformHierarchyDepthIntra,
    scalingListEnabled,
    ampEnabled,
    sampleAdaptiveOffsetEnabled,
    pcmEnabled,
    strongIntraSmoothingEnabled,
  }
}
