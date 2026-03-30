import { readWaterPatchSummaryEntry } from "@divinevoxel/vlox/Water/Types/WaterPatchSummaryContract.js";
import type { WaterSectionGPUData } from "@divinevoxel/vlox/Water/Types/WaterTypes.js";

const UNKNOWN_SHORE_DISTANCE = 0xff;

export interface HybridBridgeContinuousSectionInput {
  key: string;
  originX: number;
  originZ: number;
  boundsX: number;
  boundsZ: number;
  paddedBoundsX: number;
  paddedBoundsZ: number;
  gpuData: WaterSectionGPUData;
}

export interface HybridBridgeShallowSectionInput {
  key: string;
  originX: number;
  originZ: number;
  sizeX: number;
  sizeZ: number;
  columnBuffer: Float32Array;
  columnStride: number;
  columnMetadata: Uint32Array;
}

export interface HybridBridgeContinuousColumnView {
  filled: boolean;
  fill: number;
  flowX: number;
  flowZ: number;
  flowStrength: number;
  turbulence: number;
  shoreFactor: number;
  interaction: number;
  largeBody: number;
  patchSummary: ReturnType<typeof readWaterPatchSummaryEntry> | null;
}

export interface HybridBridgeShallowColumnView {
  active: boolean;
  thickness: number;
  spreadVX: number;
  spreadVZ: number;
  shoreDistance: number;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

export function decodeBridgeShoreDistance(metadata: number) {
  const shoreDistance = (metadata >>> 16) & 0xff;
  return shoreDistance === UNKNOWN_SHORE_DISTANCE ? -1 : shoreDistance;
}

function sampleSectionScalarField(
  field: Float32Array,
  size: number,
  boundsX: number,
  boundsZ: number,
  localX: number,
  localZ: number,
) {
  if (!field || field.length === 0 || size <= 0) {
    return 0;
  }
  const fx = clamp01((localX + 0.5) / Math.max(boundsX, 1)) * (size - 1);
  const fz = clamp01((localZ + 0.5) / Math.max(boundsZ, 1)) * (size - 1);
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const x1 = Math.min(size - 1, x0 + 1);
  const z1 = Math.min(size - 1, z0 + 1);
  const tx = fx - x0;
  const tz = fz - z0;
  const v00 = field[x0 * size + z0] ?? 0;
  const v10 = field[x1 * size + z0] ?? 0;
  const v01 = field[x0 * size + z1] ?? 0;
  const v11 = field[x1 * size + z1] ?? 0;
  const north = v00 + (v10 - v00) * tx;
  const south = v01 + (v11 - v01) * tx;
  return clamp01(north + (south - north) * tz);
}

function getPaddedIndex(section: HybridBridgeContinuousSectionInput, localX: number, localZ: number) {
  const paddedRadiusX = Math.max(0, Math.floor((section.paddedBoundsX - section.boundsX) * 0.5));
  const paddedRadiusZ = Math.max(0, Math.floor((section.paddedBoundsZ - section.boundsZ) * 0.5));
  return (localX + paddedRadiusX) * section.paddedBoundsZ + (localZ + paddedRadiusZ);
}

function sampleContinuity(section: HybridBridgeContinuousSectionInput, localX: number, localZ: number) {
  const stride = section.gpuData.paddedColumnStride;
  let fill = 0;
  let flowX = 0;
  let flowZ = 0;
  let flowStrength = 0;
  let turbulence = 0;
  let shoreFactor = 0;
  let samples = 0;

  for (let offsetX = -1; offsetX <= 1; offsetX++) {
    for (let offsetZ = -1; offsetZ <= 1; offsetZ++) {
      const paddedX = localX + offsetX;
      const paddedZ = localZ + offsetZ;
      const paddedIndex = getPaddedIndex(section, paddedX, paddedZ);
      if (paddedIndex < 0 || paddedIndex >= section.gpuData.paddedColumnMetadata.length) continue;
      const metadata = section.gpuData.paddedColumnMetadata[paddedIndex] ?? 0;
      const filled = (metadata & 0x1) === 1;
      if (!filled) continue;

      const dataIndex = paddedIndex * stride;
      fill += clamp01(section.gpuData.paddedColumnBuffer[dataIndex + 2] ?? 0);
      flowX += section.gpuData.paddedColumnBuffer[dataIndex + 3] ?? 0;
      flowZ += section.gpuData.paddedColumnBuffer[dataIndex + 4] ?? 0;
      flowStrength += clamp01(section.gpuData.paddedColumnBuffer[dataIndex + 5] ?? 0);
      turbulence += clamp01(section.gpuData.paddedColumnBuffer[dataIndex + 7] ?? 0);
      const shoreDistance = decodeBridgeShoreDistance(metadata);
      shoreFactor += shoreDistance < 0 ? 1 : clamp01(1 - Math.min(shoreDistance, 8) / 8);
      samples += 1;
    }
  }

  if (samples === 0) {
    return null;
  }

  return {
    fill: fill / samples,
    flowX: flowX / samples,
    flowZ: flowZ / samples,
    flowStrength: flowStrength / samples,
    turbulence: turbulence / samples,
    shoreFactor: shoreFactor / samples,
  };
}

function getColumnPatchSummary(
  section: HybridBridgeContinuousSectionInput,
  columnIndex: number,
) {
  const lookup = section.gpuData.columnPatchIndex[columnIndex] ?? 0;
  if (lookup <= 0) {
    return null;
  }
  const patchIndex = lookup - 1;
  if (patchIndex < 0 || patchIndex >= section.gpuData.patchSummaryCount) {
    return null;
  }
  return readWaterPatchSummaryEntry(
    section.gpuData.patchSummaryBuffer,
    section.gpuData.patchSummaryStride,
    section.gpuData.patchMetadata,
    section.gpuData.patchSummaryCount,
    patchIndex,
  );
}

export function readHybridContinuousColumn(
  section: HybridBridgeContinuousSectionInput,
  localX: number,
  localZ: number,
): HybridBridgeContinuousColumnView {
  const index = localX * section.boundsZ + localZ;
  const stride = section.gpuData.columnStride;
  const dataIndex = index * stride;
  const metadata = section.gpuData.columnMetadata[index] ?? 0;
  const filled = (metadata & 0x1) === 1;

  if (!filled) {
    return {
      filled: false,
      fill: 0,
      flowX: 0,
      flowZ: 0,
      flowStrength: 0,
      turbulence: 0,
      shoreFactor: 0,
      interaction: 0,
      largeBody: 0,
      patchSummary: null,
    };
  }

  const continuity = sampleContinuity(section, localX, localZ);
  const shoreDistance = decodeBridgeShoreDistance(metadata);
  return {
    filled: true,
    fill: continuity?.fill ?? clamp01(section.gpuData.columnBuffer[dataIndex + 2] ?? 0),
    flowX: continuity?.flowX ?? section.gpuData.columnBuffer[dataIndex + 3] ?? 0,
    flowZ: continuity?.flowZ ?? section.gpuData.columnBuffer[dataIndex + 4] ?? 0,
    flowStrength:
      continuity?.flowStrength ?? clamp01(section.gpuData.columnBuffer[dataIndex + 5] ?? 0),
    turbulence:
      continuity?.turbulence ?? clamp01(section.gpuData.columnBuffer[dataIndex + 7] ?? 0),
    shoreFactor:
      continuity?.shoreFactor ??
      (shoreDistance < 0 ? 1 : clamp01(1 - Math.min(shoreDistance, 8) / 8)),
    interaction: sampleSectionScalarField(
      section.gpuData.interactionField,
      section.gpuData.interactionFieldSize,
      section.boundsX,
      section.boundsZ,
      localX,
      localZ,
    ),
    largeBody: sampleSectionScalarField(
      section.gpuData.largeBodyField,
      section.gpuData.largeBodyFieldSize,
      section.boundsX,
      section.boundsZ,
      localX,
      localZ,
    ),
    patchSummary: getColumnPatchSummary(section, index),
  };
}

export function readHybridShallowColumn(
  section: HybridBridgeShallowSectionInput,
  localX: number,
  localZ: number,
): HybridBridgeShallowColumnView {
  const columnIndex = localX * section.sizeZ + localZ;
  const base = columnIndex * section.columnStride;
  const metadata = section.columnMetadata[columnIndex] ?? 0;
  const active = (metadata & 0x1) !== 0;

  return {
    active,
    thickness: section.columnBuffer[base + 0] ?? 0,
    spreadVX: section.columnBuffer[base + 3] ?? 0,
    spreadVZ: section.columnBuffer[base + 4] ?? 0,
    shoreDistance: section.columnBuffer[base + 9] ?? 0,
  };
}