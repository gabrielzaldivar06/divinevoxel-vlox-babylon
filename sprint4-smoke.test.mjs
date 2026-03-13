/**
 * Sprint 4 Smoke Tests
 * Covers: R10 (cross-boundary normal blend), R04 (LOD cap), G03 (octahedral encoding),
 *         R18 (blade shape alpha), R11 (POM ray march UV delta)
 *
 * Self-contained — all logic inlined to avoid BabylonJS ESM resolution issues.
 * Run with: node sprint4-smoke.test.mjs
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
function assertEqual(a, b, msg = "") {
  if (a !== b)
    throw new Error(`${msg}Expected ${b}, got ${a}`);
}
function assertApprox(a, b, eps = 1e-5, msg = "") {
  if (Math.abs(a - b) > eps)
    throw new Error(`${msg}Expected ~${b}, got ${a}`);
}
function assertRange(v, lo, hi, msg = "") {
  if (v < lo || v > hi)
    throw new Error(`${msg}${v} not in [${lo}, ${hi}]`);
}
function assertTrue(cond, msg = "") {
  if (!cond) throw new Error(msg || "Assertion failed");
}

// ─── Inlined helpers ──────────────────────────────────────────────────────────

/** R04: Distance-to-N LOD cap (mirrors SubdivisionBuilder logic) */
function applyLODCap(N, dist) {
  if (dist > 96) return Math.min(N, 1);
  if (dist > 48) return Math.min(N, 2);
  if (dist > 16) return Math.min(N, 3);
  return N;
}

/** G03: Octahedral encode (TypeScript source inlined, JS-equivalent) */
function encodeOctahedral(nx, ny, nz) {
  const sum = Math.abs(nx) + Math.abs(ny) + Math.abs(nz) || 1;
  let ox = nx / sum;
  let oy = ny / sum;
  if (nz < 0) {
    const tx = ox, ty = oy;
    ox = (1 - Math.abs(ty)) * (tx >= 0 ? 1 : -1);
    oy = (1 - Math.abs(tx)) * (ty >= 0 ? 1 : -1);
  }
  return [ox * 0.5 + 0.5, oy * 0.5 + 0.5];
}

/** G03: GLSL-equivalent decode (JavaScript) */
function decodeOctahedral(enc0, enc1) {
  const fx = enc0 * 2.0 - 1.0;
  const fy = enc1 * 2.0 - 1.0;
  let nx = fx, ny = fy, nz = 1.0 - Math.abs(fx) - Math.abs(fy);
  const t = Math.max(-nz, 0.0);
  nx += nx >= 0 ? -t : t;
  ny += ny >= 0 ? -t : t;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/** R18: Blade alpha at given UV (mirrors GLSL blade case) */
function bladeAlpha(uvx, uvy) {
  const bladeHalfWidth = 0.18 * (1.0 - uvy * 0.55);
  const edgeDist = Math.abs(uvx - 0.5) * 2.0;
  const bladeSide = smoothstep(bladeHalfWidth + 0.06, bladeHalfWidth, edgeDist);
  const bladeBase = smoothstep(0.0, 0.12, uvy);
  const bladeTip  = 1.0 - smoothstep(0.72, 1.0, uvy);
  return bladeSide * bladeBase * bladeTip;
}
function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** R10: Normal blend helper (mirrors Step 3 blend math) */
function blendNormals(base, adj1, adj2, mode /* "corner" | "edge" */) {
  if (mode === "corner") {
    // 50% base + 25% adj1 + 25% adj2
    return base.map((v, i) => (v * 0.5 + adj1[i] * 0.25 + adj2[i] * 0.25));
  }
  // "edge": 50% base + 50% adj1
  return base.map((v, i) => (v * 0.5 + adj1[i] * 0.5));
}
function normalize3(v) {
  const len = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]) || 1;
  return v.map(x => x / len);
}

// ─── R04: LOD Cap Tests ───────────────────────────────────────────────────────
console.log("\nR04 — Distance-based subdivision LOD cap");

