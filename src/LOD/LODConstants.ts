/**
 * LODConstants — Fase 4
 *
 * Shared constants and types for the hybrid LOD system.
 * Band thresholds, hysteresis values, and LOD band enum.
 */

/** LOD bands from nearest to farthest. */
export const enum LODBand {
  Near = 0,
  TransitionNearMid = 1,
  Mid = 2,
  TransitionMidFar = 3,
  Far = 4,
}

/** Distance thresholds for entering each band. */
export const LOD_ENTER = {
  [LODBand.Near]: 0,
  [LODBand.TransitionNearMid]: 40,
  [LODBand.Mid]: 50,
  [LODBand.TransitionMidFar]: 80,
  [LODBand.Far]: 90,
} as const;

/** Hysteresis: exit thresholds are shifted by this amount to prevent ping-pong. */
export const LOD_HYSTERESIS = 5;

/** Maximum sectors allowed to re-mesh per frame (rate limiting). */
export const LOD_MAX_REMESH_PER_FRAME = 2;

/**
 * Subdivision level per LOD band.
 * Near/TransitionNM use the edgeBoundary-based adaptive level.
 * Mid uses a reduced level. Far always 0 (standard quad).
 */
export function subdivisionForBand(
  band: LODBand,
  edgeBoundary: number
): number {
  switch (band) {
    case LODBand.Near:
    case LODBand.TransitionNearMid:
      // Adaptive: 3×3 for strong edges, 2×2 for moderate
      if (edgeBoundary > 0.7) return 3;
      if (edgeBoundary > 0.3) return 2;
      return 0;
    case LODBand.Mid:
    case LODBand.TransitionMidFar:
      // Reduced: 2×2 for strong edges only
      if (edgeBoundary > 0.5) return 2;
      return 0;
    case LODBand.Far:
    default:
      return 0; // Standard quad
  }
}

/**
 * Morph factor for transition bands.
 * Returns 0.0 in stable bands, 0→1 gradient in transition bands.
 */
export function morphFactorForDistance(dist: number): number {
  if (dist >= LOD_ENTER[LODBand.TransitionNearMid] && dist < LOD_ENTER[LODBand.Mid]) {
    // Near→Mid transition: 40→50m
    return smoothstep(
      LOD_ENTER[LODBand.TransitionNearMid],
      LOD_ENTER[LODBand.Mid],
      dist
    );
  }
  if (dist >= LOD_ENTER[LODBand.TransitionMidFar] && dist < LOD_ENTER[LODBand.Far]) {
    // Mid→Far transition: 80→90m
    return smoothstep(
      LOD_ENTER[LODBand.TransitionMidFar],
      LOD_ENTER[LODBand.Far],
      dist
    );
  }
  return 0.0;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
