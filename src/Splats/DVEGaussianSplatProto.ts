/**
 * DVE Gaussian Splat Lite — Proof of Concept
 *
 * Renders voxel surfaces as billboard quads with a radial Gaussian alpha falloff.
 * Uses Thin Instances of a single master quad for maximum GPU throughput.
 *
 * Integration point: runs ALONGSIDE the normal voxel pipeline — does NOT replace it.
 * Typical usage: edge voxels, flora, transitions, atmospheric dust.
 *
 * Performance target: 50k splats @ 60 fps on mid-range GPU (RTX 3060 / RX 6600).
 */

import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Effect } from "@babylonjs/core/Materials/effect";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Engine } from "@babylonjs/core/Engines/engine";
import { Constants } from "@babylonjs/core/Engines/constants";

// ─────────────────────────────────────────────────
// 1. GLSL Shaders
// ─────────────────────────────────────────────────

const SPLAT_VERTEX = /* glsl */ `#version 300 es
precision highp float;

// Per-vertex (unit quad −0.5…+0.5)
in vec3 position;
in vec2 uv;

// Per-instance (Thin Instances custom buffer)
// mat4 world matrix  — provided by Babylon thin-instance infra (world0-world3)
// Custom buffer "splatData": 4 floats per instance
//   [0] = scale     (world-space radius of the splat)
//   [1] = opacity   (0..1 peak alpha)
//   [2] = colorPacked (R8G8B8 packed as float via intBitsToFloat)
//   [3] = shape     (1 = sphere, <1 = oblate, >1 = prolate along Y)

in vec4 splatData;

// Babylon built-ins
uniform mat4 viewProjection;
uniform mat4 view;
uniform vec3 cameraPosition;

#ifdef INSTANCES
in vec4 world0;
in vec4 world1;
in vec4 world2;
in vec4 world3;
#endif

out vec2 vUV;
out float vOpacity;
out vec3 vColor;

vec3 unpackColor(float packed) {
  uint bits = floatBitsToUint(packed);
  return vec3(
    float((bits >> 16u) & 0xFFu) / 255.0,
    float((bits >> 8u)  & 0xFFu) / 255.0,
    float( bits         & 0xFFu) / 255.0
  );
}

void main() {
#ifdef INSTANCES
  mat4 worldMat = mat4(world0, world1, world2, world3);
#else
  mat4 worldMat = mat4(1.0);
#endif

  float scale   = splatData.x;
  vOpacity      = splatData.y;
  vColor        = unpackColor(splatData.z);
  float shape   = splatData.w;

  // Billboard: extract camera-right and camera-up from the view matrix
  vec3 camRight = vec3(view[0][0], view[1][0], view[2][0]);
  vec3 camUp    = vec3(view[0][1], view[1][1], view[2][1]);

  // Ellipse shape: stretch Y by shape factor
  vec3 worldCenter = (worldMat * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 offsetPos   = worldCenter
                   + camRight * position.x * scale
                   + camUp    * position.y * scale * shape;

  gl_Position = viewProjection * vec4(offsetPos, 1.0);
  vUV = uv;
}
`;

const SPLAT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUV;
in float vOpacity;
in vec3 vColor;

out vec4 fragColor;

