import type {
  WaterLocalFluidBackend,
  WaterLocalFluidSectionRecord,
} from "./DVEWaterLocalFluidTypes.js";

const FIELD_SIZE = 256;
const MAX_PARTICLES = 2048;
const CLIP_MARGIN = 2;
const VELOCITY_DAMPING = 0.985;
const VELOCITY_PULL = 0.018;
const PARTICLE_GRAVITY_Z = 0.0;
const SUBSTEPS = 2;
const PARTICLE_REPULSION = 0.012;
const PARTICLE_RADIUS_SCALE = 1.8;
const FILL_GAIN = 0.42;
const FOAM_GAIN = 0.28;
const LOOP_DELAY_MS = 16;
const INTERACTION_IMPULSE = 0.085;
const INTERACTION_FILL = 0.12;
const INTERACTION_FOAM = 0.35;
const EQUIVALENCE_SAMPLE_COUNT = 16;
const EMPTY_FLOAT_ARRAY = new Float32Array(0);

type PBFParticle = {
  x: number;
  z: number;
  vx: number;
  vz: number;
  restVX: number;
  restVZ: number;
  radius: number;
  kind: number;
};

function buildSampledArraySignature(array: Float32Array) {
  const parts = [String(array.length)];
  const sampleCount = Math.min(EQUIVALENCE_SAMPLE_COUNT, array.length);
  for (let i = 0; i < sampleCount; i++) {
    parts.push(String(array[i]));
  }
  for (let i = 0; i < sampleCount; i++) {
    const index = array.length - 1 - i;
    if (index < sampleCount) break;
    parts.push(String(array[index]));
  }
  return parts.join("|");
}

function computeRecordSignature(record: WaterLocalFluidSectionRecord) {
  return [
    record.originX,
    record.originZ,
    record.boundsX,
    record.boundsZ,
    record.particleSeedStride,
    record.particleSeedCount,
    record.interactionFieldSize ?? 0,
    buildSampledArraySignature(record.particleSeedBuffer),
    buildSampledArraySignature(record.interactionField ?? EMPTY_FLOAT_ARRAY),
  ].join("::");
}

export class DVEWaterPBFSimulation implements WaterLocalFluidBackend {
  ready = false;
  hasFreshContributions = false;
  velocityXField = new Float32Array(FIELD_SIZE * FIELD_SIZE);
  velocityZField = new Float32Array(FIELD_SIZE * FIELD_SIZE);
  fillContribField = new Float32Array(FIELD_SIZE * FIELD_SIZE);
  foamContribField = new Float32Array(FIELD_SIZE * FIELD_SIZE);

  private particles: PBFParticle[] = [];
  private sectionRecords: WaterLocalFluidSectionRecord[] = [];
  private sectionSignatures = new Map<string, string>();
  private clipOriginX = 0;
  private clipOriginZ = 0;
  private needsReseed = false;
  private loopActive = false;

  async init(): Promise<boolean> {
    if (this.ready) return true;
    this.ready = true;
    this.loopActive = true;
    void this.simulationLoop();
    console.log("[DVEWaterPBFSimulation] CPU PBF-style local fluid initialised.");
    return true;
  }

  onClipMoved(clipOriginX: number, clipOriginZ: number): void {
    if (clipOriginX !== this.clipOriginX || clipOriginZ !== this.clipOriginZ) {
      this.clipOriginX = clipOriginX;
      this.clipOriginZ = clipOriginZ;
      this.needsReseed = true;
      this.hasFreshContributions = false;
    }
  }

  registerSection(record: WaterLocalFluidSectionRecord): void {
    const key = `${record.originX}:${record.originZ}`;
    const signature = computeRecordSignature(record);
    const index = this.sectionRecords.findIndex(
      (other) => other.originX === record.originX && other.originZ === record.originZ,
    );
    if (index === -1) {
      this.sectionRecords.push(record);
      this.sectionSignatures.set(key, signature);
      this.needsReseed = true;
      this.hasFreshContributions = false;
      return;
    }

    const currentSignature = this.sectionSignatures.get(key);
    this.sectionRecords[index] = record;
    this.sectionSignatures.set(key, signature);
    if (currentSignature !== signature) {
      this.needsReseed = true;
      this.hasFreshContributions = false;
    }
  }

