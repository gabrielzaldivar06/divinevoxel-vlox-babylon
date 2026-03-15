/**
 * BVHRaycast — pure physics module.
 *
 * No BabylonJS dependency — safe to call from Web Workers or any context
 * where a browser DOM is unavailable.
 *
 * BVHViewer (debug visualization) lives in BVHTool.ts and imports from here.
 */

import { VoxelMeshBVHStructCursor } from "@divinevoxel/vlox/Mesher/Voxels/Geometry/VoxelMeshBVHStructCursor";
import { VoxelMeshVertexStructCursor } from "@divinevoxel/vlox/Mesher/Voxels/Geometry/VoxelMeshVertexStructCursor";

// ─── Worker-safe math types ───────────────────────────────────────────────────
// Plain objects — no DOM, no BabylonJS. Structurally compatible with BabylonJS
// Vector3/Vector2 so callers in BVHTool.ts can pass Babylon vectors without casting.

export type Vec2 = { x: number; y: number };
export type Vec3 = { x: number; y: number; z: number };

function dot3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function cross3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
function sub3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function add3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function scale3(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}
function mulComp3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x * b.x, y: a.y * b.y, z: a.z * b.z };
}
function minComp3(a: Vec3, b: Vec3): Vec3 {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) };
}
function maxComp3(a: Vec3, b: Vec3): Vec3 {
  return { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) };
}
function normalize3(a: Vec3): Vec3 {
  const len = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  return len > 0 ? scale3(a, 1 / len) : { x: 0, y: 0, z: 1 };
}

// ─── Result types ─────────────────────────────────────────────────────────────

export class VoxelGeometryIntersectResult {
  constructor(
    public hit: boolean,
    public normal: Vec3,
    public position: Vec3,
    public uv: Vec2,
    public triangleId: number
  ) {}
}

export class VoxelMeshIntersectResult {
  constructor(
    public found: boolean,
    public foundObject: number,
    public t: number,
    public error: boolean,
    public triangle: VoxelGeometryIntersectResult
  ) {}
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

const vertexCursor = new VoxelMeshVertexStructCursor();
const v1Position: Vec3 = { x: 0, y: 0, z: 0 };
const v2Position: Vec3 = { x: 0, y: 0, z: 0 };
const v3Position: Vec3 = { x: 0, y: 0, z: 0 };
const v1Normal: Vec3 = { x: 0, y: 0, z: 0 };
const v2Normal: Vec3 = { x: 0, y: 0, z: 0 };
const v3Normal: Vec3 = { x: 0, y: 0, z: 0 };

class TriangleIntersectResult {
  constructor(
    public u: number,
    public v: number,
    public t: number
  ) {}
}

function BVH_TriangleIntersect(
  v0: Vec3,
  v1: Vec3,
  v2: Vec3,
  rayOrigin: Vec3,
  rayDirection: Vec3
): TriangleIntersectResult {
  const edge1 = sub3(v1, v0);
  const edge2 = sub3(v2, v0);
  const pvec = cross3(rayDirection, edge2);
  const det = dot3(edge1, pvec);
  const invDet = 1.0 / det;
  const tvec = sub3(rayOrigin, v0);
  const u = dot3(tvec, pvec) * invDet;
  const qvec = cross3(tvec, edge1);
  const v = dot3(rayDirection, qvec) * invDet;
  const t = dot3(edge2, qvec) * invDet;
  if (det < 0.0 || t <= 0.0 || u < 0.0 || u > 1.0 || v < 0.0 || u + v > 1.0) {
    return new TriangleIntersectResult(u, v, Infinity);
  }
  return new TriangleIntersectResult(u, v, t);
}

// Base offsets for vertices and indices within their typed arrays.
// Currently 0 (single-mesh buffers). Expose as function params if multi-mesh support is needed.
const VERTEX_OFFSET_BASE = 0;
const INDICE_OFFSET_BASE = 0;
const VOXEL_INDICE_OFFSET_BASE = 0;

function VoxelGeometryIntersect(
  ro: Vec3,
  rd: Vec3,
  nodeId: number,
  voxel_indice: Uint32Array,
  vertices: Float32Array,
  indices: Uint32Array
): VoxelGeometryIntersectResult {
  vertexCursor.data = vertices;
  let intersectResult = new VoxelGeometryIntersectResult(
    false,
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0 },
    0
  );

  let finalTriResult = new TriangleIntersectResult(0, 0, 0);
  let triId = 0;
  let t = Infinity;

