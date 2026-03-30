import { DVEWaterGPUSimulation } from "./DVEWaterGPUSimulation.js";
import { DVEWaterPBFSimulation } from "./DVEWaterPBFSimulation.js";
import {
  getPreferredWaterLocalFluidSolver,
  type WaterDisturbanceEvent,
  type WaterLocalFluidBackend,
  type WaterLocalFluidBudget,
  type WaterLocalFluidSectionRecord,
  type WaterLocalFluidSolver,
} from "./DVEWaterLocalFluidTypes.js";

export type { WaterDisturbanceEvent, WaterLocalFluidBudget };

export class DVEWaterLocalFluidSystem implements WaterLocalFluidBackend {
  ready = false;
  private readonly emptyField = new Float32Array(256 * 256);

  private backend: WaterLocalFluidBackend | null = null;
  private solver: WaterLocalFluidSolver;

  private _budget: WaterLocalFluidBudget = {
    maxEmitters: 8,
    maxImpactsPerFrame: 4,
    maxWakesPerFrame: 4,
    maxHeavyImpactsPerFrame: 2,
    maxObjectSplashesPerFrame: 4,
  };
  private _emitters = new Map<string, WaterDisturbanceEvent>();
  private _pendingImpacts: WaterDisturbanceEvent[] = [];
  private _pendingWakes: WaterDisturbanceEvent[] = [];

  get velocityXField() {
    return this.backend?.velocityXField ?? this.emptyField;
  }

  get hasFreshContributions() {
    return this.backend?.hasFreshContributions ?? false;
  }

  get velocityZField() {
    return this.backend?.velocityZField ?? this.emptyField;
  }

  get fillContribField() {
    return this.backend?.fillContribField ?? this.emptyField;
  }

  get foamContribField() {
    return this.backend?.foamContribField ?? this.emptyField;
  }

  constructor(solver: WaterLocalFluidSolver = getPreferredWaterLocalFluidSolver()) {
    this.solver = solver;
  }

  async init(): Promise<boolean> {
    if (this.solver === "off") {
      this.ready = false;
      return false;
    }
    this.backend = this.solver === "mls-mpm" ? new DVEWaterGPUSimulation() : new DVEWaterPBFSimulation();
    const ok = await this.backend.init();
    if (!ok) {
      if (this.solver === "pbf") {
        this.backend.dispose();
        this.backend = null;
        this.ready = false;
        return false;
      }
      this.backend.dispose();
      this.solver = "pbf";
      this.backend = new DVEWaterPBFSimulation();
      const pbfOk = await this.backend.init();
      if (!pbfOk) {
        this.backend.dispose();
        this.backend = null;
        this.ready = false;
        return false;
      }
    }
    this.ready = this.backend.ready;
    return this.ready;
  }

  onClipMoved(clipOriginX: number, clipOriginZ: number): void {
    this.backend?.onClipMoved(clipOriginX, clipOriginZ);
  }

  registerSection(record: WaterLocalFluidSectionRecord): void {
    this._flushDisturbances();
    this.backend?.registerSection(record);
  }

  removeSection(originX: number, originZ: number): void {
    this._flushDisturbances();
    this.backend?.removeSection(originX, originZ);
  }

  clearSections(): void {
    this.backend?.clearSections();
  }

  flushDisturbances(): void {
    this._flushDisturbances();
  }

  dispose(): void {
    this.backend?.dispose();
    this.backend = null;
    this.ready = false;
  }

  getSolver() {
    return this.solver;
  }

  setBudget(budget: Partial<WaterLocalFluidBudget>): void {
    if (budget.maxEmitters !== undefined) this._budget.maxEmitters = budget.maxEmitters;
    if (budget.maxImpactsPerFrame !== undefined) this._budget.maxImpactsPerFrame = budget.maxImpactsPerFrame;
    if (budget.maxWakesPerFrame !== undefined) this._budget.maxWakesPerFrame = budget.maxWakesPerFrame;
    if (budget.maxHeavyImpactsPerFrame !== undefined) this._budget.maxHeavyImpactsPerFrame = budget.maxHeavyImpactsPerFrame;
    if (budget.maxObjectSplashesPerFrame !== undefined) this._budget.maxObjectSplashesPerFrame = budget.maxObjectSplashesPerFrame;
  }

  getBudget(): Readonly<WaterLocalFluidBudget> {
    return this._budget;
  }

  getEmitterCount(): number {
    return this._emitters.size;
  }

  dispatchActorWake(worldX: number, worldZ: number, velocityX: number, velocityZ: number, radius = 1.5, energy = 0.5): void {
    if (this._pendingWakes.length >= this._budget.maxWakesPerFrame) return;
    this._pendingWakes.push({ kind: "wake", worldX, worldZ, radius, energy, velocityX, velocityZ });
  }

  dispatchImpact(worldX: number, worldZ: number, energy: number, radius = 2.0): void {
    if (this._pendingImpacts.length >= this._budget.maxImpactsPerFrame) return;
    this._pendingImpacts.push({ kind: "impact", worldX, worldZ, radius, energy });
  }

  dispatchHeavyImpact(worldX: number, worldZ: number, mass: number, velocity: number, radius = 3.0): void {
    if (this._pendingImpacts.length >= this._budget.maxHeavyImpactsPerFrame) return;
    const energy = Math.min(mass * Math.abs(velocity) * 0.1, 5.0);
    this._pendingImpacts.push({ kind: "heavy-impact", worldX, worldZ, radius, energy, mass });
  }

  dispatchActorWade(worldX: number, worldZ: number, velocityX: number, velocityZ: number, legRadius = 0.3): void {
    const speed = Math.hypot(velocityX, velocityZ);
    if (speed < 0.05) return;
    if (this._pendingWakes.length >= this._budget.maxWakesPerFrame) return;
    const energy = Math.min(speed * 0.15, 0.4);
    this._pendingWakes.push({
      kind: "actor-wade", worldX, worldZ, radius: legRadius + speed * 0.2,
      energy, velocityX, velocityZ,
    });
  }

  dispatchObjectSplash(worldX: number, worldZ: number, mass: number, impactVelocity: number): void {
    if (this._pendingImpacts.length >= this._budget.maxObjectSplashesPerFrame) return;
    const energy = Math.min(mass * Math.abs(impactVelocity) * 0.05, 2.0);
    const radius = 0.5 + Math.sqrt(mass) * 0.3;
    this._pendingImpacts.push({ kind: "object-splash", worldX, worldZ, radius, energy, mass });
  }

  registerDisturbanceEmitter(emitterId: string, worldX: number, worldZ: number, flowRate: number, radius: number): void {
    if (!this._emitters.has(emitterId) && this._emitters.size >= this._budget.maxEmitters) return;
    this._emitters.set(emitterId, { kind: "emitter", worldX, worldZ, radius, energy: flowRate });
  }

  unregisterDisturbanceEmitter(emitterId: string): void {
    this._emitters.delete(emitterId);
  }

  private _flushDisturbances(): void {
    if (!this.backend?.applyDisturbances) {
      this._pendingImpacts.length = 0;
      this._pendingWakes.length = 0;
      return;
    }
    const events: WaterDisturbanceEvent[] = [
      ...this._pendingWakes,
      ...this._pendingImpacts,
      ...this._emitters.values(),
    ];
    this._pendingImpacts.length = 0;
    this._pendingWakes.length = 0;
    if (events.length > 0) {
      this.backend.applyDisturbances(events);
    }
  }
}