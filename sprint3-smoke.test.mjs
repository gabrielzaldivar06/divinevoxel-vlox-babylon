/**
 * sprint3-smoke.test.mjs
 * Self-contained smoke-test for Sprint 3: R02, R12, R16, R17, R19
 * No external imports — logic inlined from source to avoid BabylonJS/ESM issues.
 * Run with: node sprint3-smoke.test.mjs
 */

import assert from "node:assert/strict";

// ─── helpers ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`  ✅  ${label}`);
    passed++;
  } catch (e) {
    console.error(`  ❌  ${label}`);
    console.error(`       ${e.message}`);
    failed++;
  }
}

function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}

// ─── Inlined: TerrainMaterialFamily (from MaterialFamilyProfiles.ts) ──────────
const TerrainMaterialFamily = {
  Default: "default", Soil: "soil", Rock: "rock", Flora: "flora",
  Liquid: "liquid", Wood: "wood", Cultivated: "cultivated", Exotic: "exotic",
};

function classifyTerrainMaterial(id) {
  const l = id.toLowerCase();
  const isLiquid     = l.includes("liquid") || l.includes("foam") || l.includes("ether");
  const isTransparent= l.includes("transparent");
  const isGlow       = l.includes("glow");
  const isFlora      = l.includes("flora") || l.includes("grass") || l.includes("leaves") || l.includes("vine") || l.includes("wheat");
  const isCultivated = l.includes("farmland");
  const isSoil       = l.includes("dirt") || l.includes("mud") || l.includes("sand");
  const isWood       = l.includes("log") || l.includes("wood");
  const isExotic     = l.includes("dream") || l.includes("dread");
  const isRock       = l.includes("rock") || l.includes("stone") || l.includes("gravel") || l.includes("pillar");
  let family = TerrainMaterialFamily.Default;
  if (isLiquid) family = TerrainMaterialFamily.Liquid;
  else if (isFlora) family = TerrainMaterialFamily.Flora;
  else if (isCultivated) family = TerrainMaterialFamily.Cultivated;
  else if (isSoil) family = TerrainMaterialFamily.Soil;
  else if (isWood) family = TerrainMaterialFamily.Wood;
  else if (isExotic) family = TerrainMaterialFamily.Exotic;
  else if (isRock) family = TerrainMaterialFamily.Rock;
  return { id, family, isLiquid, isTransparent, isGlow, isFlora, isRock, isWood, isSoil, isCultivated, isExotic };
}

// ─── Inlined: getHighErosionPositions (from DissolutionSplatEmitter.ts) ───────
const STRIDE = 28;
const POS_X = 0, POS_Y = 1, POS_Z = 2;
const DISSOLUTION_PROXIMITY = 3;
const PROXIMITY_THRESHOLD = 0.35;

function getHighErosionPositions(vertices, sectionOrigin, maxCount = 30) {
  const [ox, oy, oz] = sectionOrigin;
  const vertexCount  = (vertices.length / STRIDE) | 0;
  const candidates   = [];
  for (let i = 0; i < vertexCount; i++) {
    const base = i * STRIDE;
    const proximity = vertices[base + DISSOLUTION_PROXIMITY];
    if (proximity < PROXIMITY_THRESHOLD) continue;
    candidates.push({ pos: [vertices[base+POS_X]+ox, vertices[base+POS_Y]+oy, vertices[base+POS_Z]+oz], prox: proximity });
  }
  candidates.sort((a, b) => b.prox - a.prox);
  if (candidates.length > maxCount) candidates.length = maxCount;
  return candidates.map((c) => c.pos);
}

// ─── R12 ─ getHighErosionPositions() ──────────────────────────────────────────
console.log("\n[R12] getHighErosionPositions");

// Build synthetic vertex buffer: 6 vertices × STRIDE=28 floats
const numVerts = 6;
const buf = new Float32Array(STRIDE * numVerts);

function setVertex(buf, i, x, y, z, prox) {
  const b = i * STRIDE;
  buf[b + 0] = x;
  buf[b + 1] = y;
  buf[b + 2] = z;
  buf[b + 3] = prox;
}

