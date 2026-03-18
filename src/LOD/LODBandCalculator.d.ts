/**
 * LODBandCalculator — Fase 4
 *
 * Stateless calculator: given a sector position and camera position,
 * determines the LOD band. Uses center-of-sector distance.
 */
import { LODBand } from "./LODConstants";
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
export declare function calculateLODBand(sectorCenterX: number, sectorCenterY: number, sectorCenterZ: number, camX: number, camY: number, camZ: number, previousBand: LODBand): LODBand;
/**
 * Determine band from raw distance, applying hysteresis to the
 * previous band to prevent rapid switching at boundaries.
 */
export declare function bandFromDistance(dist: number, previousBand: LODBand): LODBand;
/**
 * Determine initial LOD band for a newly appearing sector (no history).
 */
export declare function initialBand(dist: number): LODBand;