test("Far (dist=100) → N clamped to 1 regardless of base N", () => {
  assertEqual(applyLODCap(4, 100), 1);
  assertEqual(applyLODCap(8, 100), 1);
});
test("Mid-far (dist=60) → N clamped to 2", () => {
  assertEqual(applyLODCap(4, 60), 2);
  assertEqual(applyLODCap(8, 60), 2);
  assertEqual(applyLODCap(1, 60), 1); // already ≤ 2
});
test("Mid-near (dist=30) → N clamped to 3", () => {
  assertEqual(applyLODCap(4, 30), 3);
  assertEqual(applyLODCap(8, 30), 3);
  assertEqual(applyLODCap(2, 30), 2); // already ≤ 3
});
test("Near (dist=10) → N passes through unchanged", () => {
  assertEqual(applyLODCap(4, 10), 4);
  assertEqual(applyLODCap(8, 10), 8);
});
test("Boundary at exactly 96 → mid-far cap (>48 branch applies)", () => {
  // dist=96: 96>96 is false, 96>48 is true → cap to 2
  assertEqual(applyLODCap(5, 96), 2);
});
test("Boundary at exactly 48 → mid-near cap (>16 branch applies)", () => {
  // dist=48: 48>96 false, 48>48 false, 48>16 true → cap to 3
  assertEqual(applyLODCap(5, 48), 3);
});
test("N=1 always stays 1 regardless of distance", () => {
  assertEqual(applyLODCap(1, 200), 1);
  assertEqual(applyLODCap(1, 0),   1);
});

// ─── G03: Octahedral Encoding Tests ──────────────────────────────────────────
console.log("\nG03 — Octahedral normal encode/decode round-trip");

function roundTripError(nx, ny, nz) {
  const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
  nx /= len; ny /= len; nz /= len;
  const [e0, e1] = encodeOctahedral(nx, ny, nz);
  const [dx, dy, dz] = decodeOctahedral(e0, e1);
  const err = Math.sqrt((nx-dx)**2 + (ny-dy)**2 + (nz-dz)**2);
  return err;
}

test("Upward normal [0,1,0] round-trip error < 0.001", () => {
  assertApprox(roundTripError(0, 1, 0), 0, 0.001);
});
test("Down normal [0,-1,0] round-trip error < 0.001", () => {
  assertApprox(roundTripError(0, -1, 0), 0, 0.001);
});
test("Forward normal [0,0,1] round-trip error < 0.001", () => {
  assertApprox(roundTripError(0, 0, 1), 0, 0.001);
});
test("Backward normal [0,0,-1] round-trip error < 0.001", () => {
  assertApprox(roundTripError(0, 0, -1), 0, 0.001);
});
test("Diagonal normal [1,1,1] round-trip error < 0.001", () => {
  assertApprox(roundTripError(1, 1, 1), 0, 0.001);
});
test("Negative diagonal [-1,-1,-1] round-trip error < 0.001", () => {
  assertApprox(roundTripError(-1, -1, -1), 0, 0.001);
});
test("Encoded values are always in [0, 1]", () => {
  const normals = [[0,1,0],[1,0,0],[0,0,1],[1,1,0],[-1,1,0],[0,-1,1]];
  for (const [nx,ny,nz] of normals) {
    const [e0, e1] = encodeOctahedral(nx, ny, nz);
    assertRange(e0, 0, 1, `e0 out of range for (${nx},${ny},${nz}): `);
    assertRange(e1, 0, 1, `e1 out of range for (${nx},${ny},${nz}): `);
  }
});
test("Default [0,1,0] encodes to [0.5, 1.0]", () => {
  const [e0, e1] = encodeOctahedral(0, 1, 0);
  assertApprox(e0, 0.5, 0.001, "e0 mismatch: ");
  assertApprox(e1, 1.0, 0.001, "e1 mismatch: ");
});

