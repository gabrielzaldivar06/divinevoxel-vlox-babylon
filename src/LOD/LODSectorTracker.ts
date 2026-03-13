/**
 * LODSectorTracker — Fase 4
 *
 * Per-frame LOD state manager. Tracks the current LOD band of every
 * active sector, detects band transitions, and enqueues re-mesh
 * requests with rate limiting (max N re-meshes per frame).
 *
 * Also exposes per-sector morph alpha so the shader plugin can read it.
 */

import { LODBand, LOD_MAX_REMESH_PER_FRAME } from "./LODConstants";
import { calculateLODBand, initialBand } from "./LODBandCalculator";
import { WorldSpaces } from "@divinevoxel/vlox/World/WorldSpaces";
import { MeshRegister } from "@divinevoxel/vlox/Renderer/MeshRegister";

export interface SectorLODState {
  band: LODBand;
  /** Distance from camera center (updated every frame). */
  distance: number;
  /** Sector center world coordinates. */
  cx: number;
  cy: number;
  cz: number;
}

export type RemeshRequest = {
  dimensionId: number;
  x: number;
  y: number;
  z: number;
  targetBand: LODBand;
};

/**
 * Builds a composite key from sector position for the state map.
 */
function sectorKey(dimId: number, x: number, y: number, z: number): string {
  return `${dimId}_${x}_${y}_${z}`;
}

export class LODSectorTracker {
  /** Current LOD state per sector. */
  private _states = new Map<string, SectorLODState>();

  /** Queue of sectors that need re-meshing this frame (rate-limited). */
  private _remeshQueue: RemeshRequest[] = [];

  /** Callback to trigger a sector re-mesh at a particular LOD level. */
  onRemeshNeeded: ((request: RemeshRequest) => void) | null = null;

  /**
   * Call once per frame. Iterates all active sectors through MeshRegister,
   * computes LOD bands, and processes band transitions.
   *
   * @returns Number of re-mesh requests dispatched this frame.
   */
  update(camX: number, camY: number, camZ: number): number {
    const halfBoundsX = WorldSpaces.sector.bounds.x * 0.5;
    const halfBoundsY = WorldSpaces.sector.bounds.y * 0.5;
    const halfBoundsZ = WorldSpaces.sector.bounds.z * 0.5;

    const activeKeys = new Set<string>();

    for (const [dimId, dimension] of MeshRegister._dimensions) {
      for (const [, sector] of dimension) {
        const cx = sector.position[0] + halfBoundsX;
        const cy = sector.position[1] + halfBoundsY;
        const cz = sector.position[2] + halfBoundsZ;
        const key = sectorKey(
          dimId,
          sector.position[0],
          sector.position[1],
          sector.position[2]
        );
        activeKeys.add(key);

        let state = this._states.get(key);
        if (!state) {
          const dx = cx - camX;
          const dy = cy - camY;
          const dz = cz - camZ;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          state = {
            band: initialBand(dist),
            distance: dist,
            cx,
            cy,
            cz,
          };
          this._states.set(key, state);
          continue; // First frame: no transition needed
        }

        // Update center (sector doesn't move, but just be consistent)
        state.cx = cx;
        state.cy = cy;
        state.cz = cz;

        const previousBand = state.band;
        const newBand = calculateLODBand(
          cx,
          cy,
          cz,
          camX,
          camY,
          camZ,
          previousBand
        );

        // Update distance for morph factor queries
        const dx = cx - camX;
        const dy = cy - camY;
        const dz = cz - camZ;
        state.distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

        if (newBand !== previousBand) {
          state.band = newBand;

          // Only queue re-mesh when crossing a stable-band boundary
          // (transition bands use the same geometry with morph shader)
          const crossedStable = needsRemesh(previousBand, newBand);
          if (crossedStable) {
            this._remeshQueue.push({
              dimensionId: dimId,
              x: sector.position[0],
              y: sector.position[1],
              z: sector.position[2],
              targetBand: newBand,
            });
          }
        }
      }
    }

    // Prune removed sectors
    for (const key of this._states.keys()) {
      if (!activeKeys.has(key)) {
        this._states.delete(key);
      }
    }

    // Dispatch rate-limited re-meshes
    let dispatched = 0;
    while (
      this._remeshQueue.length > 0 &&
      dispatched < LOD_MAX_REMESH_PER_FRAME
    ) {
      const request = this._remeshQueue.shift()!;
      if (this.onRemeshNeeded) {
        this.onRemeshNeeded(request);
      }
      dispatched++;
    }

    return dispatched;
  }

  /**
   * Get the current LOD band for a sector.
   */
  getBand(dimId: number, x: number, y: number, z: number): LODBand {
    const state = this._states.get(sectorKey(dimId, x, y, z));
    return state ? state.band : LODBand.Far;
  }

  /**
   * Get the distance from camera for a sector.
   */
  getDistance(dimId: number, x: number, y: number, z: number): number {
    const state = this._states.get(sectorKey(dimId, x, y, z));
    return state ? state.distance : Infinity;
  }

  /**
   * Number of pending re-mesh requests waiting in queue.
   */
  get pendingRemeshCount(): number {
    return this._remeshQueue.length;
  }

  dispose() {
    this._states.clear();
    this._remeshQueue.length = 0;
    this.onRemeshNeeded = null;
  }
}

/**
 * Determine whether a band transition requires a geometry re-mesh.
 * Transitions between stable bands (Near↔Mid, Mid↔Far) need it.
 * Moving within transition bands does NOT need re-mesh (shader handles it).
 */
function needsRemesh(from: LODBand, to: LODBand): boolean {
  // Re-mesh when entering or leaving a stable band
  // Near→TransitionNM: no (transition shader handles)
  // TransitionNM→Mid: YES (subdivision level changes)
  // Mid→TransitionMF: no
  // TransitionMF→Far: YES
  // And the reverse directions
  if (from === LODBand.TransitionNearMid && to === LODBand.Mid) return true;
  if (from === LODBand.Mid && to === LODBand.TransitionNearMid) return true;
  if (from === LODBand.TransitionMidFar && to === LODBand.Far) return true;
  if (from === LODBand.Far && to === LODBand.TransitionMidFar) return true;
  return false;
}
