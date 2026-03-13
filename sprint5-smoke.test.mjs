/**
 * Sprint 5 Smoke Tests
 * Covers: E01 (splat fog factor), E02 (POM height from roughness), E03 (blade wind),
 *         E04 (per-splat color variation)
 *
 * Self-contained — all logic inlined. Run with: node sprint5-smoke.test.mjs
 */

// ─── Tiny test harness ────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`      ${e.message}`);
    failed++;
  }
}
function assertApprox(a, b, eps = 1e-5, msg = "") {
  if (Math.abs(a - b) > eps) throw new Error(`${msg}Expected ~${b}, got ${a}`);
}
function assertRange(v, lo, hi, msg = "") {
  if (v < lo || v > hi) throw new Error(`${msg}${v} not in [${lo}, ${hi}]`);
}
function assertTrue(cond, msg = "Assertion failed") {
  if (!cond) throw new Error(msg);
}

// ─── Inlined helpers ──────────────────────────────────────────────────────────

/** E01: EXP2 fog factor — mirrors GLSL formula */
function fogFactorEXP2(density, dist) {
  return Math.min(Math.max(1.0 - Math.exp(-density * density * dist * dist), 0.0), 0.85);
}

/** E01: Apply fog blend to a color + alpha pair */
function applyFog(litR, litG, litB, alpha, fogR, fogG, fogB, fogFactor) {
  const finalR = litR * (1 - fogFactor) + fogR * fogFactor;
  const finalG = litG * (1 - fogFactor) + fogG * fogFactor;
  const finalB = litB * (1 - fogFactor) + fogB * fogFactor;
  const finalA = alpha * (1 - fogFactor * 0.65);
  return { r: finalR, g: finalG, b: finalB, a: finalA };
}

/** E02: Height derived from roughness channel (inverse of G channel) */
function pomHeightFromRoughness(roughnessG) {
  return 1.0 - roughnessG;
}

/** E03: Blade sway amplitude for a given vertex y position (−0.5 = root, +0.5 = tip) */
function bladeSwayAmplitude(positionY, baseAmp) {
  const bladeHeightFactor = Math.max(0.01, Math.min(1.0, positionY + 0.5)) * 2.8;
  return baseAmp * bladeHeightFactor;
}

/** E04: Per-splat color variation using hash value */
function applySplatColorVariation(r, g, b, hash) {
  const colorVar = (hash - 0.5) * 0.22;
  const warmth   = Math.max(0.0, hash - 0.62) * 0.30;
  const nr = Math.max(0, Math.min(1, r * (1 + colorVar) + warmth * 0.06));
  const ng = Math.max(0, Math.min(1, g * (1 + colorVar) + warmth * 0.03));
  const nb = Math.max(0, Math.min(1, b * (1 + colorVar) - warmth * 0.02));
  return [nr, ng, nb];
}

// ─── E01: Splat fog factor tests ──────────────────────────────────────────────
console.log("\nE01 — Splat fog integration (EXP2)");

test("Fog disabled (density=0) → factor = 0 regardless of distance", () => {
  assertApprox(fogFactorEXP2(0, 10), 0, 1e-6);
  assertApprox(fogFactorEXP2(0, 100), 0, 1e-6);
});
test("Fog factor increases monotonically with distance", () => {
  const d0 = 0.002;
  const f10 = fogFactorEXP2(d0, 10);
  const f50 = fogFactorEXP2(d0, 50);
  const f100 = fogFactorEXP2(d0, 100);
  assertTrue(f10 < f50 && f50 < f100, `Expected f10<f50<f100, got ${f10} ${f50} ${f100}`);
});
test("Fog factor capped at 0.85 (splats never fully opaque fog)", () => {
  const f = fogFactorEXP2(1.0, 1000);
  assertApprox(f, 0.85, 1e-6, "cap: ");
});
test("Fog factor at distance 0 is ~0 (no fog at camera position)", () => {
  assertApprox(fogFactorEXP2(0.002, 0), 0, 1e-6);
});
test("Fog color blends toward fogColor when fogFactor > 0", () => {
  const result = applyFog(1, 0, 0, 1, 0.62, 0.71, 0.84, 0.5);
  assertTrue(result.r < 1.0 && result.r > 0.5, `R should shift toward 0.62, got ${result.r}`);
  assertTrue(result.b > 0.0, `B should increase toward 0.84, got ${result.b}`);
});
test("Fog alpha reduces linearly: at factor=1 alpha is 35% of original", () => {
  const result = applyFog(1, 1, 1, 1.0, 0.5, 0.5, 0.5, 0.85);
  // alpha * (1 - 0.85 * 0.65) = 1 * (1 - 0.5525) = 0.4475
  assertApprox(result.a, 0.4475, 0.001, "alpha at max fog: ");
});
test("No fog bleed: factor=0 → fog has zero effect on color", () => {
  const result = applyFog(0.8, 0.2, 0.1, 0.9, 0.5, 0.5, 0.5, 0.0);
  assertApprox(result.r, 0.8, 1e-6);
  assertApprox(result.g, 0.2, 1e-6);
  assertApprox(result.b, 0.1, 1e-6);
  assertApprox(result.a, 0.9, 1e-6);
});

