import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { Scene } from "@babylonjs/core/scene";
import type { SpillEmitterRuntime } from "@divinevoxel/vlox/Water/Spill/index.js";
import type { DVEWaterLocalFluidSystem } from "./GPU/DVEWaterLocalFluidSystem.js";

export interface SpillFxRendererStats {
  activeEmitterCount: number;
  peakEmitterCount: number;
}

type SpillVisualRecord = {
  mesh: Mesh;
  phase: number;
};

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = clamp01((value - edge0) / Math.max(0.0001, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function lerp(start: number, end: number, alpha: number) {
  return start + (end - start) * alpha;
}

function getEmitterProgress(emitter: SpillEmitterRuntime) {
  return clamp01(emitter.elapsedSeconds / Math.max(0.0001, emitter.travelTimeSeconds));
}

function getWaterballBaseRadius(emitter: SpillEmitterRuntime) {
  const massRadius = Math.cbrt(Math.max(0.01, emitter.remainingMass)) * 0.58;
  const fallRadius = Math.min(0.42, Math.max(0, emitter.fallHeight) * 0.03);
  return Math.max(0.22, Math.min(1.35, massRadius + fallRadius));
}

function getImpactEnvelope(emitter: SpillEmitterRuntime) {
  if (emitter.fxProfile !== "waterball") return 1;
  return smoothstep(0.62, 1, getEmitterProgress(emitter));
}

function getSpillEmitterRadius(emitter: SpillEmitterRuntime) {
  const fallRadius = Math.min(3.5, Math.max(0, emitter.fallHeight) * 0.12);
  const flowRadius = Math.min(2.5, Math.sqrt(Math.max(0, emitter.flowRate)) * 0.45);
  return Math.max(0.9, 0.75 + fallRadius + flowRadius) * (0.24 + getImpactEnvelope(emitter) * 0.76);
}

export class SpillFxRenderer {
  private readonly waterballMaterial: PBRMaterial;
  private syncedEmitterIds = new Set<string>();
  private visuals = new Map<string, SpillVisualRecord>();
  private stats: SpillFxRendererStats = {
    activeEmitterCount: 0,
    peakEmitterCount: 0,
  };

  constructor(private readonly scene: Scene) {
    const material = new PBRMaterial("dve_spill_waterball_material", scene);
    material.albedoColor = new Color3(0.16, 0.38, 0.54);
    material.emissiveColor = new Color3(0.01, 0.03, 0.05);
    material.roughness = 0.06;
    material.metallic = 0;
    material.alpha = 0.78;
    material.indexOfRefraction = 1.33;
    material.backFaceCulling = false;
    material.forceDepthWrite = false;
    material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATESTANDBLEND;
    material.alphaCutOff = 0.03;
    material.environmentIntensity = 1.15;
    this.waterballMaterial = material;
  }

  private createVisual(emitterId: string) {
    const mesh = MeshBuilder.CreateSphere(
      `dve_spill_waterball_${emitterId}`,
      { diameter: 1, segments: 10 },
      this.scene,
    );
    mesh.isPickable = false;
    mesh.renderingGroupId = 1;
    mesh.receiveShadows = false;
    mesh.material = this.waterballMaterial;
    return {
      mesh,
      phase: Math.random() * Math.PI * 2,
    } satisfies SpillVisualRecord;
  }

  private updateWaterballVisual(emitterId: string, emitter: SpillEmitterRuntime) {
    if (emitter.fxProfile !== "waterball" || emitter.fallHeight <= 0.1) {
      const old = this.visuals.get(emitterId);
      if (old) {
        old.mesh.dispose();
        this.visuals.delete(emitterId);
      }
      return;
    }

    const visual = this.visuals.get(emitterId) ?? this.createVisual(emitterId);
    if (!this.visuals.has(emitterId)) {
      this.visuals.set(emitterId, visual);
    }

    const progress = getEmitterProgress(emitter);
    const baseRadius = getWaterballBaseRadius(emitter);
    const fallProgress = progress * progress;
    const dragDeform = smoothstep(0.14, 0.86, progress);
    const frictionSquash = smoothstep(0.58, 1, progress);
    const wobble = Math.sin(visual.phase + progress * 11.5) * 0.045 * (1 - frictionSquash * 0.7);
    const scaleY = Math.max(0.48, 1 - dragDeform * 0.16 - frictionSquash * 0.34 + wobble);
    const scaleXZ = Math.max(0.88, 1 + dragDeform * 0.08 + frictionSquash * 0.22 - wobble * 0.35);
    const centerY = lerp(
      emitter.worldY,
      emitter.landingSurfaceY + baseRadius * scaleY * 0.52,
      fallProgress,
    );

    visual.mesh.position.set(emitter.worldX + 0.5, centerY, emitter.worldZ + 0.5);
    visual.mesh.scaling.set(baseRadius * scaleXZ, baseRadius * scaleY, baseRadius * scaleXZ);
    visual.mesh.visibility = clamp01(0.78 + (1 - frictionSquash) * 0.12);
    visual.mesh.setEnabled(true);
  }

  sync(localFluidSystem: DVEWaterLocalFluidSystem | null, emitters: Iterable<SpillEmitterRuntime>) {
    const nextEmitterIds = new Set<string>();
    const activeVisualIds = new Set<string>();

    for (const emitter of emitters) {
      if (emitter.remainingMass <= 0.0001) continue;
      const emitterId = `spill:${emitter.id}`;
      nextEmitterIds.add(emitterId);
      this.updateWaterballVisual(emitterId, emitter);
      if (emitter.fxProfile === "waterball" && emitter.fallHeight > 0.1) {
        activeVisualIds.add(emitterId);
      }
      if (localFluidSystem) {
        const impactEnvelope = getImpactEnvelope(emitter);
        const effectiveFlowRate = emitter.flowRate * impactEnvelope;
        if (effectiveFlowRate > 0.001) {
          localFluidSystem.registerDisturbanceEmitter(
            emitterId,
            emitter.worldX,
            emitter.worldZ,
            effectiveFlowRate,
            getSpillEmitterRadius(emitter),
          );
        }
      }
    }

    for (const emitterId of Array.from(this.syncedEmitterIds)) {
      if (nextEmitterIds.has(emitterId)) continue;
      localFluidSystem?.unregisterDisturbanceEmitter(emitterId);
    }

    for (const [emitterId, visual] of Array.from(this.visuals.entries())) {
      if (activeVisualIds.has(emitterId)) continue;
      visual.mesh.dispose();
      this.visuals.delete(emitterId);
    }

    this.syncedEmitterIds = nextEmitterIds;
    this.stats.activeEmitterCount = nextEmitterIds.size;
    this.stats.peakEmitterCount = Math.max(
      this.stats.peakEmitterCount,
      this.stats.activeEmitterCount,
    );
  }

  clear(localFluidSystem: DVEWaterLocalFluidSystem | null) {
    if (localFluidSystem) {
      for (const emitterId of this.syncedEmitterIds) {
        localFluidSystem.unregisterDisturbanceEmitter(emitterId);
      }
    }
    for (const visual of this.visuals.values()) {
      visual.mesh.dispose();
    }
    this.visuals.clear();
    this.syncedEmitterIds.clear();
    this.stats.activeEmitterCount = 0;
  }

  getStats(): SpillFxRendererStats {
    return { ...this.stats };
  }
}