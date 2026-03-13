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

const DEFAULT_POOL_SIZE = 500;

export class DynamicSplatPool {
  private _pool: DynamicSplatInstance[];
  private _activeCount = 0;
  /** Rate limit: max fracture events per frame. */
  private _pendingEmissions: DynamicSplatInstance[][] = [];
  private _maxEmissionsPerFrame = 1;

  constructor(poolSize: number = DEFAULT_POOL_SIZE) {
    this._pool = new Array(poolSize);
    for (let i = 0; i < poolSize; i++) {
      this._pool[i] = this._createEmpty();
    }
  }

  private _createEmpty(): DynamicSplatInstance {
    return {
      position: [0, 0, 0],
      scale: 0,
      opacity: 0,
      color: [0, 0, 0],
      shape: 0,
      velocity: [0, 0, 0],
      lifetime: 0,
      age: 0,
      gravity: 0,
      baseOpacity: 0,
    };
  }

  /**
   * Enqueue a batch of fracture splats. They'll be activated
   * on the next update (rate-limited to avoid CPU spikes).
   */
  enqueue(splats: DynamicSplatInstance[]) {
    this._pendingEmissions.push(splats);
  }

  /**
   * Update physics for all active splats and process pending emissions.
   * Call once per frame.
   *
   * @param dt Delta time in seconds
   * @returns Array of SplatInstance for rendering (alive only)
   */
  update(dt: number): SplatInstance[] {
    // Process pending emissions (rate-limited)
    let emissionsThisFrame = 0;
    while (
      this._pendingEmissions.length > 0 &&
      emissionsThisFrame < this._maxEmissionsPerFrame
    ) {
      const batch = this._pendingEmissions.shift()!;
      this._activateBatch(batch);
      emissionsThisFrame++;
    }

    // Physics update for active splats
    const result: SplatInstance[] = [];
    let writeIdx = 0;

    for (let i = 0; i < this._activeCount; i++) {
      const s = this._pool[i];
      s.age += dt;

      if (s.age >= s.lifetime) {
        // Expired — swap with last active, don't increment writeIdx
        this._activeCount--;
        if (i < this._activeCount) {
          this._copySlot(this._pool[this._activeCount], this._pool[i]);
          this._resetSlot(this._pool[this._activeCount]);
          i--; // Re-check swapped element
        }
        continue;
      }

      // Apply gravity
      s.velocity[1] -= s.gravity * dt;

      // Integrate position
      s.position[0] += s.velocity[0] * dt;
      s.position[1] += s.velocity[1] * dt;
      s.position[2] += s.velocity[2] * dt;

      // Fade opacity: linear fade-out in last 40% of lifetime
      const lifeRatio = s.age / s.lifetime;
      if (lifeRatio > 0.6) {
        s.opacity = s.baseOpacity * (1 - (lifeRatio - 0.6) / 0.4);
      }

      // Collect for rendering
      result.push({
        position: [s.position[0], s.position[1], s.position[2]],
        scale: s.scale,
        opacity: Math.max(0, s.opacity),
        color: [s.color[0], s.color[1], s.color[2]],
        shape: s.shape,
      });

      writeIdx++;
    }

    return result;
  }

  private _activateBatch(splats: DynamicSplatInstance[]) {
    for (const src of splats) {
      if (this._activeCount >= this._pool.length) break;
      this._copyFrom(src, this._pool[this._activeCount]);
      this._activeCount++;
    }
  }

  private _copyFrom(src: DynamicSplatInstance, dst: DynamicSplatInstance) {
    dst.position[0] = src.position[0];
    dst.position[1] = src.position[1];
    dst.position[2] = src.position[2];
    dst.scale = src.scale;
    dst.opacity = src.opacity;
    dst.color[0] = src.color[0];
    dst.color[1] = src.color[1];
    dst.color[2] = src.color[2];
    dst.shape = src.shape;
    dst.velocity[0] = src.velocity[0];
    dst.velocity[1] = src.velocity[1];
    dst.velocity[2] = src.velocity[2];
    dst.lifetime = src.lifetime;
    dst.age = src.age;
    dst.gravity = src.gravity;
    dst.baseOpacity = src.baseOpacity;
  }

  private _copySlot(src: DynamicSplatInstance, dst: DynamicSplatInstance) {
    this._copyFrom(src, dst);
  }

  private _resetSlot(slot: DynamicSplatInstance) {
    slot.opacity = 0;
    slot.age = 0;
    slot.lifetime = 0;
  }

  get activeCount(): number {
    return this._activeCount;
  }

  get pendingCount(): number {
    return this._pendingEmissions.length;
  }

  dispose() {
    this._activeCount = 0;
    this._pendingEmissions.length = 0;
  }
}
