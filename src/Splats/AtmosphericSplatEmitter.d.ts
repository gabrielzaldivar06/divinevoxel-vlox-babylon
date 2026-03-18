/**
 * AtmosphericSplatEmitter — Stretch Goal S1
 *
 * Emits ambient atmospheric splats (dust, spores, mineral haze, energy wisps)
 * in the air surrounding dissolution zones. These are static splats that float
 * near organic surface boundaries, creating depth and atmosphere.
 *
 * Particles are:
 *  - Positioned using seeded random around high-dissolution vertices
 *  - Offset from the surface into the air (normal direction + random spread)
 *  - Very small (0.01–0.06 scale) and transparent (0.05–0.35 opacity)
 *  - Per-family styled: soil→dust, flora→spores, rock→mineral dust, exotic→wisps
 *  - Altitude-biased: density varies with world Y
 */
import { SplatInstance } from "./DVEGaussianSplatRenderer";
export interface AtmosphericEmitOptions {
    sectionOrigin: [number, number, number];
    materialId: string;
}
/**
 * Scan a vertex buffer and emit atmospheric ambient splats around dissolution zones.
 */
export declare function emitAtmosphericSplats(vertices: Float32Array, options: AtmosphericEmitOptions): SplatInstance[];
