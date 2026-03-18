/**
 * LODSectorTracker — Fase 4
 *
 * Per-frame LOD state manager. Tracks the current LOD band of every
 * active sector, detects band transitions, and enqueues re-mesh
 * requests with rate limiting (max N re-meshes per frame).
 *
 * Also exposes per-sector morph alpha so the shader plugin can read it.
 */
import { LODBand } from "./LODConstants";
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
export declare class LODSectorTracker {
    /** Current LOD state per sector. */
    private _states;
    /** Queue of sectors that need re-meshing this frame (rate-limited). */
    private _remeshQueue;
    /** Callback to trigger a sector re-mesh at a particular LOD level. */
    onRemeshNeeded: ((request: RemeshRequest) => void) | null;
    /**
     * Call once per frame. Iterates all active sectors through MeshRegister,
     * computes LOD bands, and processes band transitions.
     *
     * @returns Number of re-mesh requests dispatched this frame.
     */
    update(camX: number, camY: number, camZ: number): number;
    /**
     * Get the current LOD band for a sector.
     */
    getBand(dimId: number, x: number, y: number, z: number): LODBand;
    /**
     * Get the distance from camera for a sector.
     */
    getDistance(dimId: number, x: number, y: number, z: number): number;
    /**
     * Number of pending re-mesh requests waiting in queue.
     */
    get pendingRemeshCount(): number;
    dispose(): void;
}