// v0: prox=0.90 (high, above threshold)
setVertex(buf, 0, 1.0, 2.0, 3.0, 0.90);
// v1: prox=0.25 (below threshold 0.35 — must be excluded)
setVertex(buf, 1, 9.0, 9.0, 9.0, 0.25);
// v2: prox=0.75  
setVertex(buf, 2, 4.0, 5.0, 6.0, 0.75);
// v3: prox=0.55
setVertex(buf, 3, 7.0, 8.0, 9.0, 0.55);
// v4: prox=0.34 (just below threshold — must be excluded)
setVertex(buf, 4, 0.5, 0.5, 0.5, 0.34);
// v5: prox=0.36 (just above threshold — must be included)
setVertex(buf, 5, 10.0, 11.0, 12.0, 0.36);

const origin = [100, 200, 300];

test("returns only vertices above threshold (0.35)", () => {
  const result = getHighErosionPositions(buf, origin, 100);
  // Qualifying: v0(0.90), v2(0.75), v3(0.55), v5(0.36). Excluded: v1(0.25), v4(0.34)
  assert.equal(result.length, 4, `expected 4 qualifying verts, got ${result.length}`);
});

test("world positions include sectionOrigin offset", () => {
  const result = getHighErosionPositions(buf, origin, 100);
  // v5 (local 10,11,12) → world 110,211,312
  const v5 = result.find(([x]) => approx(x, 110));
  assert.ok(v5, "v5 world-X not found");
  assert.ok(approx(v5[1], 211), `v5 world-Y expected 211, got ${v5[1]}`);
  assert.ok(approx(v5[2], 312), `v5 world-Z expected 312, got ${v5[2]}`);
});

test("results are sorted by proximity descending", () => {
  const result = getHighErosionPositions(buf, origin, 100);
  // Expected order: v0(0.90) > v2(0.75) > v3(0.55) > v5(0.36)
  // After filtering: v0, v2, v3, v5 sorted → v0 first, v5 last
  // world-X of top three: v0→101, v2→104, v3→107
  assert.ok(approx(result[0][0], 101.0), `1st should be v0 (x≈101), got x=${result[0][0]}`);
  assert.ok(approx(result[1][0], 104.0), `2nd should be v2 (x≈104), got x=${result[1][0]}`);
  assert.ok(approx(result[2][0], 107.0), `3rd should be v3 (x≈107), got x=${result[2][0]}`);
});

test("maxCount caps the result length", () => {
  const result = getHighErosionPositions(buf, origin, 2);
  assert.equal(result.length, 2, `expected 2, got ${result.length}`);
  // Top-2: v0(0.90) and v2(0.75)
  assert.ok(approx(result[0][0], 101), `1st x should be 101, got ${result[0][0]}`);
  assert.ok(approx(result[1][0], 104), `2nd x should be 104, got ${result[1][0]}`);
});

test("empty buffer returns []", () => {
  const result = getHighErosionPositions(new Float32Array(0), [0, 0, 0]);
  assert.deepEqual(result, []);
});

test("all below threshold returns []", () => {
  const all_low = new Float32Array(STRIDE * 3);
  // all prox default to 0
  const result = getHighErosionPositions(all_low, [0, 0, 0]);
  assert.deepEqual(result, []);
});

// ─── R19 ─ classifyTerrainMaterial ────────────────────────────────────────────
console.log("\n[R19] classifyTerrainMaterial");

test("rock material → family=rock, isRock=true", () => {
  const c = classifyTerrainMaterial("dve_rock_granite");
  assert.equal(c.family, TerrainMaterialFamily.Rock);
  assert.ok(c.isRock);
  assert.ok(!c.isSoil);
});

test("soil material → family=soil, isSoil=true", () => {
  const c = classifyTerrainMaterial("dve_soil_dirt");
  assert.equal(c.family, TerrainMaterialFamily.Soil);
  assert.ok(c.isSoil);
  assert.ok(!c.isRock);
});

test("liquid material → isLiquid=true, family=liquid", () => {
  const c = classifyTerrainMaterial("dve_liquid_water");
  assert.ok(c.isLiquid);
  assert.equal(c.family, TerrainMaterialFamily.Liquid);
});

test("flora material → isFlora=true, family=flora", () => {
  const c = classifyTerrainMaterial("dve_flora_grass");
  assert.ok(c.isFlora);
  assert.equal(c.family, TerrainMaterialFamily.Flora);
});

test("unknown id → family=default", () => {
  const c = classifyTerrainMaterial("totally_unknown_voxel_xyz");
  assert.equal(c.family, TerrainMaterialFamily.Default);
});

test("sand is classified as soil family (needed by R02 DVE_FAMILY_SAND)", () => {
  const c = classifyTerrainMaterial("dve_soil_sand");
  assert.ok(c.isSoil, "sand should be isSoil=true so R02 can set DVE_FAMILY_SAND");
});

