/**
 * FractureSplatEmitter — Fase 5 Entregable 5.2, 5.8
 *
 * Generates dynamic fracture splats when a voxel is destroyed.
 * Input: voxel position + material family + color.
 * Output: DynamicSplatInstance[] with velocity/lifetime for physics.
 *
 * Shape variation (Entregable 5.8): soil=irregular, rock=angular,
 * flora=elongated strips that float.
 */
import { SplatInstance } from "./DVEGaussianSplatRenderer";
/** Dynamic splat extends SplatInstance with physics. */
export interface DynamicSplatInstance extends SplatInstance {
    /** Velocity [vx, vy, vz] m/s. */
    velocity: [number, number, number];
    /** Total lifetime in seconds. */
    lifetime: number;
    /** Current age in seconds (starts at 0). */
    age: number;
    /** Gravity acceleration m/s². */
    gravity: number;
    /** Original opacity (for fade calculation). */
    baseOpacity: number;
}
/**
 * Emit fracture splats for a destroyed voxel.
 *
 * @param x World X of destroyed voxel
 * @param y World Y of destroyed voxel
 * @param z World Z of destroyed voxel
 * @param family Material family string (TerrainMaterialFamily value)
 * @param shearStrength Physics shear strength
 * @param color RGB [0-255] color of the voxel
 */
export declare function emitFractureSplats(x: number, y: number, z: number, family: string, shearStrength: number, color: [number, number, number]): DynamicSplatInstance[];
