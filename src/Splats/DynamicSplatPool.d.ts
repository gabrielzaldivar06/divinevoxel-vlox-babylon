/**
 * DynamicSplatPool — Fase 5 Entregable 5.6
 *
 * Pre-allocated pool of dynamic splat instances with physics.
 * Zero allocations post-init. Expired splats are recycled.
 *
 * Each frame: update physics (gravity, position, opacity fade),
 * collect alive splats for rendering.
 */
import { SplatInstance } from "./DVEGaussianSplatRenderer";
import { DynamicSplatInstance } from "./FractureSplatEmitter";
export declare class DynamicSplatPool {
    private _pool;
    private _activeCount;
    /** Rate limit: max fracture events per frame. */
    private _pendingEmissions;
    private _maxEmissionsPerFrame;
    constructor(poolSize?: number);
    private _createEmpty;
    /**
     * Enqueue a batch of fracture splats. They'll be activated
     * on the next update (rate-limited to avoid CPU spikes).
     */
    enqueue(splats: DynamicSplatInstance[]): void;
    /**
     * Update physics for all active splats and process pending emissions.
     * Call once per frame.
     *
     * @param dt Delta time in seconds
     * @returns Array of SplatInstance for rendering (alive only)
     */
    update(dt: number): SplatInstance[];
    private _activateBatch;
    private _copyFrom;
    private _copySlot;
    private _resetSlot;
    get activeCount(): number;
    get pendingCount(): number;
    dispose(): void;
}