// ─── R02 ─ DVE_FAMILY_SAND define condition (inline logic) ───────────────────
console.log("\n[R02] DVE_FAMILY_SAND define condition");

function evalSandDefine(isSoil, materialName) {
  // Mirrors: if (mc.isSoil && this.name.toLowerCase().includes("sand")) defines.DVE_FAMILY_SAND = true;
  return isSoil && materialName.toLowerCase().includes("sand");
}

test("soil sand → DVE_FAMILY_SAND = true", () => {
  assert.ok(evalSandDefine(true, "dve_soil_sand_beach"));
});

test("non-soil sand name → DVE_FAMILY_SAND = false", () => {
  assert.ok(!evalSandDefine(false, "dve_rock_sandstone"));
});

test("soil but no sand in name → DVE_FAMILY_SAND = false", () => {
  assert.ok(!evalSandDefine(true, "dve_soil_dirt"));
});

test("case-insensitive Sand match → DVE_FAMILY_SAND = true", () => {
  assert.ok(evalSandDefine(true, "dve_soil_SAND_Dunes"));
});

// ─── R02 ─ shore proximity GLSL logic (JS equivalent) ────────────────────────
console.log("\n[R02] Shore proximity math");

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function shoreProx(worldY, seaLevel = 32.0) {
  return Math.max(0, Math.min(1, 1 - smoothstep(seaLevel, seaLevel + 3.5, worldY)));
}

test("worldY far above seaLevel → shoreProx ≈ 0", () => {
  assert.ok(approx(shoreProx(40.0), 0.0, 1e-4), `shoreProx(40)=${shoreProx(40)}`);
});

test("worldY at seaLevel → shoreProx = 1.0", () => {
  assert.ok(approx(shoreProx(32.0), 1.0, 1e-4), `shoreProx(32)=${shoreProx(32)}`);
});

test("worldY at seaLevel+1.75 (midpoint) → shoreProx ≈ 0.5", () => {
  const sp = shoreProx(33.75); // seaLevel + 3.5/2
  assert.ok(approx(sp, 0.5, 0.01), `shoreProx(33.75)=${sp}`);
});

test("worldY at seaLevel+3.5 (top edge) → shoreProx ≈ 0", () => {
  assert.ok(approx(shoreProx(35.5), 0.0, 1e-4), `shoreProx(35.5)=${shoreProx(35.5)}`);
});

test("foam line peaks between proximity 0.12 and 0.28 (exclusive)", () => {
  // foamLine = smoothstep(0,0.1,sp) * (1-smoothstep(0.12,0.28,sp))
  function foamLine(sp) {
    return smoothstep(0, 0.1, sp) * (1 - smoothstep(0.12, 0.28, sp));
  }
  assert.ok(foamLine(0.0) < 0.01, `foamLine(0) should be ~0, got ${foamLine(0)}`);
  assert.ok(foamLine(0.195) > 0.5, `foamLine(0.195) should be > 0.5, got ${foamLine(0.195)}`);
  assert.ok(foamLine(1.0) < 0.01, `foamLine(1.0) should be ~0, got ${foamLine(1.0)}`);
});

// ─── R16 ─ sedimentary rock corner factor ────────────────────────────────────
console.log("\n[R16] Corner displacement factor");

const CORNER_DISPLACE_FACTOR = 0.22;

function getCornerFactor(isSedimentaryRock) {
  // Mirrors: const dve_cornerFactor = pullConfig.isSedimentaryRock ? 0.08 : CORNER_DISPLACE_FACTOR;
  return isSedimentaryRock ? 0.08 : CORNER_DISPLACE_FACTOR;
}

test("non-sedimentary rock → corner factor = 0.22 (organic pillow)", () => {
  assert.equal(getCornerFactor(false), 0.22);
});

test("sedimentary rock → corner factor = 0.08 (angular stratified)", () => {
  assert.equal(getCornerFactor(true), 0.08);
});

test("sedimentary corners are sharper than organic (0.08 < 0.22)", () => {
  assert.ok(getCornerFactor(true) < getCornerFactor(false));
});

// ─── R16 ─ strata GLSL math (JS equivalent) ───────────────────────────────────
console.log("\n[R16] Strata crack math");

function fract(x) { return x - Math.floor(x); }
function strataLine(worldY) {
  const t = fract(worldY * 0.65);
  // GLSL: 1 - smoothstep(0, 0.12, abs(t - 0.5) * 2)
  return 1 - smoothstep(0, 0.12, Math.abs(t - 0.5) * 2.0);
}