  const indiceStart = voxel_indice[VOXEL_INDICE_OFFSET_BASE + nodeId * 2];
  const indiceEnd   = voxel_indice[VOXEL_INDICE_OFFSET_BASE + nodeId * 2 + 1];
  const length = indiceEnd - indiceStart;
  if (length <= 0) return intersectResult;

  const vertexOffset = VERTEX_OFFSET_BASE;
  const indiceOffset = INDICE_OFFSET_BASE + indiceStart;
  let finalIndex = 0;

  for (let indiceIndex = 0; indiceIndex < length; indiceIndex += 3) {
    let v1 = vertexOffset + indices[indiceOffset + indiceIndex];
    vertexCursor.index = v1;
    v1Position.x = vertexCursor.positionX;
    v1Position.y = vertexCursor.positionY;
    v1Position.z = vertexCursor.positionZ;

    let v2 = vertexOffset + indices[indiceOffset + indiceIndex + 1];
    vertexCursor.index = v2;
    v2Position.x = vertexCursor.positionX;
    v2Position.y = vertexCursor.positionY;
    v2Position.z = vertexCursor.positionZ;

    let v3 = vertexOffset + indices[indiceOffset + indiceIndex + 2];
    vertexCursor.index = v3;
    v3Position.x = vertexCursor.positionX;
    v3Position.y = vertexCursor.positionY;
    v3Position.z = vertexCursor.positionZ;

    let triResult = BVH_TriangleIntersect(v1Position, v2Position, v3Position, ro, rd);
    if (triResult.t < t) {
      intersectResult.hit = true;
      t = triResult.t;
      finalTriResult = triResult;
      triId = indiceIndex / 3;
      finalIndex = indiceOffset + indiceIndex;
    }
  }

  if (intersectResult.hit) {
    vertexCursor.index = vertexOffset + indices[finalIndex];
    v1Normal.x = vertexCursor.normalX; v1Normal.y = vertexCursor.normalY; v1Normal.z = vertexCursor.normalZ;
    vertexCursor.index = vertexOffset + indices[finalIndex + 1];
    v2Normal.x = vertexCursor.normalX; v2Normal.y = vertexCursor.normalY; v2Normal.z = vertexCursor.normalZ;
    vertexCursor.index = vertexOffset + indices[finalIndex + 2];
    v3Normal.x = vertexCursor.normalX; v3Normal.y = vertexCursor.normalY; v3Normal.z = vertexCursor.normalZ;

    // Barycentric interpolation: n = v1N*(1-u-v) + v2N*u + v3N*v
    const bu = finalTriResult.u;
    const bv = finalTriResult.v;
    const bw = 1.0 - bu - bv;
    intersectResult.normal = normalize3({
      x: v1Normal.x * bw + v2Normal.x * bu + v3Normal.x * bv,
      y: v1Normal.y * bw + v2Normal.y * bu + v3Normal.y * bv,
      z: v1Normal.z * bw + v2Normal.z * bu + v3Normal.z * bv,
    });

    intersectResult.uv.x = finalTriResult.u;
    intersectResult.uv.y = finalTriResult.v;
    intersectResult.position = add3(ro, scale3(rd, finalTriResult.t));
  }

  return intersectResult;
}

/**
 * Computes the intersection of a ray with an AABB.
 * @param invDir - Pre-computed 1/rayDirection (pass 0 for zero components).
 */
export function BoundingBoxIntersect(
  minCorner: Vec3,
  maxCorner: Vec3,
  rayOrigin: Vec3,
  invDir: Vec3
): number {
  const near = mulComp3(sub3(minCorner, rayOrigin), invDir);
  const far  = mulComp3(sub3(maxCorner, rayOrigin), invDir);
  const tmin = minComp3(near, far);
  const tmax = maxComp3(near, far);
  const t0 = Math.max(Math.max(tmin.x, tmin.y), tmin.z);
  const t1 = Math.min(Math.min(tmax.x, tmax.y), tmax.z);
  if (Math.max(t0, 0.0) > t1) return Infinity;
  return t0;
}

// ─── BVH traversal ────────────────────────────────────────────────────────────

class StackNode {
  constructor(
    public nodeId: number,
    public t: number
  ) {}
}

/**
 * STACK_SIZE = ceil(log2(maxTrianglesInSector)).
 * For a 16×16×16 sector with DC producing at most ~8192 triangles:
 *   ceil(log2(8192)) = 13 ✓
 * If sector size or mesh density grows beyond this, increase STACK_SIZE
 * and rebuild. A stack overflow silently sets intersectResult.error = true.
 */