void main() {
  // Gaussian falloff from center (0,0) to edge radius
  vec2 centered = vUV * 2.0 - 1.0;           // −1…+1
  float r2      = dot(centered, centered);    // squared distance from center

  // Discard fragments outside the unit circle for clean edges
  if (r2 > 1.0) discard;

  // Gaussian bell curve: exp(−r² × sharpness)
  // sharpness=3.0 gives soft falloff; increase for tighter core
  float gauss = exp(-r2 * 3.0);

  // Stochastic transparency: simple ordered dither to avoid sort overhead
  // Hash based on screen position for temporal stability
  float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  float alpha  = gauss * vOpacity;

  // Alpha-to-coverage handles blending without explicit sort
  fragColor = vec4(vColor * alpha, alpha);
}
`;

// ─────────────────────────────────────────────────
// 2. Splat Data Interface
// ─────────────────────────────────────────────────

export interface SplatInstance {
  /** World-space position (center of the splat) */
  position: Vector3;
  /** World-space radius */
  scale: number;
  /** Peak opacity 0..1 */
  opacity: number;
  /** RGB color [0..255, 0..255, 0..255] */
  color: [number, number, number];
  /** Shape factor: 1 = sphere, 0.5 = flat disc, 2 = tall column */
  shape: number;
}

// ─────────────────────────────────────────────────
// 3. Renderer Class
// ─────────────────────────────────────────────────

export class DVEGaussianSplatRenderer {
  private _masterQuad: Mesh;
  private _material: ShaderMaterial;
  private _splatBuffer: Float32Array = new Float32Array(0);
  private _matrixBuffer: Float32Array = new Float32Array(0);
  private _instanceCount = 0;

  constructor(
    private scene: Scene,
    private maxSplats: number = 50_000
  ) {
    this._registerShaders();
    this._material = this._createMaterial();
    this._masterQuad = this._createMasterQuad();
  }

  // ── Shader Registration ──
  private _registerShaders() {
    Effect.ShadersStore["gaussianSplatVertexShader"] = SPLAT_VERTEX;
    Effect.ShadersStore["gaussianSplatFragmentShader"] = SPLAT_FRAGMENT;
  }

  // ── Material ──
  private _createMaterial(): ShaderMaterial {
    const mat = new ShaderMaterial("gaussianSplatMat", this.scene, {
      vertex: "gaussianSplat",
      fragment: "gaussianSplat",
    }, {
      attributes: [
        "position", "uv",
        // Thin instance built-ins
        "world0", "world1", "world2", "world3",
        // Custom per-instance
        "splatData",
      ],
      uniforms: [
        "viewProjection", "view", "cameraPosition",
      ],
      defines: ["INSTANCES"],
    });

    // Depth write OFF for proper alpha blending
    mat.disableDepthWrite = true;
    mat.backFaceCulling = false;
    mat.alphaMode = Engine.ALPHA_ADD;

    return mat;
  }

  // ── Master Quad Geometry ──
  private _createMasterQuad(): Mesh {
    const mesh = new Mesh("gaussianSplatQuad", this.scene);
    const vd = new VertexData();

    // Unit quad centered at origin
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

    // Pre-allocate thin instance buffers
    this._matrixBuffer = new Float32Array(this.maxSplats * 16);
    this._splatBuffer = new Float32Array(this.maxSplats * 4);

    return mesh;
  }

  // ── Pack Color as Float ──
  private _packColor(r: number, g: number, b: number): number {
    const bits = ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
    // Use DataView to reinterpret uint32 as float32
    const buf = new ArrayBuffer(4);
    new Uint32Array(buf)[0] = bits;
    return new Float32Array(buf)[0];
  }

  // ── Update Instances ──
  /**
   * Call once per frame (or when splat data changes).
   * Fills thin-instance buffers with splat transforms + custom data.
   */
  update(splats: SplatInstance[]) {
    const count = Math.min(splats.length, this.maxSplats);
    this._instanceCount = count;

    if (count === 0) {
      this._masterQuad.isVisible = false;
      return;
    }
    this._masterQuad.isVisible = true;

    for (let i = 0; i < count; i++) {
      const s = splats[i];
      const mo = i * 16; // matrix offset

      // Identity matrix with translation
      // Row-major 4×4 (Babylon thin instances expect column-major)
      this._matrixBuffer[mo + 0]  = 1;
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
      this._matrixBuffer[mo + 12] = s.position.x;
      this._matrixBuffer[mo + 13] = s.position.y;
      this._matrixBuffer[mo + 14] = s.position.z;
      this._matrixBuffer[mo + 15] = 1;

      // Custom splat data
      const so = i * 4;
      this._splatBuffer[so + 0] = s.scale;
      this._splatBuffer[so + 1] = s.opacity;
      this._splatBuffer[so + 2] = this._packColor(...s.color);
      this._splatBuffer[so + 3] = s.shape;
    }

    // Upload buffers
    this._masterQuad.thinInstanceSetBuffer(
      "matrix",
      this._matrixBuffer.subarray(0, count * 16),
      16, false
    );
    this._masterQuad.thinInstanceSetBuffer(
      "splatData",
      this._splatBuffer.subarray(0, count * 4),
      4, false
    );

    this._masterQuad.thinInstanceCount = count;
  }

  /** Clean up GPU resources */
  dispose() {
    this._masterQuad.dispose();
    this._material.dispose();
  }
}

// ─────────────────────────────────────────────────
// 4. Example: Generate Splats from Voxel Edges
// ─────────────────────────────────────────────────

/**
 * Quick demo: scatter splats at voxel-edge positions.
 * In production, this would read from DVE's edgeBoundary metadata.
 *
 * Usage in your demo scene:
 *
 *   const splatRenderer = new DVEGaussianSplatRenderer(scene, 10_000);
 *   const splats = generateDemoSplats(1000);
 *   scene.onBeforeRenderObservable.add(() => {
 *     splatRenderer.update(splats);
 *   });
 */
export function generateDemoSplats(
  count: number,
  centerY: number = 60
): SplatInstance[] {
  const splats: SplatInstance[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const radius = 5 + Math.random() * 40;
    splats.push({
      position: new Vector3(
        Math.cos(angle) * radius,
        centerY + (Math.random() - 0.5) * 30,
        Math.sin(angle) * radius
      ),
      scale: 1.0 + Math.random() * 3.0,
      opacity: 0.5 + Math.random() * 0.4,
      color: [
        100 + Math.floor(Math.random() * 100),
        120 + Math.floor(Math.random() * 80),
        80 + Math.floor(Math.random() * 60),
      ],
      shape: 0.6 + Math.random() * 0.8,
    });
  }
  return splats;
}
