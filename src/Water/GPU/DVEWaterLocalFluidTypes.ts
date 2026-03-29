export type WaterLocalFluidSolver = "off" | "pbf" | "mls-mpm";

export type WaterDisturbanceKind = "wake" | "impact" | "emitter" | "heavy-impact" | "actor-wade" | "object-splash";

export interface WaterDisturbanceEvent {
  kind: WaterDisturbanceKind;
  worldX: number;
  worldZ: number;
  radius: number;
  energy: number;
  velocityX?: number;
  velocityZ?: number;
  directionX?: number;
  directionZ?: number;
  mass?: number;
  duration?: number;
}

export interface WaterLocalFluidBudget {
  maxEmitters: number;
  maxImpactsPerFrame: number;
  maxWakesPerFrame: number;
  maxHeavyImpactsPerFrame: number;
  maxObjectSplashesPerFrame: number;
}

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
  applyDisturbances?(events: WaterDisturbanceEvent[]): void;
}

export function getPreferredWaterLocalFluidSolver(): WaterLocalFluidSolver {
  const configured = ((globalThis as any).__DVE_WATER_LOCAL_FLUID_SOLVER__ ?? "auto") as string;
  if (configured === "off" || configured === "pbf" || configured === "mls-mpm") {
    return configured;
  }
  return canUseWebGPU() ? "mls-mpm" : "pbf";
}