  removeSection(originX: number, originZ: number): void {
    const index = this.sectionRecords.findIndex(
      (other) => other.originX === originX && other.originZ === originZ,
    );
    if (index === -1) return;

    this.sectionRecords.splice(index, 1);
    this.sectionSignatures.delete(`${originX}:${originZ}`);
    this.needsReseed = true;
    this.hasFreshContributions = false;
  }

  clearSections(): void {
    this.sectionRecords.length = 0;
    this.sectionSignatures.clear();
    this.particles.length = 0;
    this.needsReseed = true;
    this.hasFreshContributions = false;
    this.clearFields();
  }

  dispose(): void {
    this.loopActive = false;
    this.ready = false;
    this.hasFreshContributions = false;
    this.sectionRecords.length = 0;
    this.sectionSignatures.clear();
    this.particles.length = 0;
    this.clearFields();
  }

  private async simulationLoop() {
    while (this.loopActive) {
      if (this.needsReseed) {
        this.needsReseed = false;
        this.reseedParticles();
      }
      if (this.particles.length > 0) {
        this.simulateStep();
        this.scatterParticles();
        this.hasFreshContributions = true;
      } else {
        this.clearFields();
        this.hasFreshContributions = false;
      }
      await sleep(LOOP_DELAY_MS);
    }
  }

  private reseedParticles() {
    this.particles.length = 0;
    for (const section of this.sectionRecords) {
      const stride = section.particleSeedStride;
      const limit = Math.min(section.particleSeedCount, MAX_PARTICLES - this.particles.length);
      const decimation = Math.max(1, Math.ceil(section.particleSeedCount / Math.max(limit, 1)));
      for (let index = 0; index < section.particleSeedCount && this.particles.length < MAX_PARTICLES; index += decimation) {
        const base = index * stride;
        const worldX = section.particleSeedBuffer[base + 0];
        const worldZ = section.particleSeedBuffer[base + 2];
        const vx = section.particleSeedBuffer[base + 3];
        const vz = section.particleSeedBuffer[base + 5];
        const radius = section.particleSeedBuffer[base + 6];
        const kind = section.particleSeedBuffer[base + 7];
        const localX = worldX - this.clipOriginX;
        const localZ = worldZ - this.clipOriginZ;
        if (localX < CLIP_MARGIN || localX >= FIELD_SIZE - CLIP_MARGIN) continue;
        if (localZ < CLIP_MARGIN || localZ >= FIELD_SIZE - CLIP_MARGIN) continue;
        this.particles.push({
          x: localX + jitter(),
          z: localZ + jitter(),
          vx,
          vz,
          restVX: vx,
          restVZ: vz,
          radius,
          kind,
        });
      }
    }
  }

  private simulateStep() {
    for (let step = 0; step < SUBSTEPS; step++) {
      this.applyInteractionImpulses();

      for (let index = 0; index < this.particles.length; index++) {
        const particle = this.particles[index];
        particle.vx = particle.vx * VELOCITY_DAMPING + (particle.restVX - particle.vx) * VELOCITY_PULL;
        particle.vz = particle.vz * VELOCITY_DAMPING + (particle.restVZ - particle.vz) * VELOCITY_PULL + PARTICLE_GRAVITY_Z;
      }

      for (let index = 0; index < this.particles.length; index++) {
        const particle = this.particles[index];
        for (let otherIndex = index + 1; otherIndex < this.particles.length; otherIndex++) {
          const other = this.particles[otherIndex];
          const dx = particle.x - other.x;
          const dz = particle.z - other.z;
          const distanceSq = dx * dx + dz * dz;
          const targetDistance = (particle.radius + other.radius) * PARTICLE_RADIUS_SCALE;
          if (distanceSq <= 0.0001 || distanceSq >= targetDistance * targetDistance) continue;
          const distance = Math.sqrt(distanceSq);
          const overlap = (targetDistance - distance) * PARTICLE_REPULSION;
          const nx = dx / distance;
          const nz = dz / distance;
          particle.vx += nx * overlap;
          particle.vz += nz * overlap;
          other.vx -= nx * overlap;
          other.vz -= nz * overlap;
        }
      }

      for (const particle of this.particles) {
        particle.x = clamp(particle.x + particle.vx, CLIP_MARGIN, FIELD_SIZE - CLIP_MARGIN - 1);
        particle.z = clamp(particle.z + particle.vz, CLIP_MARGIN, FIELD_SIZE - CLIP_MARGIN - 1);
      }
    }
  }

