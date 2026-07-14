/**
 * HEVC sequence parameter set parsing — the full SPS as far as the VUI colour
 * description, cross-checkable against the HEIF container's `ispe` values and
 * feeding the slice decoder (CTB geometry, transform sizes, scaling lists,
 * SAO, strong intra smoothing, colour matrix/range).
 */
import type { ScalingListData } from './scaling'
import { BitReader, toRbsp } from './nal'
import { defaultScalingListData, parseScalingListData } from './scaling'

export interface VuiColorInfo {
  videoFullRange: boolean
  colourPrimaries: number
  transferCharacteristics: number
  matrixCoeffs: number
}

export interface SpsInfo {
  spsId: number
  chromaFormatIdc: number
  /** Final display width/height after the conformance window crop. */
  width: number
  height: number
  /** Coded picture dimensions (multiples of the min CB size). */
  picWidthInLumaSamples: number
  picHeightInLumaSamples: number
  cropLeft: number
  cropRight: number
  cropTop: number
  cropBottom: number
  bitDepthLuma: number
  bitDepthChroma: number
  log2MaxPicOrderCntLsb: number
  log2MinLumaCodingBlockSize: number
  log2CtbSize: number
  log2MinTransformBlockSize: number
  log2MaxTransformBlockSize: number
  maxTransformHierarchyDepthIntra: number
  scalingListEnabled: boolean
  /** Populated when scaling lists are active (explicit or default). */
  scalingListData: ScalingListData | null
  ampEnabled: boolean
  sampleAdaptiveOffsetEnabled: boolean
  pcmEnabled: boolean
  pcmSampleBitDepthLuma: number
  pcmSampleBitDepthChroma: number
  log2MinPcmLumaCodingBlockSize: number
  log2MaxPcmLumaCodingBlockSize: number
  pcmLoopFilterDisabled: boolean
  strongIntraSmoothingEnabled: boolean
  numShortTermRefPicSets: number
  /** From the VUI video_signal_type, if present. */
  color: VuiColorInfo | null
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

/** Skip one st_ref_pic_set (7.3.7); still images carry none in practice. */
export function skipShortTermRefPicSet(r: BitReader, idx: number, numSets: number, numDeltaPocs: number[]): void {
  let interRpsPred = false
  if (idx !== 0)
    interRpsPred = r.readBit() === 1
  if (interRpsPred) {
    if (idx === numSets)
      r.ue() // delta_idx_minus1
    r.readBit() // delta_rps_sign
    r.ue() // abs_delta_rps_minus1
    const refDeltaPocs = numDeltaPocs[idx - 1] ?? 0
    let count = 0
    for (let j = 0; j <= refDeltaPocs; j++) {
      const usedByCurrPic = r.readBit() === 1
      let useDelta = true
      if (!usedByCurrPic)
        useDelta = r.readBit() === 1
      if (usedByCurrPic || useDelta)
        count++
    }
    numDeltaPocs[idx] = count
  }
  else {
    const numNegative = r.ue()
    const numPositive = r.ue()
    for (let j = 0; j < numNegative; j++) {
      r.ue() // delta_poc_s0_minus1
      r.readBit() // used_by_curr_pic_s0_flag
    }
    for (let j = 0; j < numPositive; j++) {
      r.ue() // delta_poc_s1_minus1
      r.readBit() // used_by_curr_pic_s1_flag
    }
    numDeltaPocs[idx] = numNegative + numPositive
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
let scalingListData: ScalingListData | null = null
if (scalingListEnabled) {
  scalingListData = r.readBit() === 1 // sps_scaling_list_data_present_flag
    ? parseScalingListData(r)
    : defaultScalingListData()
}

const ampEnabled = r.readBit() === 1
const sampleAdaptiveOffsetEnabled = r.readBit() === 1
const pcmEnabled = r.readBit() === 1
let pcmSampleBitDepthLuma = 0
let pcmSampleBitDepthChroma = 0
let log2MinPcmLumaCodingBlockSize = 0
let log2MaxPcmLumaCodingBlockSize = 0
let pcmLoopFilterDisabled = false
if (pcmEnabled) {
  pcmSampleBitDepthLuma = r.readBits(4) + 1
  pcmSampleBitDepthChroma = r.readBits(4) + 1
  log2MinPcmLumaCodingBlockSize = r.ue() + 3
  log2MaxPcmLumaCodingBlockSize = log2MinPcmLumaCodingBlockSize + r.ue()
  pcmLoopFilterDisabled = r.readBit() === 1
}

const numShortTermRefPicSets = r.ue()
const numDeltaPocs: number[] = []
for (let i = 0; i < numShortTermRefPicSets; i++)
  skipShortTermRefPicSet(r, i, numShortTermRefPicSets, numDeltaPocs)

if (r.readBit() === 1) { // long_term_ref_pics_present_flag
const numLongTerm = r.ue()
for (let i = 0; i < numLongTerm; i++) {
  r.readBits(log2MaxPicOrderCntLsb) // lt_ref_pic_poc_lsb_sps
  r.readBit() // used_by_curr_pic_lt_sps_flag
}
}

r.readBit() // sps_temporal_mvp_enabled_flag
const strongIntraSmoothingEnabled = r.readBit() === 1

let color: VuiColorInfo | null = null
if (r.readBit() === 1) { // vui_parameters_present_flag
if (r.readBit() === 1) { // aspect_ratio_info_present_flag
const aspectRatioIdc = r.readBits(8)
if (aspectRatioIdc === 255) {
  r.readBits(16) // sar_width
  r.readBits(16) // sar_height
}
}
if (r.readBit() === 1) // overscan_info_present_flag
  r.readBit() // overscan_appropriate_flag
if (r.readBit() === 1) { // video_signal_type_present_flag
r.readBits(3) // video_format
const videoFullRange = r.readBit() === 1
let colourPrimaries = 2
let transferCharacteristics = 2
let matrixCoeffs = 2
if (r.readBit() === 1) { // colour_description_present_flag
colourPrimaries = r.readBits(8)
transferCharacteristics = r.readBits(8)
matrixCoeffs = r.readBits(8)
}
color = { videoFullRange, colourPrimaries, transferCharacteristics, matrixCoeffs }
}
// Remaining VUI fields (chroma loc, timing, bitstream restrictions) are
// irrelevant to still-image decoding and left unread.
}

// SubWidthC/SubHeightC per chroma_format_idc (4:2:0 = 2/2, 4:2:2 = 2/1).
const subW = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1
const subH = chromaFormatIdc === 1 ? 2 : 1

const width = picWidthInLumaSamples - subW * (cropLeft + cropRight)
const height = picHeightInLumaSamples - subH * (cropTop + cropBottom)

return {
  spsId,
  chromaFormatIdc,
  width,
  height,
  picWidthInLumaSamples,
  picHeightInLumaSamples,
  cropLeft,
  cropRight,
  cropTop,
  cropBottom,
  bitDepthLuma,
  bitDepthChroma,
  log2MaxPicOrderCntLsb,
  log2MinLumaCodingBlockSize,
  log2CtbSize,
  log2MinTransformBlockSize,
  log2MaxTransformBlockSize,
  maxTransformHierarchyDepthIntra,
  scalingListEnabled,
  scalingListData,
  ampEnabled,
  sampleAdaptiveOffsetEnabled,
  pcmEnabled,
  pcmSampleBitDepthLuma,
  pcmSampleBitDepthChroma,
  log2MinPcmLumaCodingBlockSize,
  log2MaxPcmLumaCodingBlockSize,
  pcmLoopFilterDisabled,
  strongIntraSmoothingEnabled,
  numShortTermRefPicSets,
  color,
}
}