const STACK_SIZE = 13;
const stack: StackNode[] = Array.from({ length: STACK_SIZE }, () => new StackNode(0, 0));

const VOXEL_NODE_INDEX = 4095;

export function VoxelMeshIntersect(
  ro: Vec3,
  rd: Vec3,
  voxel_bvh: Float32Array,
  voxel_indice_offsets: Uint32Array,
  mesh_vertices: Float32Array,
  mesh_indices: Uint32Array
): VoxelMeshIntersectResult {
  const currentNode = new VoxelMeshBVHStructCursor(voxel_bvh);
  const leftChild = new VoxelMeshBVHStructCursor(voxel_bvh);
  const rightChild = new VoxelMeshBVHStructCursor(voxel_bvh);

  let intersectResult = new VoxelMeshIntersectResult(
    false, 0, 0, false,
    new VoxelGeometryIntersectResult(false, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0 }, 0)
  );

  let stackIndex = 0;
  let currentNodeIndex = 0;
  let currentNodeT = 0.0;

  const minBox: Vec3 = { x: 0, y: 0, z: 0 };
  const maxBox: Vec3 = { x: 0, y: 0, z: 0 };
  const inverseDir: Vec3 = {
    x: rd.x !== 0 ? 1 / rd.x : 0,
    y: rd.y !== 0 ? 1 / rd.y : 0,
    z: rd.z !== 0 ? 1 / rd.z : 0,
  };

  do {
    currentNode.setIndex(currentNodeIndex);

    if (currentNode.nodeType == 2.0) {
      const geometryResult = VoxelGeometryIntersect(
        ro, rd,
        currentNodeIndex - VOXEL_NODE_INDEX,
        voxel_indice_offsets,
        mesh_vertices,
        mesh_indices
      );
      if (geometryResult.hit) {
        intersectResult.found = true;
        intersectResult.t = currentNodeT;
        intersectResult.triangle = geometryResult;
        break;
      } else {
        if (stackIndex == 0) break;
        stackIndex--;
        currentNodeIndex = stack[stackIndex].nodeId;
        continue;
      }
    }

    const leftChildId = 2 * currentNodeIndex + 1;
    const rightChildId = 2 * currentNodeIndex + 2;
    leftChild.setIndex(leftChildId);
    rightChild.setIndex(rightChildId);

    let leftChildT = Infinity;
    let rightChildT = Infinity;

    if (leftChild.active >= 0) {
      minBox.x = leftChild.minX; minBox.y = leftChild.minY; minBox.z = leftChild.minZ;
      maxBox.x = leftChild.maxX; maxBox.y = leftChild.maxY; maxBox.z = leftChild.maxZ;
      leftChildT = BoundingBoxIntersect(minBox, maxBox, ro, inverseDir);
    }
    if (rightChild.active >= 0) {
      minBox.x = rightChild.minX; minBox.y = rightChild.minY; minBox.z = rightChild.minZ;
      maxBox.x = rightChild.maxX; maxBox.y = rightChild.maxY; maxBox.z = rightChild.maxZ;
      rightChildT = BoundingBoxIntersect(minBox, maxBox, ro, inverseDir);
    }

    if (leftChildT == Infinity && rightChildT == Infinity) {
      if (stackIndex == 0) break;
      stackIndex--;
      currentNodeIndex = stack[stackIndex].nodeId;
      currentNodeT = stack[stackIndex].t;
      continue;
    }

    if (leftChildT < Infinity && rightChildT == Infinity) {
      currentNodeIndex = leftChildId;
      currentNodeT = leftChildT;
    } else if (rightChildT < Infinity && leftChildT == Infinity) {
      currentNodeIndex = rightChildId;
      currentNodeT = rightChildT;
    } else {
      // Both hit — traverse closer child first, push farther onto stack
      if (stackIndex >= STACK_SIZE) {
        // DEV: STACK_SIZE is too small for this geometry. See comment above.
        console.assert(false, `[BVHRaycast] Stack overflow — increase STACK_SIZE above ${STACK_SIZE}`);
        intersectResult.error = true;
        break;
      }
      if (leftChildT <= rightChildT) {
        stack[stackIndex] = new StackNode(rightChildId, rightChildT);
        stackIndex++;
        currentNodeIndex = leftChildId;
        currentNodeT = leftChildT;
      } else {
        stack[stackIndex] = new StackNode(leftChildId, leftChildT);
        stackIndex++;
        currentNodeIndex = rightChildId;
        currentNodeT = rightChildT;
      }
    }
  } while (true);

  return intersectResult;
}
