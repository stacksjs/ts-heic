/**
 * HEVC picture parameter set parsing — every field an intra still-image
 * decoder needs, including tile layout, WPP, cu_qp_delta, and deblocking
 * controls. Verified field-by-field against iPhone captures (which enable
 * entropy_coding_sync and cu_qp_delta, and disable tiles/sign-hiding).
 */
import type { ScalingListData } from './scaling'
import { BitReader, toRbsp } from './nal'
import { parseScalingListData } from './scaling'

export interface PpsInfo {
  ppsId: number
  spsId: number
  dependentSliceSegmentsEnabled: boolean
  outputFlagPresent: boolean
  numExtraSliceHeaderBits: number
  signDataHidingEnabled: boolean
  cabacInitPresent: boolean
  initQp: number
  constrainedIntraPred: boolean
  transformSkipEnabled: boolean
  cuQpDeltaEnabled: boolean
  diffCuQpDeltaDepth: number
  cbQpOffset: number
  crQpOffset: number
  sliceChromaQpOffsetsPresent: boolean
  transquantBypassEnabled: boolean
  tilesEnabled: boolean
  entropyCodingSyncEnabled: boolean
  numTileColumns: number
  numTileRows: number
  uniformSpacing: boolean
  tileColumnWidths: number[]
  tileRowHeights: number[]
  loopFilterAcrossTilesEnabled: boolean
  loopFilterAcrossSlicesEnabled: boolean
  deblockingFilterControlPresent: boolean
  deblockingFilterOverrideEnabled: boolean
  deblockingFilterDisabled: boolean
  betaOffsetDiv2: number
  tcOffsetDiv2: number
  scalingListDataPresent: boolean
  scalingListData: ScalingListData | null
  listsModificationPresent: boolean
  log2ParallelMergeLevel: number
  sliceSegmentHeaderExtensionPresent: boolean
}

/** Parse a PPS NAL unit (including its 2-byte NAL header). */
export function parsePps(nal: Uint8Array): PpsInfo {
  const r = new BitReader(toRbsp(nal))

  const ppsId = r.ue()
  const spsId = r.ue()
  const dependentSliceSegmentsEnabled = r.readBit() === 1
  const outputFlagPresent = r.readBit() === 1
  const numExtraSliceHeaderBits = r.readBits(3)
  const signDataHidingEnabled = r.readBit() === 1
  const cabacInitPresent = r.readBit() === 1
  r.ue() // num_ref_idx_l0_default_active_minus1
  r.ue() // num_ref_idx_l1_default_active_minus1
  const initQp = 26 + r.se()
  const constrainedIntraPred = r.readBit() === 1
  const transformSkipEnabled = r.readBit() === 1
  const cuQpDeltaEnabled = r.readBit() === 1
  const diffCuQpDeltaDepth = cuQpDeltaEnabled ? r.ue() : 0
  const cbQpOffset = r.se()
  const crQpOffset = r.se()
  const sliceChromaQpOffsetsPresent = r.readBit() === 1
  r.readBit() // weighted_pred_flag
  r.readBit() // weighted_bipred_flag
  const transquantBypassEnabled = r.readBit() === 1
  const tilesEnabled = r.readBit() === 1
  const entropyCodingSyncEnabled = r.readBit() === 1

  let numTileColumns = 1
  let numTileRows = 1
  let uniformSpacing = true
  const tileColumnWidths: number[] = []
  const tileRowHeights: number[] = []
  let loopFilterAcrossTilesEnabled = true
  if (tilesEnabled) {
    numTileColumns = r.ue() + 1
    numTileRows = r.ue() + 1
    uniformSpacing = r.readBit() === 1
    if (!uniformSpacing) {
      for (let i = 0; i < numTileColumns - 1; i++)
        tileColumnWidths.push(r.ue() + 1)
      for (let i = 0; i < numTileRows - 1; i++)
        tileRowHeights.push(r.ue() + 1)
    }
    loopFilterAcrossTilesEnabled = r.readBit() === 1
  }

  const loopFilterAcrossSlicesEnabled = r.readBit() === 1
  const deblockingFilterControlPresent = r.readBit() === 1
  let deblockingFilterOverrideEnabled = false
  let deblockingFilterDisabled = false
  let betaOffsetDiv2 = 0
  let tcOffsetDiv2 = 0
  if (deblockingFilterControlPresent) {
    deblockingFilterOverrideEnabled = r.readBit() === 1
    deblockingFilterDisabled = r.readBit() === 1
    if (!deblockingFilterDisabled) {
      betaOffsetDiv2 = r.se()
      tcOffsetDiv2 = r.se()
    }
  }

  const scalingListDataPresent = r.readBit() === 1
  const scalingListData = scalingListDataPresent ? parseScalingListData(r) : null

  const listsModificationPresent = r.readBit() === 1
  const log2ParallelMergeLevel = r.ue() + 2
  const sliceSegmentHeaderExtensionPresent = r.readBit() === 1
  // pps_extension_present_flag and beyond are ignored (range extensions).

  return {
    ppsId,
    spsId,
    dependentSliceSegmentsEnabled,
    outputFlagPresent,
    numExtraSliceHeaderBits,
    signDataHidingEnabled,
    cabacInitPresent,
    initQp,
    constrainedIntraPred,
    transformSkipEnabled,
    cuQpDeltaEnabled,
    diffCuQpDeltaDepth,
    cbQpOffset,
    crQpOffset,
    sliceChromaQpOffsetsPresent,
    transquantBypassEnabled,
    tilesEnabled,
    entropyCodingSyncEnabled,
    numTileColumns,
    numTileRows,
    uniformSpacing,
    tileColumnWidths,
    tileRowHeights,
    loopFilterAcrossTilesEnabled,
    loopFilterAcrossSlicesEnabled,
    deblockingFilterControlPresent,
    deblockingFilterOverrideEnabled,
    deblockingFilterDisabled,
    betaOffsetDiv2,
    tcOffsetDiv2,
    scalingListDataPresent,
    scalingListData,
    listsModificationPresent,
    log2ParallelMergeLevel,
    sliceSegmentHeaderExtensionPresent,
  }
}
