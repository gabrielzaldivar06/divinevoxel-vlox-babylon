/**
 * LODConstants — Fase 4
 *
 * Shared constants and types for the hybrid LOD system.
 * Band thresholds, hysteresis values, and LOD band enum.
 */
/** LOD bands from nearest to farthest. */
export declare const enum LODBand {
    Near = 0,
    TransitionNearMid = 1,
    Mid = 2,
    TransitionMidFar = 3,
    Far = 4
}
/** Distance thresholds for entering each band. */
export declare const LOD_ENTER: {
    readonly 0: 0;
    readonly 1: 40;
    readonly 2: 50;
    readonly 3: 80;
    readonly 4: 90;
};
/** Hysteresis: exit thresholds are shifted by this amount to prevent ping-pong. */
export declare const LOD_HYSTERESIS = 5;
/** Maximum sectors allowed to re-mesh per frame (rate limiting). */
export declare const LOD_MAX_REMESH_PER_FRAME = 2;
/**
 * Subdivision level per LOD band.
 * Near/TransitionNM use the edgeBoundary-based adaptive level.
 * Mid uses a reduced level. Far always 0 (standard quad).
 */
export declare function subdivisionForBand(band: LODBand, edgeBoundary: number): number;
/**
 * Morph factor for transition bands.
 * Returns 0.0 in stable bands, 0→1 gradient in transition bands.
 */
export declare function morphFactorForDistance(dist: number): number;