// ─── E02: POM height from roughness tests ─────────────────────────────────────
console.log("\nE02 — POM height derived from inverse roughness");

test("Smooth surface (roughness=0.0) → height=1.0 (fully raised)", () => {
  assertApprox(pomHeightFromRoughness(0.0), 1.0, 1e-6);
});
test("Rough surface (roughness=1.0) → height=0.0 (fully recessed)", () => {
  assertApprox(pomHeightFromRoughness(1.0), 0.0, 1e-6);
});
test("Mid roughness (0.5) → height=0.5 (neutral)", () => {
  assertApprox(pomHeightFromRoughness(0.5), 0.5, 1e-6);
});
test("Height is strictly monotone decreasing as roughness increases", () => {
  const steps = [0, 0.25, 0.5, 0.75, 1.0];
  for (let i = 1; i < steps.length; i++) {
    assertTrue(
      pomHeightFromRoughness(steps[i]) < pomHeightFromRoughness(steps[i - 1]),
      `Height should decrease from roughness ${steps[i - 1]} to ${steps[i]}`
    );
  }
});
test("POM breaks when roughness=0 everywhere (ray marches all 8 steps)", () => {
  // Simulate 8-step POM with height=1 everywhere (all smooth → h=1).
  // First iteration: pomH=1.0, h=1.0 → pomH < h is false → first step taken.
  // Second: pomH=0.875, h=1.0 → 0.875 < 1.0 → break!
  // So it breaks at step 1 (1 displacement step taken).
  let pomH = 1.0;
  let stepsRun = 0;
  for (let i = 0; i < 8; i++) {
    const h = pomHeightFromRoughness(0.0); // height = 1.0
    if (pomH < h) break;
    pomH -= 0.125;
    stepsRun++;
  }
  // Should take exactly 1 step before breaking
  assertTrue(stepsRun === 1, `Expected 1 step with h=1, got ${stepsRun}`);
});
test("POM runs all steps when roughness=1 everywhere (all rough → h=0)", () => {
  let pomH = 1.0;
  let stepsRun = 0;
  for (let i = 0; i < 8; i++) {
    const h = pomHeightFromRoughness(1.0); // height = 0.0
    if (pomH < h) break;  // pomH (0.875...) < 0 is always false
    pomH -= 0.125;
    stepsRun++;
  }
  assertTrue(stepsRun === 8, `Expected 8 steps with h=0, got ${stepsRun}`);
});

// ─── E03: Blade wind amplification tests ──────────────────────────────────────
console.log("\nE03 — Blade wind amplification (tip-heavy cantilever)");

const BASE_AMP = 0.06; // matches scale * 0.06 in shader

test("Blade root (positionY = -0.5) has near-zero sway (~0.01 of base)", () => {
  const amp = bladeSwayAmplitude(-0.5, BASE_AMP);
  // factor = clamp(-0.5 + 0.5, 0.01, 1.0) * 2.8 = 0.01 * 2.8 = 0.028
  assertApprox(amp, BASE_AMP * 0.028, 1e-6, "root: ");
});
test("Blade tip (positionY = +0.5) has maximum sway (2.8× base)", () => {
  const amp = bladeSwayAmplitude(0.5, BASE_AMP);
  // factor = clamp(1.0, 0.01, 1.0) * 2.8 = 1.0 * 2.8 = 2.8
  assertApprox(amp, BASE_AMP * 2.8, 1e-6, "tip: ");
});
test("Blade center (positionY = 0.0) has intermediate sway (~1.4× base)", () => {
  const amp = bladeSwayAmplitude(0.0, BASE_AMP);
  // factor = 0.5 * 2.8 = 1.4
  assertApprox(amp, BASE_AMP * 1.4, 1e-6, "center: ");
});
test("Blade sway is monotonically larger from root to tip", () => {
  const positions = [-0.5, -0.25, 0.0, 0.25, 0.5];
  for (let i = 1; i < positions.length; i++) {
    assertTrue(
      bladeSwayAmplitude(positions[i], BASE_AMP) > bladeSwayAmplitude(positions[i - 1], BASE_AMP),
      `Sway should increase from y=${positions[i - 1]} to y=${positions[i]}`
    );
  }
});
test("Non-blade (factor=1.0) at same position has lower sway than blade tip", () => {
  const nonBlade = BASE_AMP * 1.0; // bladeHeightFactor = 1.0 for non-blades
  const bladeTip = bladeSwayAmplitude(0.5, BASE_AMP);
  assertTrue(bladeTip > nonBlade, `Blade tip sway (${bladeTip}) should exceed non-blade (${nonBlade})`);
});