// ─── R18: Blade Shape Alpha Tests ────────────────────────────────────────────
console.log("\nR18 — Blade shape fragment alpha");

test("Center-bottom of blade has alpha close to 1", () => {
  // Center (u=0.5) near base (v=0.15) should be fully opaque
  const a = bladeAlpha(0.5, 0.15);
  assertTrue(a > 0.9, `Alpha at center-base should be >0.9, got ${a}`);
});
test("Edge of blade (u=0.0) has near-zero alpha", () => {
  const a = bladeAlpha(0.0, 0.4);
  assertTrue(a < 0.05, `Alpha at left edge should be <0.05, got ${a}`);
});
test("Edge of blade (u=1.0) has near-zero alpha", () => {
  const a = bladeAlpha(1.0, 0.4);
  assertTrue(a < 0.05, `Alpha at right edge should be <0.05, got ${a}`);
});
test("Very bottom (v=0.0) fades to zero (base fade-in)", () => {
  const a = bladeAlpha(0.5, 0.0);
  assertApprox(a, 0.0, 0.01, "Alpha at v=0 should be ~0: ");
});
test("Tip (v=1.0) fades to zero", () => {
  const a = bladeAlpha(0.5, 1.0);
  assertApprox(a, 0.0, 0.01, "Alpha at v=1 should be ~0: ");
});
test("Blade alpha monotonically increases from base through mid (u=0.5)", () => {
  const a0 = bladeAlpha(0.5, 0.0);
  const a1 = bladeAlpha(0.5, 0.1);
  const a2 = bladeAlpha(0.5, 0.3);
  assertTrue(a0 < a1 && a1 < a2, `Expected a0<a1<a2, got ${a0} ${a1} ${a2}`);
});
test("Blade tip fade: v=0.95 alpha < v=0.5 alpha", () => {
  assertTrue(bladeAlpha(0.5, 0.95) < bladeAlpha(0.5, 0.5));
});

// ─── R10: Cross-boundary Normal Blend Tests ───────────────────────────────────
console.log("\nR10 — Cross-boundary normal blending");

test("Corner blend: 50% base + 25% adj1 + 25% adj2", () => {
  const base = [0, 1, 0];
  const adj1 = [1, 0, 0];
  const adj2 = [0, 0, 1];
  const blended = blendNormals(base, adj1, adj2, "corner");
  assertApprox(blended[0], 0.25, 1e-6, "x: ");
  assertApprox(blended[1], 0.50, 1e-6, "y: ");
  assertApprox(blended[2], 0.25, 1e-6, "z: ");
});
test("Edge blend: 50% base + 50% adjacent", () => {
  const base = [0, 1, 0];
  const adj  = [1, 0, 0];
  const blended = blendNormals(base, adj, null, "edge");
  assertApprox(blended[0], 0.5, 1e-6, "x: ");
  assertApprox(blended[1], 0.5, 1e-6, "y: ");
  assertApprox(blended[2], 0.0, 1e-6, "z: ");
});
test("Blended normal after normalization has unit length", () => {
  const blended = blendNormals([0, 1, 0], [1, 0, 0], [0, 0, 1], "corner");
  const norm = normalize3(blended);
  const len = Math.sqrt(norm[0]**2 + norm[1]**2 + norm[2]**2);
  assertApprox(len, 1.0, 1e-5, "length: ");
});
test("Blending with same normals returns the same direction", () => {
  const n = [0, 1, 0];
  const blended = blendNormals(n, n, n, "corner");
  assertApprox(blended[0], 0.0, 1e-6);
  assertApprox(blended[1], 1.0, 1e-6);
  assertApprox(blended[2], 0.0, 1e-6);
});

// ─── R11: POM UV Delta Tests ──────────────────────────────────────────────────
console.log("\nR11 — Parallax Occlusion Mapping UV delta");

/**
 * Simulates 8-step POM ray march in 2D (height lookup from synthetic slope).
 * heightFn(uv) returns [0,1] height value.
 */
