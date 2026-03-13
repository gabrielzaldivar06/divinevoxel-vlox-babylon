/**
 * DVEGaussianSplatRenderer — Fase 3 Entregable 3.3, 3.7
 *
 * Evolved from DVEGaussianSplatProto: sector-keyed static splat management,
 * dynamic splat placeholder (Fase 5), pool management with pre-allocated
 * Float32Array, and material-family shape variation in the fragment shader.
 *
 * Integration: runs ALONGSIDE the normal voxel pipeline.
 * Uses Thin Instances of a single master quad for GPU throughput.
 */

import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Effect } from "@babylonjs/core/Materials/effect";
import { Engine } from "@babylonjs/core/Engines/engine";

// ─────────────────────────────────────────────────
// 1. GLSL Shaders (with shape variation — Entregable 3.7)
// ─────────────────────────────────────────────────

const SPLAT_VERTEX = /* glsl */ `#version 300 es
precision highp float;

// Per-vertex (unit quad)
in vec3 position;
in vec2 uv;

// Per-instance (Thin Instances custom buffers)
// splatData: 4 floats per instance
//   [0] = scale     (world-space radius)
//   [1] = opacity   (0..1 peak alpha)
//   [2] = colorPacked (R8G8B8 packed as float via intBitsToFloat)
//   [3] = shapeType (0 circular, 1 irregular, 2 angular, 3 elongated, 4 blade)
// splatOctNormal: 2 floats per instance — G03 octahedral-encoded surface normal

in vec4 splatData;
in vec2 splatOctNormal; // G03: octahedral-encoded per-splat surface normal

#ifdef INSTANCES
in vec4 world0;
in vec4 world1;
in vec4 world2;
in vec4 world3;
#endif

uniform mat4 viewProjection;
uniform mat4 view;
uniform vec3 dveSplatCamPos;
uniform vec3 dveSplatSunDir;
uniform float dveSplatFadeNear;
uniform float dveSplatFadeFar;
uniform float dveSplatTime;
// E01: Scene fog uniforms — match BabylonJS FOGMODE_EXP2
uniform vec3 dveSplatFogColor;
uniform float dveSplatFogDensity;

out vec2 vUV;
out float vOpacity;
out vec3 vColor;
out float vShapeType;
out float vNdotL;
out float vBacklight;
out float vFogFactor; // E01: EXP2 fog factor (0=clear, 1=fully fogged)

vec3 unpackColor(float packed) {
  uint bits = floatBitsToUint(packed);
  return vec3(
    float((bits >> 16u) & 0xFFu) / 255.0,
    float((bits >> 8u)  & 0xFFu) / 255.0,
    float( bits         & 0xFFu) / 255.0
  );
}

// G03: Decode octahedral-encoded normal (2 floats → unit vec3)
vec3 dve_decodeOctahedral(vec2 enc) {
  vec2 f = enc * 2.0 - 1.0;
  vec3 n = vec3(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
  float t = clamp(-n.z, 0.0, 1.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return normalize(n);
}

void main() {
#ifdef INSTANCES
  mat4 worldMat = mat4(world0, world1, world2, world3);
#else
  mat4 worldMat = mat4(1.0);
#endif

  float scale     = splatData.x;
  vOpacity        = splatData.y;
  vColor          = unpackColor(splatData.z);
  vShapeType      = splatData.w;

  // Billboard
  vec3 camRight = vec3(view[0][0], view[1][0], view[2][0]);
  vec3 camUp    = vec3(view[0][1], view[1][1], view[2][1]);

  // Elongated (type 3) and blade (type 4) shapes stretch Y by 2.5 in the shader
  float yStretch = vShapeType > 2.5 ? 2.5 : 1.0;

  vec3 worldCenter = (worldMat * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

  // R05: Compute camera distance first so we can apply size variation before billboard
  float camDist = length(worldCenter - dveSplatCamPos);

  // R05: Distance-based scale variation — distant splats grow to maintain apparent coverage.
  // At 20 m the splat is native size; at 80 m it grows to 2.5× to remain visible.
  float distScale = 1.0 + smoothstep(20.0, 80.0, camDist) * 1.5;
  scale *= distScale;

  // G02: Micro-movement — gentle sway based on world position hash
  float splatHash = fract(sin(dot(worldCenter.xz, vec2(12.9898, 78.233))) * 43758.5453);

  // E04: Per-splat brightness/warmth variation using position hash for natural non-uniformity.
  // Breaks up the "uniform tile" look when many splats of the same voxel are visible.
  float dve_colorVar = (splatHash - 0.5) * 0.22;       // \u00b111% brightness shift
  float dve_warmth   = max(0.0, splatHash - 0.62) * 0.30; // subtle warm tint on 38% of splats
  vColor = clamp(
    vColor * (1.0 + dve_colorVar) + vec3(dve_warmth * 0.06, dve_warmth * 0.03, -dve_warmth * 0.02),
    0.0, 1.0
  );

  // E03: Blade wind — tip-heavy horizontal-only sway.
  // position.y ranges -0.5 (root) to +0.5 (tip); tip of blade moves 2.8\u00d7 more than root.
  // Non-blade shapes (type \u22643.5) keep the standard symmetric sway.
  float bladeHeightFactor = vShapeType > 3.5 ? clamp(position.y + 0.5, 0.01, 1.0) * 2.8 : 1.0;
  float swayX = sin(dveSplatTime * 0.8 + splatHash * 6.28) * scale * 0.06 * bladeHeightFactor;
  float swayY = vShapeType > 3.5 ? 0.0 : sin(dveSplatTime * 1.1 + splatHash * 3.14) * scale * 0.04;
  vec3 offsetPos   = worldCenter
                   + camRight * (position.x * scale + swayX)
                   + camUp    * (position.y * scale * yStretch + swayY);

  // E01: EXP2 fog factor — matches BabylonJS FOGMODE_EXP2 formula, capped at 0.85 so splats
  // never become 100% opaque fog (they should dissolve, not teleport into a wall of color).
  vFogFactor = clamp(1.0 - exp(-dveSplatFogDensity * dveSplatFogDensity * camDist * camDist), 0.0, 0.85);

  // G01+G03: N·L using per-splat decoded octahedral normal (replaces hardcoded hemisphere approx)
  vec3 splatNormal = dve_decodeOctahedral(splatOctNormal);
  vec3 sunDir = normalize(-dveSplatSunDir);
  vNdotL = max(0.0, dot(splatNormal, sunDir) * 0.5 + 0.5);
  vec3 viewDir = normalize(dveSplatCamPos - worldCenter);
  vBacklight = max(0.0, dot(viewDir, sunDir)) * 0.3;

  gl_Position = viewProjection * vec4(offsetPos, 1.0);
  vUV = uv;

  // Distance fade: reduce opacity in transition bands
  float distFade = 1.0 - smoothstep(dveSplatFadeNear, dveSplatFadeFar, camDist);
  vOpacity *= distFade;
}
`;

