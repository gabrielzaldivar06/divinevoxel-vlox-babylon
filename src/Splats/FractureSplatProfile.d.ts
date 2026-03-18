/**
 * FractureSplatProfile — Fase 5 Entregable 5.1
 *
 * Defines fracture particle profiles per material family.
 * Profiles dictate: splat count, ejection velocity, lifetime,
 * gravity, shape, and scale based on the material's shearStrength.
 */
export interface FractureProfile {
    /** Number of splats to emit per destroyed voxel. */
    count: number;
    /** Radial ejection speed (m/s). */
    velocity: number;
    /** Time before splat fades to zero opacity (seconds). */
    lifetime: number;
    /** Downward acceleration (m/s²). */
    gravity: number;
    /** Splat shape: 0=circular, 1=irregular, 2=angular, 3=elongated. */
    shape: number;
    /** Base splat scale (world-space radius). */
    scale: number;
    /** Upward velocity bias factor (0-1). */
    upwardBias: number;
}
/**
 * Get fracture profile for a material family.
 * Fine-tuned per family for visual fidelity — see master plan §5.1.
 */
export declare function getFractureProfile(family: string): FractureProfile;
/**
 * Adjust profile based on raw shearStrength value.
 * Low shear → more particles, slower. High shear → fewer, faster.
 */
export declare function adjustProfileByShear(base: FractureProfile, shearStrength: number): FractureProfile;
