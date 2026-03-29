/**
 * Sprint 10 — Unified Continuum Controller
 * Manages adaptive LOD composition, evaporation/absorption,
 * terrain-reactive puddle spawning, and particle-to-puddle feedback.
 */

import type { DVEWaterHybridBridge } from "./DVEWaterHybridBridge.js";
import type { DVEShallowWaterRenderer } from "./DVEShallowWaterRenderer.js";

// ── Configuration ──────────────────────────────────────────
export interface WaterContinuumConfig {
  /** Enable terrain-reactive puddle formation in depressions */
  enableTerrainReactivePuddles: boolean;
  /** Evaporation rate multiplier (higher = faster dry) */
  evaporationRate: number;
  /** Minimum rain/splash energy to spawn a puddle */
  puddleSpawnThreshold: number;
  /** Maximum number of terrain-reactive puddle spawns per frame */
  maxPuddleSpawnsPerFrame: number;
  /** LOD distance thresholds [near, mid, far] in world units */
  lodDistances: [number, number, number];
  /** Enable particle-to-puddle feedback loop */
  enableParticleFeedback: boolean;
}

const DEFAULT_CONFIG: WaterContinuumConfig = {
  enableTerrainReactivePuddles: true,
  evaporationRate: 1.0,
  puddleSpawnThreshold: 0.05,
  maxPuddleSpawnsPerFrame: 4,
  lodDistances: [32, 64, 128],
  enableParticleFeedback: true,
};

// ── Pending puddle spawn ───────────────────────────────────
interface PuddleSpawnRequest {
  worldX: number;
  worldZ: number;
  terrainY: number;
  initialThickness: number;
  source: "rain" | "splash" | "overflow" | "terrain-depression";
}

// ── LOD level ──────────────────────────────────────────────
export type WaterLODLevel = "full" | "simplified" | "billboard" | "hidden";

// ── Controller ─────────────────────────────────────────────
export class DVEWaterContinuumController {
  private config: WaterContinuumConfig;
  private _pendingSpawns: PuddleSpawnRequest[] = [];
  private _evaporationAccum = 0;
  private _cameraX = 0;
  private _cameraZ = 0;

  constructor(
    private bridge: DVEWaterHybridBridge,
    private shallowRenderer: DVEShallowWaterRenderer | null,
    config?: Partial<WaterContinuumConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Configuration ────────────────────────────────────────
  setConfig(partial: Partial<WaterContinuumConfig>): void {
    Object.assign(this.config, partial);
  }
  getConfig(): Readonly<WaterContinuumConfig> {
    return this.config;
  }

  // ── Camera tracking for LOD ──────────────────────────────
  updateCamera(x: number, z: number): void {
    this._cameraX = x;
    this._cameraZ = z;
  }

  /** Compute LOD level for a given world position */
  getLODLevel(worldX: number, worldZ: number): WaterLODLevel {
    const dx = worldX - this._cameraX;
    const dz = worldZ - this._cameraZ;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const [near, mid, far] = this.config.lodDistances;
    if (dist < near) return "full";
    if (dist < mid) return "simplified";
    if (dist < far) return "billboard";
    return "hidden";
  }

  // ── Puddle spawn requests ────────────────────────────────
  /** Request a puddle spawn from particle impact or rain */
  requestPuddleSpawn(
    worldX: number,
    worldZ: number,
    terrainY: number,
    energy: number,
    source: PuddleSpawnRequest["source"] = "splash",
  ): void {
    if (!this.config.enableParticleFeedback && source === "splash") return;
    if (!this.config.enableTerrainReactivePuddles && source === "terrain-depression") return;
    if (energy < this.config.puddleSpawnThreshold) return;
    if (this._pendingSpawns.length >= this.config.maxPuddleSpawnsPerFrame) return;
    this._pendingSpawns.push({
      worldX,
      worldZ,
      terrainY,
      initialThickness: Math.min(energy * 0.1, 0.3),
      source,
    });
  }

  // ── Per-frame advance ────────────────────────────────────
  advance(dt: number): void {
    // Process pending puddle spawns → inject into shallow water system
    for (const spawn of this._pendingSpawns) {
      this.bridge.injectPuddleSpawn(
        spawn.worldX,
        spawn.worldZ,
        spawn.terrainY,
        spawn.initialThickness,
      );
    }
    this._pendingSpawns.length = 0;

    // Accumulate evaporation ticks
    this._evaporationAccum += dt * this.config.evaporationRate;
  }

  /** Get accumulated evaporation delta and reset. Called by shallow sim. */
  consumeEvaporationDelta(): number {
    const d = this._evaporationAccum;
    this._evaporationAccum = 0;
    return d;
  }

  dispose(): void {
    this._pendingSpawns.length = 0;
  }
}