const SPLAT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUV;
in float vOpacity;
in vec3 vColor;
in float vShapeType;
in float vNdotL;
in float vBacklight;
in float vFogFactor;    // E01: pre-computed EXP2 fog factor
uniform vec3 dveSplatFogColor; // E01: scene fog colour

out vec4 fragColor;

// Simple hash for splat seed
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 centered = vUV * 2.0 - 1.0;
  float r2 = dot(centered, centered);
  // R18: Blade (type 4) uses full-quad UV space — skip the unit-circle clip
  if (r2 > 1.0 && vShapeType < 3.5) discard;

  float sharpness = 3.0;
  float alpha;

  if (vShapeType < 0.5) {
    // 0 — Circular: standard gaussian
    alpha = exp(-r2 * sharpness);
  } else if (vShapeType < 1.5) {
    // 1 — Irregular (soil): gaussian + noise disruption
    float seed = hash12(gl_FragCoord.xy * 0.01);
    float noise = hash12(centered * 3.0 + seed);
    alpha = exp(-r2 * sharpness) * step(0.3, noise);
  } else if (vShapeType < 2.5) {
    // 2 — Angular (rock): box falloff
    alpha = 1.0 - smoothstep(0.3, 0.5, max(abs(centered.x), abs(centered.y)));
  } else if (vShapeType < 3.5) {
    // 3 — Elongated (flora): stretched gaussian
    vec2 stretched = vec2(centered.x * 2.5, centered.y);
    alpha = exp(-dot(stretched, stretched) * sharpness);
  } else {
    // 4 — R18 Blade: tall thin vertical billboard, bottom-anchored, tapers to tip
    // vUV.x = 0..1 across width; vUV.y = 0(bottom)..1(top)
    float bladeHalfWidth = 0.18 * (1.0 - vUV.y * 0.55); // narrows toward tip
    float edgeDist = abs(vUV.x - 0.5) * 2.0; // 0 = center, 1 = edge
    float bladeSide = smoothstep(bladeHalfWidth + 0.06, bladeHalfWidth, edgeDist);
    float bladeBase = smoothstep(0.0, 0.12, vUV.y); // fade in from root
    float bladeTip  = 1.0 - smoothstep(0.72, 1.0, vUV.y); // fade at tip
    alpha = bladeSide * bladeBase * bladeTip;
  }

  alpha *= vOpacity;
  if (alpha < 0.01) discard;

  // G01: Apply SSS-style lighting to splat color
  float splatLighting = 0.25 + vNdotL * 0.55 + vBacklight;
  vec3 litColor = vColor * splatLighting;
  // SSS warmth: backlit splats get warm tint
  litColor += vColor * vec3(1.4, 0.9, 0.7) * vBacklight * 0.3;

  // E01: Apply scene fog — blend lit colour toward fog colour and bleed out alpha.
  // dveSplatFogDensity is 0 when fog is disabled, so this is a no-op in clear air.
  vec3 finalLit   = mix(litColor,  dveSplatFogColor, vFogFactor);
  float finalAlpha = alpha * (1.0 - vFogFactor * 0.65);

  fragColor = vec4(finalLit * finalAlpha, finalAlpha);
}
`;

// ─────────────────────────────────────────────────
// 2. Public Types
// ─────────────────────────────────────────────────

export interface SplatInstance {
  /** World-space position [x, y, z] */
  position: [number, number, number];
  /** World-space radius */
  scale: number;
  /** Peak opacity 0..1 */
  opacity: number;
  /** RGB color [0..255, 0..255, 0..255] */
  color: [number, number, number];
  /** Shape: 0 circular, 1 irregular, 2 angular, 3 elongated, 4 blade (R18) */
  shape: number;
  /** G03: Surface normal [x,y,z] — used for per-splat N·L lighting. Default [0,1,0]. */
  normal?: [number, number, number];
}

// ─────────────────────────────────────────────────
// 3. Renderer Class
// ─────────────────────────────────────────────────

export class DVEGaussianSplatRenderer {
  private _masterQuad: Mesh;
  private _material: ShaderMaterial;
  private _matrixBuffer: Float32Array;
  private _splatBuffer: Float32Array;
  /** G03: Per-instance octahedral-encoded splat normal (2 floats each) */
  private _normalBuffer: Float32Array;
  private _totalInstanceCount = 0;
  private _dirty = true;

  /** Sector key → static SplatInstance[] */
  private _staticSplats = new Map<string, SplatInstance[]>();
  /** Dynamic splats (Fase 5 placeholder) */
  private _dynamicSplats: SplatInstance[] = [];

  /** Distance fade near/far thresholds. */
  private _fadeNear = 40;
  private _fadeFar = 90;

  constructor(
    private _scene: Scene,
    private _maxSplats: number = 50_000
  ) {
    this._registerShaders();
    this._material = this._createMaterial();
    this._masterQuad = this._createMasterQuad();
    this._matrixBuffer = new Float32Array(this._maxSplats * 16);
    this._splatBuffer  = new Float32Array(this._maxSplats * 4);
    this._normalBuffer = new Float32Array(this._maxSplats * 2); // G03: oct-encoded normals
  }

  // ── Shader Registration ──
  private _registerShaders() {
    Effect.ShadersStore["dveSplatVertexShader"] = SPLAT_VERTEX;
    Effect.ShadersStore["dveSplatFragmentShader"] = SPLAT_FRAGMENT;
  }

  // ── Material ──
  private _createMaterial(): ShaderMaterial {
    const mat = new ShaderMaterial("dveSplatMat", this._scene, {
      vertex: "dveSplat",
      fragment: "dveSplat",
    }, {
      attributes: [
        "position", "uv",
        "world0", "world1", "world2", "world3",
        "splatData",
        "splatOctNormal", // G03: per-instance octahedral-encoded normal
      ],
      uniforms: ["viewProjection", "view", "dveSplatCamPos", "dveSplatSunDir", "dveSplatFadeNear", "dveSplatFadeFar", "dveSplatTime",
                 "dveSplatFogDensity", "dveSplatFogColor"], // E01: fog uniforms
      defines: ["INSTANCES"],
    });

    mat.disableDepthWrite = true;
    mat.backFaceCulling = false;
    mat.alphaMode = Engine.ALPHA_ADD;

    return mat;
  }

  // ── Master Quad Geometry ──
  private _createMasterQuad(): Mesh {
    const mesh = new Mesh("dveSplatQuad", this._scene);
    const vd = new VertexData();
    vd.positions = [
      -0.5, -0.5, 0,
       0.5, -0.5, 0,
       0.5,  0.5, 0,
      -0.5,  0.5, 0,
    ];
    vd.indices = [0, 1, 2, 0, 2, 3];
    vd.uvs = [0, 0, 1, 0, 1, 1, 0, 1];
    vd.applyToMesh(mesh);
    mesh.material = this._material;
    mesh.isVisible = false;
    return mesh;
  }

  // ── Pack Color ──
  private _packColor(r: number, g: number, b: number): number {
    const bits = ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
    const buf = new ArrayBuffer(4);
    new Uint32Array(buf)[0] = bits;
    return new Float32Array(buf)[0];
  }

  // ── G03: Octahedral normal encoding (unit vec3 → 2 floats in [0,1]) ──
  private _encodeOctahedral(nx: number, ny: number, nz: number): [number, number] {
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

  // ── Static Splat Management ──

  addStaticSplats(sectorKey: string, splats: SplatInstance[]) {
    if (splats.length === 0) return;
    this._staticSplats.set(sectorKey, splats);
    this._dirty = true;
  }

  removeStaticSplats(sectorKey: string) {
    if (this._staticSplats.delete(sectorKey)) {
      this._dirty = true;
    }
  }

  hasStaticSplats(sectorKey: string): boolean {
    return this._staticSplats.has(sectorKey);
  }

  // ── Dynamic Splats (Fase 5 placeholder) ──

  addDynamicSplats(splats: SplatInstance[]) {
    for (const s of splats) this._dynamicSplats.push(s);
    this._dirty = true;
  }

  clearDynamicSplats() {
    if (this._dynamicSplats.length) {
      this._dynamicSplats.length = 0;
      this._dirty = true;
    }
  }

  // ── Rebuild & Upload ──

  /**
   * Call once per frame. Rebuilds instance buffers only when dirty.
   */
  update() {
    // Update camera-based uniforms every frame
    const camera = this._scene.activeCamera;
    if (camera) {
      const pos = camera.globalPosition;
      this._material.setVector3("dveSplatCamPos", pos);
      this._material.setFloat("dveSplatFadeNear", this._fadeNear);
      this._material.setFloat("dveSplatFadeFar", this._fadeFar);
    }

    // G01+G02: Bind sun direction and time for SSS lighting + micro-movement
    this._material.setFloat("dveSplatTime", performance.now() * 0.001);
    // Find directional light for sun direction
    const lights = this._scene.lights;
    for (let i = 0; i < lights.length; i++) {
      const light = lights[i] as any;
      if (light.direction) {
        const d = light.direction;
        const len = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z) || 1;
        this._material.setVector3("dveSplatSunDir", { x: d.x / len, y: d.y / len, z: d.z / len } as any);
        break;
      }
    }

    // E01: Fog uniforms — mirror BabylonJS FOGMODE_EXP2; density=0 when fog is disabled.
    const fogMode = (this._scene as any).fogMode ?? 0;
    this._material.setFloat("dveSplatFogDensity", fogMode !== 0 ? this._scene.fogDensity : 0.0);
    this._material.setColor3("dveSplatFogColor", this._scene.fogColor);

    if (!this._dirty) return;
    this._dirty = false;

    // Collect all splats
    let total = 0;
    for (const batch of this._staticSplats.values()) {
      total += batch.length;
    }
    total += this._dynamicSplats.length;

    if (total === 0) {
      this._masterQuad.isVisible = false;
      this._totalInstanceCount = 0;
      return;
    }

    const count = Math.min(total, this._maxSplats);
    this._masterQuad.isVisible = true;

    let idx = 0;
    const writeSplat = (s: SplatInstance) => {
      if (idx >= count) return;
      const mo = idx * 16;
      // Identity matrix with translation
      this._matrixBuffer[mo]      = 1;
      this._matrixBuffer[mo + 1]  = 0;
      this._matrixBuffer[mo + 2]  = 0;
      this._matrixBuffer[mo + 3]  = 0;
      this._matrixBuffer[mo + 4]  = 0;
      this._matrixBuffer[mo + 5]  = 1;
      this._matrixBuffer[mo + 6]  = 0;
      this._matrixBuffer[mo + 7]  = 0;
      this._matrixBuffer[mo + 8]  = 0;
      this._matrixBuffer[mo + 9]  = 0;
      this._matrixBuffer[mo + 10] = 1;
      this._matrixBuffer[mo + 11] = 0;
      this._matrixBuffer[mo + 12] = s.position[0];
      this._matrixBuffer[mo + 13] = s.position[1];
      this._matrixBuffer[mo + 14] = s.position[2];
      this._matrixBuffer[mo + 15] = 1;

      const so = idx * 4;
      this._splatBuffer[so]     = s.scale;
      this._splatBuffer[so + 1] = s.opacity;
      this._splatBuffer[so + 2] = this._packColor(...s.color);
      this._splatBuffer[so + 3] = s.shape;

      // G03: Encode per-splat surface normal as octahedral (2 floats)
      const sn = s.normal ?? [0, 1, 0];
      const [oX, oY] = this._encodeOctahedral(sn[0], sn[1], sn[2]);
      const no = idx * 2;
      this._normalBuffer[no]     = oX;
      this._normalBuffer[no + 1] = oY;

      idx++;
    };

    for (const batch of this._staticSplats.values()) {
      for (const s of batch) writeSplat(s);
    }
    for (const s of this._dynamicSplats) writeSplat(s);

    this._totalInstanceCount = idx;

    this._masterQuad.thinInstanceSetBuffer(
      "matrix",
      this._matrixBuffer.subarray(0, idx * 16),
      16, false
    );
    this._masterQuad.thinInstanceSetBuffer(
      "splatData",
      this._splatBuffer.subarray(0, idx * 4),
      4, false
    );
    this._masterQuad.thinInstanceSetBuffer(
      "splatOctNormal",
      this._normalBuffer.subarray(0, idx * 2),
      2, false
    );
    this._masterQuad.thinInstanceCount = idx;
  }

  get totalSplats(): number {
    return this._totalInstanceCount;
  }

  /** Set distance thresholds for splat fade (default: 40, 90). */
  setFadeDistances(near: number, far: number) {
    this._fadeNear = near;
    this._fadeFar = far;
  }

  dispose() {
    this._masterQuad.dispose();
    this._material.dispose();
    this._staticSplats.clear();
    this._dynamicSplats.length = 0;
  }
}