test("crack exists at strata seam (t≈0.5) → strataLine > 0.9", () => {
  // worldY where fract(y*0.65) ≈ 0.5 → y*0.65 mod 1 = 0.5 → y = 0.5/0.65 ≈ 0.769
  const y = 0.5 / 0.65;
  const sl = strataLine(y);
  assert.ok(sl > 0.9, `strataLine at seam should be > 0.9, got ${sl}`);
});

test("crack is near-zero between seams (t≈0.0 or t≈1.0)", () => {
  // fract(y*0.65) ≈ 0 → y ≈ 0 → crack = 0
  const sl = strataLine(0.0);
  assert.ok(sl < 0.05, `strataLine between seams should be < 0.05, got ${sl}`);
});

// ─── R17 ─ weather state ramp ──────────────────────────────────────────────────
console.log("\n[R17] Weather state ramp");

function weatherT(ws) {
  // Mirrors InitDVEBRPBR.ts onBeforeRenderObservable
  const dve_rAmt = Math.max(0, Math.min(1, (ws - 0.3) / 0.55));
  return dve_rAmt * dve_rAmt * (3 - 2 * dve_rAmt); // smoothstep
}

test("weatherState=0.0 → ramp=0 (clear sky)", () => {
  assert.ok(approx(weatherT(0.0), 0.0), `weatherT(0)=${weatherT(0)}`);
});

test("weatherState=0.3 → ramp=0 (onset threshold not yet exceeded)", () => {
  assert.ok(approx(weatherT(0.3), 0.0), `weatherT(0.3)=${weatherT(0.3)}`);
});

test("weatherState=0.85 → ramp=1.0 (full rain)", () => {
  assert.ok(approx(weatherT(0.85), 1.0), `weatherT(0.85)=${weatherT(0.85)}`);
});

test("weatherState=1.0 → ramp=1.0 (clamped full rain)", () => {
  assert.ok(approx(weatherT(1.0), 1.0), `weatherT(1.0)=${weatherT(1.0)}`);
});

test("weatherState=0.575 → ramp=0.5 (smoothstep midpoint)", () => {
  // midpoint: ws = 0.3 + 0.55/2 = 0.575 → rAmt=0.5 → smoothstep(0.5)=0.5
  assert.ok(approx(weatherT(0.575), 0.5, 1e-4), `weatherT(0.575)=${weatherT(0.575)}`);
});

test("clear sky: fogDensity unchanged (no multiplier at ramp=0)", () => {
  const base = 0.008;
  const fog = base * (1 + weatherT(0.0) * 0.65);
  assert.ok(approx(fog, base), `fog at clear=${fog}, expected ${base}`);
});

test("full rain: fogDensity increases +65%", () => {
  const base = 0.008;
  const fog = base * (1 + weatherT(1.0) * 0.65);
  assert.ok(approx(fog, base * 1.65, 1e-6), `fog at rain=${fog}, expected ${base * 1.65}`);
});

test("full rain: sunIntensity decreases -42%", () => {
  const base = 1.0;
  const sun = base * (1 - weatherT(1.0) * 0.42);
  assert.ok(approx(sun, 0.58), `sun at rain=${sun}, expected 0.58`);
});

test("full rain: SSR strength ≤ 1.0 (no overflow)", () => {
  const ssr = Math.min(0.82 + weatherT(1.0) * 0.18, 1.0);
  assert.ok(ssr <= 1.0, `ssr=${ssr} should be <= 1.0`);
  assert.ok(approx(ssr, 1.0), `ssr at full rain should be 1.0, got ${ssr}`);
});

test("weatherState=-1 (underflow) → ramp=0 (clamped)", () => {
  assert.ok(approx(weatherT(-1.0), 0.0), `weatherT(-1)=${weatherT(-1)}`);
});

test("weatherState=2.0 (overflow) → ramp=1.0 (clamped)", () => {
  assert.ok(approx(weatherT(2.0), 1.0), `weatherT(2.0)=${weatherT(2.0)}`);
});

// ─── summary ──────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(52)}`);
console.log(`Passed: ${passed}   Failed: ${failed}   Total: ${passed + failed}`);
if (failed > 0) {
  console.error("\n❌ Some tests failed.");
  process.exitCode = 1;
} else {
  console.log("\n✅ All tests passed.");
}
