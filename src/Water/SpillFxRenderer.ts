import type { SpillEmitterRuntime } from "@divinevoxel/vlox/Water/Spill/index.js";
import type { DVEWaterLocalFluidSystem } from "./GPU/DVEWaterLocalFluidSystem.js";

export interface SpillFxRendererStats {
  activeEmitterCount: number;
  peakEmitterCount: number;
}

function getSpillEmitterRadius(emitter: SpillEmitterRuntime) {
  const fallRadius = Math.min(3.5, Math.max(0, emitter.fallHeight) * 0.12);
  const flowRadius = Math.min(2.5, Math.sqrt(Math.max(0, emitter.flowRate)) * 0.45);
  return Math.max(0.9, 0.75 + fallRadius + flowRadius);
}

export class SpillFxRenderer {
  private syncedEmitterIds = new Set<string>();
  private stats: SpillFxRendererStats = {
    activeEmitterCount: 0,
    peakEmitterCount: 0,
  };

  sync(localFluidSystem: DVEWaterLocalFluidSystem | null, emitters: Iterable<SpillEmitterRuntime>) {
    if (!localFluidSystem) {
      this.stats.activeEmitterCount = 0;
      return;
    }

    const nextEmitterIds = new Set<string>();

    for (const emitter of emitters) {
      if (emitter.remainingMass <= 0.0001) continue;
      const emitterId = `spill:${emitter.id}`;
      nextEmitterIds.add(emitterId);
      localFluidSystem.registerDisturbanceEmitter(
        emitterId,
        emitter.worldX,
        emitter.worldZ,
        emitter.flowRate,
        getSpillEmitterRadius(emitter),
      );
    }

    for (const emitterId of Array.from(this.syncedEmitterIds)) {
      if (nextEmitterIds.has(emitterId)) continue;
      localFluidSystem.unregisterDisturbanceEmitter(emitterId);
    }

    this.syncedEmitterIds = nextEmitterIds;
    this.stats.activeEmitterCount = localFluidSystem.getEmitterCount();
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
    this.syncedEmitterIds.clear();
    this.stats.activeEmitterCount = 0;
  }

  getStats(): SpillFxRendererStats {
    return { ...this.stats };
  }
}