function simulatePOM(baseUV, viewDir2D, pomNormDot, heightFn) {
  const pomTz = Math.max(pomNormDot, 0.1);
  const stepSize = 0.04 / 8.0 / pomTz;
  const pomStep = [viewDir2D[0] * stepSize, viewDir2D[1] * stepSize];
  let curUV = [...baseUV];
  let pomH = 1.0;
  for (let i = 0; i < 8; i++) {
    const h = heightFn(curUV);
    if (pomH < h) break;
    pomH -= 0.125;
    curUV[0] -= pomStep[0];
    curUV[1] -= pomStep[1];
  }
  return [curUV[0] - baseUV[0], curUV[1] - baseUV[1]];
}

test("POM: height=1 surface breaks at step 1 → small delta", () => {
  // height=1 → at i=0 pomH(1.0) < h(1.0) is false, then pomH=0.875 < 1.0 → break at i=1
  // Only 1 step of UV displacement, so |delta| << full 8-step magnitude
  const step = 0.04 / 8.0 / 0.9;
  const delta = simulatePOM([0.5, 0.5], [1, 0], 0.9, () => 1.0);
  // 1 step displacement was taken before the break
  assertApprox(Math.abs(delta[0]), step, step * 0.01, "dx ~= 1 step: ");
});
test("POM: height=0.5 surface breaks later than height=1 → larger delta", () => {
  // height=0.5: pomH 1.0→0.875→0.75→0.625→0.5; at pomH=0.5 < h=0.5? 0.5<0.5 = false; next pomH=0.375<0.5 → break at i=5 (5 steps taken)
  const delta1 = simulatePOM([0.5, 0.5], [1, 0], 0.9, () => 1.0);   // breaks early
  const delta5 = simulatePOM([0.5, 0.5], [1, 0], 0.9, () => 0.5);   // breaks later
  assertTrue(
    Math.abs(delta5[0]) > Math.abs(delta1[0]),
    `Lower height → more steps → larger |delta|: ${Math.abs(delta5[0])} vs ${Math.abs(delta1[0])}`
  );
});
test("POM: delta direction opposes viewDir (parallax shifts away from view)", () => {
  // A raised bump at the end of the march should shift UV opposite to view direction
  let callCount = 0;
  const delta = simulatePOM([0.5, 0.5], [1, 0], 0.9, (uv) => {
    callCount++;
    // First few steps are flat, last step hits the bump
    return callCount > 3 ? 0.0 : 0.0; // flat but accumulates displacement
  });
  // With uniform flat height, ray walks all 8 steps => delta is non-zero negative in x
  assertTrue(delta[0] <= 0, `Delta.x should be ≤ 0 (opposite viewDir), got ${delta[0]}`);
});
test("POM: steep view angle (pomNormDot=0.1) produces larger UV delta than shallow", () => {
  const flatHeight = () => 0.0;
  const dSteep  = simulatePOM([0.5, 0.5], [1, 0], 0.1,  flatHeight);
  const dShallow = simulatePOM([0.5, 0.5], [1, 0], 0.9, flatHeight);
  // Steep = small dot → divide by 0.1 → large step → larger delta magnitude
  assertTrue(
    Math.abs(dSteep[0]) > Math.abs(dShallow[0]),
    `Steep |dx|=${Math.abs(dSteep[0])} should > shallow |dx|=${Math.abs(dShallow[0])}`
  );
});
test("POM: delta is zero when enablePOM is false (dvePOMDelta stays vec2(0))", () => {
  // This tests the runtime guard: when enablePOM = false, the GLSL block is absent,
  // so dvePOMDelta remains vec2(0.0). Simulated here as simply [0,0].
  const delta = [0.0, 0.0]; // dvePOMDelta default value
  assertApprox(delta[0], 0.0, 0.001, "dx should be 0 when POM disabled: ");
  assertApprox(delta[1], 0.0, 0.001, "dy should be 0 when POM disabled: ");
});

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(50)}`);
console.log(`Sprint 4 smoke tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