  private applyInteractionImpulses() {
    for (const particle of this.particles) {
      const interaction = this.sampleInteractionField(particle.x, particle.z);
      if (interaction <= 0.001) continue;
      const angle = noiseAngle(particle.x, particle.z);
      const impulse = interaction * INTERACTION_IMPULSE;
      particle.vx += Math.cos(angle) * impulse;
      particle.vz += Math.sin(angle) * impulse;
    }
  }

  private sampleInteractionField(localX: number, localZ: number) {
    let interaction = 0;
    for (const section of this.sectionRecords) {
      const field = section.interactionField;
      const size = section.interactionFieldSize ?? 0;
      if (!field || field.length === 0 || size <= 0) continue;
      const sectionLocalX = localX + this.clipOriginX - section.originX;
      const sectionLocalZ = localZ + this.clipOriginZ - section.originZ;
      if (sectionLocalX < 0 || sectionLocalX >= section.boundsX) continue;
      if (sectionLocalZ < 0 || sectionLocalZ >= section.boundsZ) continue;
      const fx = clamp(sectionLocalX / Math.max(section.boundsX - 1, 1), 0, 1) * (size - 1);
      const fz = clamp(sectionLocalZ / Math.max(section.boundsZ - 1, 1), 0, 1) * (size - 1);
      const x0 = Math.floor(fx);
      const z0 = Math.floor(fz);
      const x1 = Math.min(size - 1, x0 + 1);
      const z1 = Math.min(size - 1, z0 + 1);
      const tx = fx - x0;
      const tz = fz - z0;
      const v00 = field[x0 * size + z0] ?? 0;
      const v10 = field[x1 * size + z0] ?? 0;
      const v01 = field[x0 * size + z1] ?? 0;
      const v11 = field[x1 * size + z1] ?? 0;
      const north = v00 + (v10 - v00) * tx;
      const south = v01 + (v11 - v01) * tx;
      interaction = Math.max(interaction, north + (south - north) * tz);
    }
    return clamp(interaction, 0, 1);
  }

  private scatterParticles() {
    this.clearFields();
    const counts = new Float32Array(FIELD_SIZE * FIELD_SIZE);
    for (const particle of this.particles) {
      const fx = Math.floor(particle.x);
      const fz = Math.floor(particle.z);
      const fieldIndex = fx * FIELD_SIZE + fz;
      counts[fieldIndex] += 1;
      this.velocityXField[fieldIndex] += particle.vx;
      this.velocityZField[fieldIndex] += particle.vz;
      const interaction = this.sampleInteractionField(particle.x, particle.z);
      this.fillContribField[fieldIndex] += FILL_GAIN + particle.radius * 0.4 + interaction * INTERACTION_FILL;
      const speed = Math.hypot(particle.vx, particle.vz);
      const kindBoost = particle.kind > 0 ? 0.06 : 0;
      this.foamContribField[fieldIndex] += FOAM_GAIN * speed + kindBoost + interaction * INTERACTION_FOAM;
    }
    for (let index = 0; index < counts.length; index++) {
      const count = counts[index];
      if (count <= 0) continue;
      this.velocityXField[index] /= count;
      this.velocityZField[index] /= count;
      this.fillContribField[index] = Math.min(1, this.fillContribField[index] / count);
      this.foamContribField[index] = Math.min(1, this.foamContribField[index] / count);
    }
  }

  private clearFields() {
    this.velocityXField.fill(0);
    this.velocityZField.fill(0);
    this.fillContribField.fill(0);
    this.foamContribField.fill(0);
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function jitter() {
  return (Math.random() - 0.5) * 0.2;
}

function noiseAngle(x: number, z: number) {
  const seed = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return (seed - Math.floor(seed)) * Math.PI * 2;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}