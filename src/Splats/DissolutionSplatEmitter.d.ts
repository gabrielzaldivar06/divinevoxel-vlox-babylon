/**
 * DissolutionSplatEmitter — Fase 3 Entregable 3.1, 3.2, 3.5, 3.8
 *
 * Scans a section's vertex buffer (stride 28) for sub-vertices with high
 * dissolutionProximity (padding[3] > threshold). For each candidate it emits
 * a SplatInstance that inherits the texel color at that UV position,
 * is sized by porosity, and faded by proximity.
 *
 * Physics-driven spread: adhesion controls extra splats beyond the voxel
 * edge. Drip splats: for adhesion > 0.7 on downward faces, vertical chains
 * of splats simulate goteo.
 */
import { SplatInstance } from "./DVEGaussianSplatRenderer";
/** Per-material physics data needed for splat emission. */
export interface SplatPhysics {
    adhesion: number;
    porosity: number;
    shearStrength: number;
}
export declare function setAtlasSource(canvas: HTMLCanvasElement): void;
export interface EmitOptions {
    /** World-space offset for the section (location x, y, z). */
    sectionOrigin: [number, number, number];
    /** Material string id (e.g. "dve_dirt"). */
    materialId: string;
    /** Per-material physics. Null → skip physics-driven spread / drip. */
    physics: SplatPhysics | null;
}
/**
 * Emit splats from a vertex buffer.
 * Returns an array of SplatInstance capped at MAX_SPLATS_PER_SECTION.
 */
export declare function emitDissolutionSplats(vertices: Float32Array, options: EmitOptions): SplatInstance[];
/**
 * R12: Collect the top-N highest-erosion world positions from a vertex buffer.
 * Used by ErosionParticleEmitter to spawn ambient dust at active erosion zones.
 * @param vertices - Section vertex buffer (stride 28)
 * @param sectionOrigin - World-space offset [x, y, z]
 * @param maxCount - Maximum positions to return (default 30)
 */
export declare function getHighErosionPositions(vertices: Float32Array, sectionOrigin: [number, number, number], maxCount?: number): [number, number, number][];
