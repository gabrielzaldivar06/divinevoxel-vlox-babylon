export type WaterLocalFluidSolver = "off" | "pbf" | "mls-mpm";

export interface WaterLocalFluidSectionRecord {
  originX: number;
  originZ: number;
  boundsX: number;
  boundsZ: number;
  particleSeedBuffer: Float32Array;
  particleSeedStride: number;
  particleSeedCount: number;
  interactionField?: Float32Array;
  interactionFieldSize?: number;
}

function canUseWebGPU() {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

export interface WaterLocalFluidBackend {
  ready: boolean;
  velocityXField: Float32Array;
  velocityZField: Float32Array;
  fillContribField: Float32Array;
  foamContribField: Float32Array;
  init(): Promise<boolean>;
  onClipMoved(clipOriginX: number, clipOriginZ: number): void;
  registerSection(record: WaterLocalFluidSectionRecord): void;
  clearSections(): void;
  dispose(): void;
}

export function getPreferredWaterLocalFluidSolver(): WaterLocalFluidSolver {
  const configured = ((globalThis as any).__DVE_WATER_LOCAL_FLUID_SOLVER__ ?? "auto") as string;
  if (configured === "off" || configured === "pbf" || configured === "mls-mpm") {
    return configured;
  }
  return canUseWebGPU() ? "mls-mpm" : "pbf";
}