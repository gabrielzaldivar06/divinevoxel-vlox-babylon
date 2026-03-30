export interface HybridVisualRefinerFields {
  width: number;
  height: number;
  fillField: Float32Array;
  fillFieldNext: Float32Array;
  velocityXField: Float32Array;
  velocityXFieldNext: Float32Array;
  velocityZField: Float32Array;
  velocityZFieldNext: Float32Array;
  foamField: Float32Array;
  foamFieldNext: Float32Array;
  pressureField: Float32Array;
  pressureFieldNext: Float32Array;
  targetFillField: Float32Array;
  targetVelocityXField: Float32Array;
  targetVelocityZField: Float32Array;
  targetFlowField: Float32Array;
  targetTurbulenceField: Float32Array;
  targetShoreField: Float32Array;
  targetInteractionField: Float32Array;
  targetPresenceField: Float32Array;
  particleFoamField: Float32Array;
  visualMassDeltaField: Float32Array;
}

export interface HybridVisualRefinerTuning {
  velocityAdvection: number;
  velocityDamping: number;
  targetPull: number;
  fillRelaxation: number;
  pressureResponse: number;
  taitStiffness: number;
  taitRestDensity: number;
  foamDecay: number;
  edgeDecay: number;
  massTransferRate: number;
  massRetention: number;
  momentumResponse: number;
  velocityLimit: number;
  interactionToFlow: number;
  interactionToFoam: number;
  interactionToPressure: number;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function sampleScalarField(field: Float32Array, width: number, height: number, x: number, z: number) {
  const clampedX = Math.max(0, Math.min(width - 1, x));
  const clampedZ = Math.max(0, Math.min(height - 1, z));
  const x0 = Math.floor(clampedX);
  const z0 = Math.floor(clampedZ);
  const x1 = Math.min(width - 1, x0 + 1);
  const z1 = Math.min(height - 1, z0 + 1);
  const tx = clampedX - x0;
  const tz = clampedZ - z0;
  const a = field[x0 * height + z0];
  const b = field[x1 * height + z0];
  const c = field[x0 * height + z1];
  const d = field[x1 * height + z1];
  const ab = a + (b - a) * tx;
  const cd = c + (d - c) * tx;
  return ab + (cd - ab) * tz;
}

function clampVelocity(value: number, velocityLimit: number) {
  return Math.max(-velocityLimit, Math.min(velocityLimit, value));
}

function applyPairTransfer(
  visualMassDeltaField: Float32Array,
  massTransferRate: number,
  fromIndex: number,
  toIndex: number,
  signedDrive: number,
  availableFrom: number,
  availableTo: number,
  deltaSeconds: number,
) {
  const proposedTransfer = signedDrive * massTransferRate * deltaSeconds;
  if (proposedTransfer > 0) {
    const transfer = Math.min(proposedTransfer, availableFrom * 0.5);
    visualMassDeltaField[fromIndex] -= transfer;
    visualMassDeltaField[toIndex] += transfer;
    return;
  }
  if (proposedTransfer < 0) {
    const transfer = Math.min(-proposedTransfer, availableTo * 0.5);
    visualMassDeltaField[fromIndex] += transfer;
    visualMassDeltaField[toIndex] -= transfer;
  }
}

export function refineHybridVisualFields(
  fields: HybridVisualRefinerFields,
  tuning: HybridVisualRefinerTuning,
  deltaSeconds: number,
): HybridVisualRefinerFields {
  fields.visualMassDeltaField.fill(0);

  for (let x = 0; x < fields.width; x++) {
    for (let z = 0; z < fields.height; z++) {
      const index = x * fields.height + z;
      const currentFill = fields.fillField[index];
      const currentVelocityX = fields.velocityXField[index];
      const currentVelocityZ = fields.velocityZField[index];
      const targetVelocityX =
        fields.targetVelocityXField[index] * fields.targetFlowField[index];
      const targetVelocityZ =
        fields.targetVelocityZField[index] * fields.targetFlowField[index];

      if (x + 1 < fields.width) {
        const rightIndex = (x + 1) * fields.height + z;
        const rightFill = fields.fillField[rightIndex];
        const rightTargetVelocityX =
          fields.targetVelocityXField[rightIndex] * fields.targetFlowField[rightIndex];
        const pairVelocity =
          (currentVelocityX + fields.velocityXField[rightIndex]) * 0.5;
        const pairTargetVelocity = (targetVelocityX + rightTargetVelocityX) * 0.5;
        const signedDrive =
          (currentFill - rightFill) * 0.55 +
          pairVelocity * 0.34 +
          pairTargetVelocity * tuning.momentumResponse;
        applyPairTransfer(
          fields.visualMassDeltaField,
          tuning.massTransferRate,
          index,
          rightIndex,
          signedDrive,
          currentFill,
          rightFill,
          deltaSeconds,
        );
      }

      if (z + 1 < fields.height) {
        const downIndex = x * fields.height + (z + 1);
        const downFill = fields.fillField[downIndex];
        const downTargetVelocityZ =
          fields.targetVelocityZField[downIndex] * fields.targetFlowField[downIndex];
        const pairVelocity =
          (currentVelocityZ + fields.velocityZField[downIndex]) * 0.5;
        const pairTargetVelocity = (targetVelocityZ + downTargetVelocityZ) * 0.5;
        const signedDrive =
          (currentFill - downFill) * 0.55 +
          pairVelocity * 0.34 +
          pairTargetVelocity * tuning.momentumResponse;
        applyPairTransfer(
          fields.visualMassDeltaField,
          tuning.massTransferRate,
          index,
          downIndex,
          signedDrive,
          currentFill,
          downFill,
          deltaSeconds,
        );
      }
    }
  }

  for (let x = 0; x < fields.width; x++) {
    for (let z = 0; z < fields.height; z++) {
      const index = x * fields.height + z;
      const currentFill = fields.fillField[index];
      const targetPresence = fields.targetPresenceField[index];
      const targetFill = fields.targetFillField[index];
      const currentVelocityX = fields.velocityXField[index];
      const currentVelocityZ = fields.velocityZField[index];
      const sampleX = x - currentVelocityX * tuning.velocityAdvection * deltaSeconds;
      const sampleZ = z - currentVelocityZ * tuning.velocityAdvection * deltaSeconds;
      const advectedFill = sampleScalarField(fields.fillField, fields.width, fields.height, sampleX, sampleZ);
      const advectedFoam = sampleScalarField(fields.foamField, fields.width, fields.height, sampleX, sampleZ);

      const leftFill = fields.fillField[Math.max(0, x - 1) * fields.height + z];
      const rightFill = fields.fillField[Math.min(fields.width - 1, x + 1) * fields.height + z];
      const upFill = fields.fillField[x * fields.height + Math.max(0, z - 1)];
      const downFill = fields.fillField[x * fields.height + Math.min(fields.height - 1, z + 1)];
      const neighborAverage = (leftFill + rightFill + upFill + downFill) * 0.25;
      const netMass = fields.visualMassDeltaField[index];
      const taitPressure = Math.max(
        0,
        tuning.taitStiffness * (Math.pow(advectedFill / tuning.taitRestDensity, 5) - 1),
      );
      const pressure =
        (taitPressure * 0.6 + (neighborAverage - advectedFill) * 0.4 + netMass * 2.2) *
        tuning.pressureResponse;
      const targetVelocityX =
        fields.targetVelocityXField[index] * fields.targetFlowField[index];
      const targetVelocityZ =
        fields.targetVelocityZField[index] * fields.targetFlowField[index];
      const interaction = fields.targetInteractionField[index];
      const gradientX = (leftFill - rightFill) * 0.5;
      const gradientZ = (upFill - downFill) * 0.5;
      const shoreDamping = 1 - fields.targetShoreField[index] * 0.24;
      const presenceMix = targetPresence > 0 ? tuning.targetPull : 0.03;
      let nextVelocityX =
        currentVelocityX * tuning.velocityDamping +
        targetVelocityX * presenceMix +
        gradientX * 0.2;
      let nextVelocityZ =
        currentVelocityZ * tuning.velocityDamping +
        targetVelocityZ * presenceMix +
        gradientZ * 0.2;
      nextVelocityX += pressure * Math.sign(gradientX || targetVelocityX || 1) * 0.08;
      nextVelocityZ += pressure * Math.sign(gradientZ || targetVelocityZ || 1) * 0.08;
      nextVelocityX += netMass * 0.9;
      nextVelocityZ += netMass * 0.9;
      nextVelocityX += targetVelocityX * interaction * tuning.interactionToFlow;
      nextVelocityZ += targetVelocityZ * interaction * tuning.interactionToFlow;
      nextVelocityX *= shoreDamping;
      nextVelocityZ *= shoreDamping;
      nextVelocityX = clampVelocity(nextVelocityX, tuning.velocityLimit);
      nextVelocityZ = clampVelocity(nextVelocityZ, tuning.velocityLimit);

      const fillRelaxation = targetPresence > 0 ? tuning.fillRelaxation : 0.08;
      let nextFill =
        (advectedFill * (1 - fillRelaxation) +
          neighborAverage * 0.12 +
          targetFill * fillRelaxation +
          currentFill * tuning.massRetention +
          netMass +
          pressure) *
        0.5;
      if (targetPresence <= 0) {
        nextFill *= tuning.edgeDecay;
      }
      nextFill = clamp01(nextFill);

      const speed = Math.sqrt(nextVelocityX * nextVelocityX + nextVelocityZ * nextVelocityZ);
      const foamSource =
        fields.targetTurbulenceField[index] * 0.24 +
        fields.targetShoreField[index] * 0.18 +
        speed * 0.12 +
        interaction * tuning.interactionToFoam +
        Math.abs(pressure) * 0.9 +
        fields.particleFoamField[index] * 0.9;
      const nextFoam = clamp01(Math.max(advectedFoam * tuning.foamDecay, foamSource));

      fields.fillFieldNext[index] = nextFill;
      fields.velocityXFieldNext[index] = nextVelocityX;
      fields.velocityZFieldNext[index] = nextVelocityZ;
      fields.foamFieldNext[index] = nextFoam;
      fields.pressureFieldNext[index] = clamp01(
        Math.abs(pressure) * 2.6 +
          Math.abs(netMass) * 3.1 +
          interaction * tuning.interactionToPressure,
      );
    }
  }

  return {
    ...fields,
    fillField: fields.fillFieldNext,
    fillFieldNext: fields.fillField,
    velocityXField: fields.velocityXFieldNext,
    velocityXFieldNext: fields.velocityXField,
    velocityZField: fields.velocityZFieldNext,
    velocityZFieldNext: fields.velocityZField,
    foamField: fields.foamFieldNext,
    foamFieldNext: fields.foamField,
    pressureField: fields.pressureFieldNext,
    pressureFieldNext: fields.pressureField,
  };
}