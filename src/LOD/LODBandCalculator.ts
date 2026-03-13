/**
 * LODBandCalculator — Fase 4
 *
 * Stateless calculator: given a sector position and camera position,
 * determines the LOD band. Uses center-of-sector distance.
 */

import {
  LODBand,
  LOD_ENTER,
  LOD_HYSTERESIS,
} from "./LODConstants";

/**
 * Compute current LOD band for a sector given camera distance.
 * Assumes `previousBand` is used for hysteresis (prevents ping-pong).
 *
 * @param sectorCenterX World X of sector center
 * @param sectorCenterY World Y of sector center
 * @param sectorCenterZ World Z of sector center
 * @param camX Camera world X
 * @param camY Camera world Y
 * @param camZ Camera world Z
 * @param previousBand The band this sector was in last frame
 */
export function calculateLODBand(
  sectorCenterX: number,
  sectorCenterY: number,
  sectorCenterZ: number,
  camX: number,
  camY: number,
  camZ: number,
  previousBand: LODBand
): LODBand {
  const dx = sectorCenterX - camX;
  const dy = sectorCenterY - camY;
  const dz = sectorCenterZ - camZ;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

  return bandFromDistance(dist, previousBand);
}

/**
 * Determine band from raw distance, applying hysteresis to the
 * previous band to prevent rapid switching at boundaries.
 */
export function bandFromDistance(
  dist: number,
  previousBand: LODBand
): LODBand {
  // Moving AWAY from camera (ascending bands) — use normal thresholds.
  // Moving TOWARD camera (descending bands) — subtract hysteresis.
  //
  // Example: Near exit at 40+5=45m, so you must reach 45m before
  // switching to TransitionNM. But once in TransitionNM, you
  // re-enter Near only when dist < 40m.

  const h = LOD_HYSTERESIS;

  if (previousBand === LODBand.Near) {
    if (dist >= LOD_ENTER[LODBand.TransitionNearMid] + h) {
      return LODBand.TransitionNearMid;
    }
    return LODBand.Near;
  }

  if (previousBand === LODBand.TransitionNearMid) {
    if (dist < LOD_ENTER[LODBand.TransitionNearMid]) return LODBand.Near;
    if (dist >= LOD_ENTER[LODBand.Mid] + h) return LODBand.Mid;
    return LODBand.TransitionNearMid;
  }

  if (previousBand === LODBand.Mid) {
    if (dist < LOD_ENTER[LODBand.Mid] - h) return LODBand.TransitionNearMid;
    if (dist >= LOD_ENTER[LODBand.TransitionMidFar] + h) {
      return LODBand.TransitionMidFar;
    }
    return LODBand.Mid;
  }

  if (previousBand === LODBand.TransitionMidFar) {
    if (dist < LOD_ENTER[LODBand.TransitionMidFar]) return LODBand.Mid;
    if (dist >= LOD_ENTER[LODBand.Far] + h) return LODBand.Far;
    return LODBand.TransitionMidFar;
  }

  // previousBand === Far
  if (dist < LOD_ENTER[LODBand.Far] - h) return LODBand.TransitionMidFar;
  return LODBand.Far;
}

/**
 * Determine initial LOD band for a newly appearing sector (no history).
 */
export function initialBand(dist: number): LODBand {
  if (dist < LOD_ENTER[LODBand.TransitionNearMid]) return LODBand.Near;
  if (dist < LOD_ENTER[LODBand.Mid]) return LODBand.TransitionNearMid;
  if (dist < LOD_ENTER[LODBand.TransitionMidFar]) return LODBand.Mid;
  if (dist < LOD_ENTER[LODBand.Far]) return LODBand.TransitionMidFar;
  return LODBand.Far;
}
