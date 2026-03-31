import { Scene } from "@babylonjs/core/scene";

import type { ShallowRenderSectionSnapshot } from "@divinevoxel/vlox/Water/Shallow/index.js";

import {
  DVEShallowWaterFilmRenderer,
  type DVEShallowWaterFilmSectionData,
} from "./DVEShallowWaterFilmRenderer.js";
import {
  DVEShallowWaterEdgeSplatRenderer,
  type DVEShallowWaterEdgeSplatSectionData,
} from "./DVEShallowWaterEdgeSplatRenderer.js";
import { DVEShallowWaterHandoffTransitionRegistry } from "./DVEShallowWaterHandoffTransitionRegistry.js";

export type DVEShallowWaterCompositeSectionData = ShallowRenderSectionSnapshot;

export interface DVEShallowWaterLocalFluidContributionState {
  originX: number;
  originZ: number;
  width: number;
  height: number;
  velocityXField: Float32Array;
  velocityZField: Float32Array;
  fillField: Float32Array;
  foamField: Float32Array;
  hasFreshContributions: boolean;
}

type ControllerOptions = {
  autoUpdate?: boolean;
};

export class DVEShallowWaterCompositeController {
  private readonly filmRenderer: DVEShallowWaterFilmRenderer;
  private readonly edgeSplatRenderer: DVEShallowWaterEdgeSplatRenderer;
  private readonly handoffTransitions = new DVEShallowWaterHandoffTransitionRegistry();
  private readonly scene: Scene;
  private disposed = false;
  private readonly latestSnapshots = new Map<string, ShallowRenderSectionSnapshot>();
  private readonly updatedSectionKeys = new Set<string>();

  constructor(scene: Scene, _options: ControllerOptions = {}) {
    this.scene = scene;
    this.filmRenderer = new DVEShallowWaterFilmRenderer(scene);
    this.edgeSplatRenderer = new DVEShallowWaterEdgeSplatRenderer(scene);
  }

  updateSection(sectionKey: string, snapshot: DVEShallowWaterCompositeSectionData) {
    if (this.disposed) return;
    this.handoffTransitions.applyToSnapshot(snapshot);
    this.latestSnapshots.set(sectionKey, snapshot);
    this.updatedSectionKeys.add(sectionKey);
    this.filmRenderer.updateSection(
      sectionKey,
      snapshot.film as DVEShallowWaterFilmSectionData,
    );
    this.edgeSplatRenderer.updateSection(
      sectionKey,
      snapshot.edgeField as DVEShallowWaterEdgeSplatSectionData,
    );
  }

  setLocalFluidContributions(
    state: DVEShallowWaterLocalFluidContributionState | null,
  ) {
    if (this.disposed) return;
    this.filmRenderer.setLocalFluidContributions(state);
    this.edgeSplatRenderer.setLocalFluidContributions(state);
  }

  beginShallowToContinuousTransition(
    worldX: number,
    worldZ: number,
    bedY: number,
    surfaceY: number,
    thickness: number,
    emitterId = 0,
  ) {
    if (this.disposed) return;
    this.handoffTransitions.beginShallowToContinuousTransition(
      worldX,
      worldZ,
      bedY,
      surfaceY,
      thickness,
      emitterId,
    );
  }

  beginContinuousToShallowTransition(
    worldX: number,
    worldZ: number,
    bedY: number,
    surfaceY: number,
    thickness: number,
    emitterId = 0,
  ) {
    if (this.disposed) return;
    this.handoffTransitions.beginContinuousToShallowTransition(
      worldX,
      worldZ,
      bedY,
      surfaceY,
      thickness,
      emitterId,
    );
  }

  removeSection(sectionKey: string) {
    if (this.disposed) return;
    this.latestSnapshots.delete(sectionKey);
    this.updatedSectionKeys.delete(sectionKey);
    this.handoffTransitions.clearSection(sectionKey);
    this.filmRenderer.removeSection(sectionKey);
    this.edgeSplatRenderer.removeSection(sectionKey);
  }

  update(deltaSeconds: number, activeSectionKeys?: ReadonlySet<string>) {
    if (this.disposed) return;
    this.handoffTransitions.tick(deltaSeconds);

    const effectiveSectionKeys = new Set<string>(activeSectionKeys ?? []);
    for (const sectionKey of this.updatedSectionKeys) {
      effectiveSectionKeys.add(sectionKey);
    }
    const syntheticSnapshots = this.handoffTransitions.buildSyntheticSnapshots(
      this.latestSnapshots,
      this.updatedSectionKeys,
    );
    for (const [sectionKey, snapshot] of syntheticSnapshots) {
      this.latestSnapshots.set(sectionKey, snapshot);
      effectiveSectionKeys.add(sectionKey);
      this.filmRenderer.updateSection(
        sectionKey,
        snapshot.film as DVEShallowWaterFilmSectionData,
      );
      this.edgeSplatRenderer.updateSection(
        sectionKey,
        snapshot.edgeField as DVEShallowWaterEdgeSplatSectionData,
      );
    }

    this.filmRenderer.update(deltaSeconds, effectiveSectionKeys);
    this.edgeSplatRenderer.update(deltaSeconds, effectiveSectionKeys);
    for (const sectionKey of Array.from(this.latestSnapshots.keys())) {
      if (effectiveSectionKeys.has(sectionKey)) continue;
      if (this.handoffTransitions.hasActiveTransitions(sectionKey)) continue;
      this.latestSnapshots.delete(sectionKey);
    }
    this.updatedSectionKeys.clear();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.latestSnapshots.clear();
    this.updatedSectionKeys.clear();
    this.handoffTransitions.clear();
    this.filmRenderer.dispose();
    this.edgeSplatRenderer.dispose();
  }

  getScene() {
    return this.scene;
  }
}
