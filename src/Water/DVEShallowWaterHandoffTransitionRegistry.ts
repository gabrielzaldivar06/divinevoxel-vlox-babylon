import {
  buildShallowWaterEdgeFieldSectionRenderData,
  type ShallowEdgeFieldSectionRenderData,
  type ShallowFilmSectionRenderData,
  type ShallowRenderSectionSnapshot,
  type ShallowVisualColumnState,
} from "@divinevoxel/vlox/Water/Shallow/index.js";

const SECTION_SIZE = 16;
const SHALLOW_HANDOFF_OUT_DURATION = 0.22;
const SHALLOW_HANDOFF_IN_DURATION = 0.35;
const SHALLOW_HANDOFF_THICKNESS_REF = 0.75;

type HandoffTransitionKind = "outgoing" | "incoming";

interface HandoffTransitionRecord {
  id: string;
  sectionKey: string;
  originX: number;
  originZ: number;
  localX: number;
  localZ: number;
  worldX: number;
  worldZ: number;
  bedY: number;
  surfaceY: number;
  thickness: number;
  emitterId: number;
  kind: HandoffTransitionKind;
  age: number;
  duration: number;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function makeEmptyVisualColumn(): ShallowVisualColumnState {
  return {
    active: false,
    patchId: -1,
    patchTotalMass: 0,
    patchArea: 0,
    patchActiveArea: 0,
    patchAverageThickness: 0,
    patchMaxThickness: 0,
    patchConnectivity: 0,
    patchCompactness: 0,
    patchBoundaryRatio: 0,
    patchHandoffReady: false,
    localNeighborCount: 0,
    localCore: 0,
    thickness: 0,
    bedY: 0,
    surfaceY: 0,
    visualSurfaceY: 0,
    filmThickness: 0,
    filmOpacity: 0,
    spreadVX: 0,
    spreadVZ: 0,
    flowX: 0,
    flowZ: 0,
    flowSpeed: 0,
    settled: 0,
    adhesion: 0,
    age: 0,
    shoreDist: 0,
    coverage: 0,
    edgeStrength: 0,
    foam: 0,
    wetness: 0,
    breakup: 0,
    microRipple: 0,
    mergeBlend: 0,
    deepBlend: 0,
    handoffBlend: 0,
    emitterId: 0,
    handoffPending: false,
    ownershipDomain: "none",
    authority: "bootstrap",
  };
}

function makeSyntheticFilm(
  originX: number,
  originZ: number,
  terrainY: number,
  previous?: ShallowFilmSectionRenderData | null,
): ShallowFilmSectionRenderData {
  const columnCount = SECTION_SIZE * SECTION_SIZE;
  const columns =
    previous &&
    previous.originX === originX &&
    previous.originZ === originZ &&
    previous.sizeX === SECTION_SIZE &&
    previous.sizeZ === SECTION_SIZE
      ? previous.columns
      : new Array<ShallowVisualColumnState>(columnCount);

  for (let index = 0; index < columnCount; index++) {
    columns[index] = columns[index] ?? makeEmptyVisualColumn();
    Object.assign(columns[index], makeEmptyVisualColumn());
  }

  return {
    originX,
    originZ,
    sizeX: SECTION_SIZE,
    sizeZ: SECTION_SIZE,
    terrainY,
    lastTickDt: 0,
    columns,
    activeColumnCount: 0,
  };
}

function getSectionOrigin(value: number) {
  return Math.floor(value / SECTION_SIZE) * SECTION_SIZE;
}

function getLocalCoord(value: number) {
  return ((value % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
}

function getSectionKey(originX: number, originZ: number) {
  return `${originX}_${originZ}`;
}

function getColumnIndex(sizeX: number, x: number, z: number) {
  return z * sizeX + x;
}

function applyTransitionToColumn(
  column: ShallowVisualColumnState,
  record: HandoffTransitionRecord,
) {
  const normalizedAge = clamp01(record.age / Math.max(0.0001, record.duration));
  const progress = record.kind === "outgoing" ? 1 - normalizedAge : normalizedAge;
  if (progress <= 0.0001) return false;

  const thickness01 = clamp01(record.thickness / SHALLOW_HANDOFF_THICKNESS_REF);
  const coverage = clamp01(
    thickness01 * (record.kind === "outgoing" ? 0.34 : 0.78) * progress,
  );
  const foam =
    record.kind === "outgoing"
      ? clamp01(0.05 + progress * 0.16)
      : clamp01(0.08 + progress * 0.26);
  const wetness =
    record.kind === "outgoing"
      ? clamp01(0.12 + progress * 0.22)
      : clamp01(0.18 + progress * 0.38);
  const edgeStrength =
    record.kind === "outgoing"
      ? clamp01(0.08 + progress * 0.18)
      : clamp01(0.16 + progress * 0.24);
  const breakup =
    record.kind === "outgoing"
      ? clamp01(0.04 + progress * 0.12)
      : clamp01(0.08 + progress * 0.18);
  const microRipple = clamp01(
    record.kind === "outgoing" ? 0.04 + progress * 0.08 : 0.12 + progress * 0.22,
  );
  const filmThickness = clamp(
    record.kind === "outgoing"
      ? 0.005 + record.thickness * 0.008 + coverage * 0.008
      : 0.008 + record.thickness * 0.032 + coverage * 0.018,
    0.006,
    0.075,
  );
  const transitionedThickness = Math.max(
    record.thickness * progress * (record.kind === "outgoing" ? 0.18 : 1),
    0,
  );
  const transitionedSurfaceY = record.bedY + transitionedThickness;
  const filmOpacity = clamp01(
    (record.kind === "outgoing" ? 0.06 : 0.16) +
      wetness * (record.kind === "outgoing" ? 0.22 : 0.45) +
      foam * (record.kind === "outgoing" ? 0.08 : 0.16) +
      progress * (record.kind === "outgoing" ? 0.03 : 0.08),
  );

  column.active = true;
  column.thickness = Math.max(column.thickness, transitionedThickness);
  column.bedY = column.bedY === 0 ? record.bedY : Math.min(column.bedY, record.bedY);
  column.surfaceY = Math.max(column.surfaceY, transitionedSurfaceY);
  column.visualSurfaceY = Math.max(
    column.visualSurfaceY,
    record.kind === "outgoing"
      ? record.bedY + filmThickness + transitionedThickness * 0.02
      : record.bedY + Math.max(filmThickness, transitionedThickness * 0.04),
  );
  column.filmThickness = Math.max(column.filmThickness, filmThickness);
  column.filmOpacity = Math.max(column.filmOpacity, filmOpacity);
  column.coverage = Math.max(column.coverage, coverage);
  column.edgeStrength = Math.max(column.edgeStrength, edgeStrength);
  column.foam = Math.max(column.foam, foam);
  column.wetness = Math.max(column.wetness, wetness);
  column.breakup = Math.max(column.breakup, breakup);
  column.microRipple = Math.max(column.microRipple, microRipple);
  column.mergeBlend = Math.max(column.mergeBlend, record.kind === "outgoing" ? 0.42 : 0.42);
  column.deepBlend = Math.max(column.deepBlend, record.kind === "outgoing" ? 0.54 : 0.36);
  column.handoffBlend = Math.max(column.handoffBlend, record.kind === "outgoing" ? progress * 0.75 : progress * 0.42);
  column.patchHandoffReady = record.kind === "outgoing";
  column.localNeighborCount = Math.max(column.localNeighborCount, 2);
  column.localCore = Math.max(column.localCore, record.kind === "outgoing" ? 0.42 : 0.42);
  column.age = Math.max(column.age, record.age);
  column.emitterId = Math.max(column.emitterId, record.emitterId);
  column.handoffPending = false;
  column.ownershipDomain = "shallow";
  column.authority =
    record.kind === "outgoing" ? "continuous-handoff" : "editor";
  return true;
}

export class DVEShallowWaterHandoffTransitionRegistry {
  private readonly records = new Map<string, HandoffTransitionRecord>();

  beginShallowToContinuousTransition(
    worldX: number,
    worldZ: number,
    bedY: number,
    surfaceY: number,
    thickness: number,
    emitterId = 0,
  ) {
    this.upsertRecord("outgoing", worldX, worldZ, bedY, surfaceY, thickness, emitterId);
  }

  beginContinuousToShallowTransition(
    worldX: number,
    worldZ: number,
    bedY: number,
    surfaceY: number,
    thickness: number,
    emitterId = 0,
  ) {
    this.upsertRecord("incoming", worldX, worldZ, bedY, surfaceY, thickness, emitterId);
  }

  tick(deltaSeconds: number) {
    if (deltaSeconds <= 0) return;
    for (const [id, record] of this.records) {
      record.age += deltaSeconds;
      if (record.age >= record.duration) {
        this.records.delete(id);
      }
    }
  }

  applyToSnapshot(snapshot: ShallowRenderSectionSnapshot) {
    let activeColumnCount = snapshot.film.activeColumnCount;
    const sectionKey = getSectionKey(snapshot.film.originX, snapshot.film.originZ);
    let minTerrainY = Number.isFinite(snapshot.film.terrainY)
      ? snapshot.film.terrainY
      : Number.POSITIVE_INFINITY;
    for (const record of this.records.values()) {
      if (record.sectionKey !== sectionKey) continue;
      minTerrainY = Math.min(minTerrainY, record.bedY);
      const index = getColumnIndex(snapshot.film.sizeX, record.localX, record.localZ);
      const column = snapshot.film.columns[index] ?? makeEmptyVisualColumn();
      const wasActive = column.active;
      snapshot.film.columns[index] = column;
      const changed = applyTransitionToColumn(column, record);
      if (changed && !wasActive) {
        activeColumnCount += 1;
      }
    }
    if (Number.isFinite(minTerrainY)) {
      snapshot.film.terrainY = minTerrainY;
    }
    snapshot.film.activeColumnCount = activeColumnCount;
    snapshot.edgeField = buildShallowWaterEdgeFieldSectionRenderData(
      snapshot.film,
      snapshot.edgeField as ShallowEdgeFieldSectionRenderData | undefined,
    );
  }

  buildSyntheticSnapshots(
    previousSnapshots: ReadonlyMap<string, ShallowRenderSectionSnapshot>,
    skipSectionKeys?: ReadonlySet<string>,
  ) {
    const sectionKeys = new Set<string>();
    for (const record of this.records.values()) {
      if (skipSectionKeys?.has(record.sectionKey)) continue;
      sectionKeys.add(record.sectionKey);
    }

    const snapshots: Array<[string, ShallowRenderSectionSnapshot]> = [];
    for (const sectionKey of sectionKeys) {
      const [originX, originZ] = sectionKey.split("_").map((value) => Number(value));
      const previous = previousSnapshots.get(sectionKey);
      let terrainY = Number.isFinite(previous?.film.terrainY)
        ? (previous?.film.terrainY as number)
        : Number.POSITIVE_INFINITY;
      for (const record of this.records.values()) {
        if (record.sectionKey !== sectionKey) continue;
        terrainY = Math.min(terrainY, record.bedY);
      }
      const film = makeSyntheticFilm(
        originX,
        originZ,
        Number.isFinite(terrainY) ? terrainY : 0,
        previous?.film,
      );
      let activeColumnCount = 0;
      for (const record of this.records.values()) {
        if (record.sectionKey !== sectionKey) continue;
        const index = getColumnIndex(film.sizeX, record.localX, record.localZ);
        const column = film.columns[index] ?? makeEmptyVisualColumn();
        film.columns[index] = column;
        if (applyTransitionToColumn(column, record)) {
          activeColumnCount += 1;
        }
      }
      film.activeColumnCount = activeColumnCount;
      if (activeColumnCount <= 0) continue;
      const edgeField = buildShallowWaterEdgeFieldSectionRenderData(
        film,
        previous?.edgeField as ShallowEdgeFieldSectionRenderData | undefined,
      );
      snapshots.push([sectionKey, { film, edgeField }]);
    }

    return snapshots;
  }

  hasActiveTransitions(sectionKey?: string) {
    if (!sectionKey) {
      return this.records.size > 0;
    }
    for (const record of this.records.values()) {
      if (record.sectionKey === sectionKey) return true;
    }
    return false;
  }

  clear() {
    this.records.clear();
  }

  clearSection(sectionKey: string) {
    for (const [id, record] of this.records) {
      if (record.sectionKey === sectionKey) {
        this.records.delete(id);
      }
    }
  }

  private upsertRecord(
    kind: HandoffTransitionKind,
    worldX: number,
    worldZ: number,
    bedY: number,
    surfaceY: number,
    thickness: number,
    emitterId: number,
  ) {
    if (!Number.isFinite(thickness) || thickness <= 0.0001) return;
    const originX = getSectionOrigin(worldX);
    const originZ = getSectionOrigin(worldZ);
    const localX = getLocalCoord(worldX);
    const localZ = getLocalCoord(worldZ);
    const sectionKey = getSectionKey(originX, originZ);
    const id = `${sectionKey}:${localX}:${localZ}:${kind}`;
    const duration =
      kind === "outgoing" ? SHALLOW_HANDOFF_OUT_DURATION : SHALLOW_HANDOFF_IN_DURATION;
    this.records.set(id, {
      id,
      sectionKey,
      originX,
      originZ,
      localX,
      localZ,
      worldX,
      worldZ,
      bedY,
      surfaceY,
      thickness,
      emitterId,
      kind,
      age: 0,
      duration,
    });
  }
}
