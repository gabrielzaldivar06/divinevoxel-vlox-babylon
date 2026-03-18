/**
 * SplatManager — Fase 3 Entregable 3.4, 3.6 + Fase 5 Entregable 5.4, 5.5, 5.7
 *
 * Coordinates DissolutionSplatEmitter → DVEGaussianSplatRenderer.
 * Hooks into MeshManager via the onSectionUpdated / onSectorRemoved
 * callbacks added to MeshManager. On each section mesh update, checks
 * whether the material is organic, emits splats, and registers them
 * with the renderer keyed by sector.
 *
 * Fase 5: Dynamic fracture splats with physics (gravity, velocity, fade).
 * Fracture events are enqueued via handleVoxelErased() and processed
 * through DynamicSplatPool with rate limiting.
 */
import { Scene } from "@babylonjs/core/scene";
import { DVEGaussianSplatRenderer } from "./DVEGaussianSplatRenderer";
import { SplatPhysics } from "./DissolutionSplatEmitter";
export interface SplatMeshUpdate {
    materialId: string;
    vertices: Float32Array;
    sectionOrigin: [number, number, number];
}
export declare class SplatManager {
    private _renderer;
    private _physicsOverrides;
    /** Track which section keys are active so we can clean up on sector remove */
    private _activeSections;
    /** Track atmospheric splat keys separately */
    private _activeAtmospheric;
    private _disposed;
    /** Fase 5: Dynamic fracture splat pool with physics. */
    private _dynamicPool;
    private _lastTime;
    constructor(scene: Scene);
    /** Register exact physics for a material (overrides family default). */
    registerPhysics(materialId: string, physics: SplatPhysics): void;
    /**
     * Called when a section mesh is created or updated.
     * Iterates the sub-meshes, emits splats for organic materials,
     * and registers them with the renderer.
     */
    processSectionMeshes(sectorKey: string, meshUpdates: SplatMeshUpdate[]): void;
    /**
     * Called when a sector is removed. Cleans up all splats for that sector.
     */
    removeSector(sectorKey: string): void;
    get renderer(): DVEGaussianSplatRenderer;
    /**
     * Fase 5: Handle a voxel erase event.
     * Generates fracture splats based on the material family + physics.
     *
     * @param x World X of destroyed voxel
     * @param y World Y of destroyed voxel
     * @param z World Z of destroyed voxel
     * @param family Material family string
     * @param shearStrength Physics shear strength
     * @param color RGB [0-255] color of the voxel
     */
    handleVoxelErased(x: number, y: number, z: number, family: string, shearStrength: number, color: [number, number, number]): void;
    dispose(): void;
}