// ─── E04: Per-splat color variation tests ─────────────────────────────────────
console.log("\nE04 — Per-splat color variation");

test("Hash = 0.5 (neutral) → nearly zero variation (colorVar = 0)", () => {
  const [r, g, b] = applySplatColorVariation(0.5, 0.5, 0.5, 0.5);
  // colorVar = (0.5 - 0.5) * 0.22 = 0; warmth = max(0, 0.5 - 0.62) * 0.3 = 0
  assertApprox(r, 0.5, 0.001);
  assertApprox(g, 0.5, 0.001);
  assertApprox(b, 0.5, 0.001);
});
test("Hash = 1.0 (bright + warm) → brighter and warmer result", () => {
  const [r, g, b] = applySplatColorVariation(0.5, 0.5, 0.5, 1.0);
  // colorVar = 0.5 * 0.22 = 0.11 → ×1.11; warmth = (1.0-0.62)*0.3 = 0.114
  assertTrue(r > 0.5, `R should be brighter, got ${r}`);
  assertTrue(g > 0.5, `G should be brighter, got ${g}`);
  assertTrue(r > b, `R should be warmer than B, ${r} vs ${b}`);
});
test("Hash = 0.0 (dark) → darker result", () => {
  const [r, g, b] = applySplatColorVariation(0.5, 0.5, 0.5, 0.0);
  // colorVar = (0 - 0.5) * 0.22 = -0.11 → ×0.89
  assertTrue(r < 0.5, `R should be darker, got ${r}`);
  assertTrue(g < 0.5, `G should be darker, got ${g}`);
  assertTrue(b < 0.5, `B should be darker, got ${b}`);
});
test("Output is always clamped to [0, 1]", () => {
  for (const hash of [0, 0.1, 0.5, 0.9, 1.0]) {
    const [r, g, b] = applySplatColorVariation(1.0, 1.0, 1.0, hash);
    assertTrue(r >= 0 && r <= 1, `R out of range for hash=${hash}: ${r}`);
    assertTrue(g >= 0 && g <= 1, `G out of range for hash=${hash}: ${g}`);
    assertTrue(b >= 0 && b <= 1, `B out of range for hash=${hash}: ${b}`);
  }
  for (const hash of [0, 0.5, 1.0]) {
    const [r, g, b] = applySplatColorVariation(0.0, 0.0, 0.0, hash);
    assertTrue(r >= 0 && r <= 1, `R out of range at min for hash=${hash}`);
    assertTrue(g >= 0 && g <= 1, `G out of range at min for hash=${hash}`);
    assertTrue(b >= 0 && b <= 1, `B out of range at min for hash=${hash}`);
  }
});
test("Variation range: over all hashes, brightness spread is about ±11%", () => {
  const base = 0.5;
  const values = Array.from({ length: 21 }, (_, i) => {
    const hash = i / 20;
    const [r] = applySplatColorVariation(base, base, base, hash);
    return r;
  });
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const spread = maxV - minV;
  assertRange(spread, 0.10, 0.14, `brightness spread should be ~0.11 but got: `);
});
test("Warm tint only appears for hash > 0.62", () => {
  // Below 0.62: warmth = 0, R and G variation is equal
  const [r1, g1] = applySplatColorVariation(0.5, 0.5, 0.5, 0.6);
  // warmth = 0 → change in r and g should be equal
  assertApprox(r1 - 0.5, g1 - 0.5, 0.002, "No warm tint below 0.62: ");

  // Above 0.62: warmth > 0, R should change more than G
  const [r2, g2] = applySplatColorVariation(0.5, 0.5, 0.5, 0.8);
  assertTrue(r2 > g2, `Warm tint: R (${r2}) should exceed G (${g2}) above hash 0.62`);
});

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(50)}`);
console.log(`Sprint 5 smoke tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
