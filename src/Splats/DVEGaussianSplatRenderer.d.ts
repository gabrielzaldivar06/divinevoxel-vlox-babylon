/**
 * DVEGaussianSplatRenderer — Fase 3 Entregable 3.3, 3.7
 *
 * Evolved from DVEGaussianSplatProto: sector-keyed static splat management,
 * dynamic splat placeholder (Fase 5), pool management with pre-allocated
 * Float32Array, and material-family shape variation in the fragment shader.
 *
 * Integration: runs ALONGSIDE the normal voxel pipeline.
 * Uses Thin Instances of a single master quad for GPU throughput.
 */
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Meshes/thinInstanceMesh";
export interface SplatInstance {
    /** World-space position [x, y, z] */
    position: [number, number, number];
    /** World-space radius */
    scale: number;
    /** Peak opacity 0..1 */
    opacity: number;
    /** RGB color [0..255, 0..255, 0..255] */
    color: [number, number, number];
    /** Shape: 0 circular, 1 irregular, 2 angular, 3 elongated, 4 blade (R18) */
    shape: number;
    /** G03: Surface normal [x,y,z] — used for per-splat N·L lighting. Default [0,1,0]. */
    normal?: [number, number, number];
}
export declare class DVEGaussianSplatRenderer {
    private _scene;
    private _maxSplats;
    private _masterQuad;
    private _material;
    private _matrixBuffer;
    private _splatBuffer;
    /** G03: Per-instance octahedral-encoded splat normal (2 floats each) */
    private _normalBuffer;
    private _totalInstanceCount;
    private _dirty;
    /** Sector key → static SplatInstance[] */
    private _staticSplats;
    /** Dynamic splats (Fase 5 placeholder) */
    private _dynamicSplats;
    /** Distance fade near/far thresholds. */
    private _fadeNear;
    private _fadeFar;
    constructor(_scene: Scene, _maxSplats?: number);
    private _registerShaders;
    private _createMaterial;
    private _createMasterQuad;
    private _packColor;
    private _encodeOctahedral;
    addStaticSplats(sectorKey: string, splats: SplatInstance[]): void;
    removeStaticSplats(sectorKey: string): void;
    hasStaticSplats(sectorKey: string): boolean;
    addDynamicSplats(splats: SplatInstance[]): void;
    clearDynamicSplats(): void;
    /**
     * Call once per frame. Rebuilds instance buffers only when dirty.
     */
    update(): void;
    get totalSplats(): number;
    /** Set distance thresholds for splat fade (default: 40, 90). */
    setFadeDistances(near: number, far: number): void;
    dispose(): void;
}
