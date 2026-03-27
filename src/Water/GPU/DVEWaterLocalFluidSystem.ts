import { DVEWaterGPUSimulation } from "./DVEWaterGPUSimulation.js";
import { DVEWaterPBFSimulation } from "./DVEWaterPBFSimulation.js";
import {
  getPreferredWaterLocalFluidSolver,
  type WaterLocalFluidBackend,
  type WaterLocalFluidSectionRecord,
  type WaterLocalFluidSolver,
} from "./DVEWaterLocalFluidTypes.js";

export class DVEWaterLocalFluidSystem implements WaterLocalFluidBackend {
  ready = false;
  private readonly emptyField = new Float32Array(256 * 256);

  private backend: WaterLocalFluidBackend | null = null;
  private solver: WaterLocalFluidSolver;

  get velocityXField() {
    return this.backend?.velocityXField ?? this.emptyField;
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
    this.backend?.registerSection(record);
  }

  clearSections(): void {
    this.backend?.clearSections();
  }

  dispose(): void {
    this.backend?.dispose();
    this.backend = null;
    this.ready = false;
  }

  getSolver() {
    return this.solver;
  }
}