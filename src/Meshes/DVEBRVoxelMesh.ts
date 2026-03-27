import { Mesh } from "@babylonjs/core/Meshes/mesh.js";

import { Buffer, VertexBuffer } from "@babylonjs/core/Meshes/buffer.js";
import { Engine } from "@babylonjs/core/Engines/engine";
import { CompactSubMesh } from "@divinevoxel/vlox/Mesher/Types/Mesher.types";
import { VoxelMeshVertexStructCursor } from "@divinevoxel/vlox/Mesher/Voxels/Geometry/VoxelMeshVertexStructCursor";
import { Scene } from "@babylonjs/core/scene";
import { DVEBabylonRenderer } from "../Renderer/DVEBabylonRenderer";

/** Entry stored per-mesh so we can update without re-registering VertexBuffers. */
type MeshBufferEntry = { buffer: Buffer; floatCount: number };

export class DVEBRVoxelMesh {
  /** Map of mesh → its underlying GPU buffer (for fast in-place updates). */
  private static _meshBuffers = new WeakMap<Mesh, MeshBufferEntry>();
  private static readonly _maxPoolEntriesPerSize = 2;
  /**
   * Global cap on total pooled GPU buffers across all sizes.
   * Prevents unbounded accumulation when mesh sizes change continuously
   * (e.g., growing liquid bodies that never reuse an exact old size).
   */
  private static readonly _maxTotalPooledBuffers = 24;
  private static _totalPooledBuffers = 0;

  /**
   * Buffer pool keyed by vertex float count.
   * Buffers released here are reused on next acquire of the same size,
   * avoiding create/destroy GPU allocations for constant-size chunk rebuilds.
   */
  private static _bufferPool = new Map<number, Buffer[]>();

  private static _storeBufferInPool(entry: MeshBufferEntry) {
    // Clear CPU mirror so hydrology churn does not retain large Float32Arrays.
    (entry.buffer as any)._data = null;

    // Enforce global cap first: continuously-growing meshes produce unique sizes
    // on every rebuild and would otherwise accumulate unboundedly in the pool.
    if (this._totalPooledBuffers >= this._maxTotalPooledBuffers) {
      entry.buffer.dispose();
      return;
    }

    let pool = this._bufferPool.get(entry.floatCount);
    if (!pool) {
      pool = [];
      this._bufferPool.set(entry.floatCount, pool);
    }

    if (pool.length >= this._maxPoolEntriesPerSize) {
      entry.buffer.dispose();
      return;
    }

    pool.push(entry.buffer);
    this._totalPooledBuffers++;
  }

  private static _acquireBuffer(engine: Engine, vertices: Float32Array): Buffer {
    const floatCount = vertices.length;
    const pool = this._bufferPool.get(floatCount);
    const pooled = pool?.pop();
    if (pooled) {
      this._totalPooledBuffers--;
      pooled.update(vertices);
      return pooled;
    }
    return new Buffer(engine, vertices, true);
  }

  private static _setGeometryVertexBuffer(
    geometry: any,
    vertexBuffer: VertexBuffer,
    totalVertices?: number
  ) {
    const kind = vertexBuffer.getKind();
    const existing = geometry._vertexBuffers?.[kind];
    if (existing) {
      existing.dispose();
    }

    // Do NOT call _buffer._increaseReferences() here.
    // Babylon's reference counter starts at 1 (set by createDynamicVertexBuffer).
    // Calling _increaseReferences() 13 times (once per attribute kind) raises it to
    // 13, so a single buffer.dispose() only decrements to 12 — the GPU buffer is
    // never freed.  Keeping references = 1 means pool eviction via buffer.dispose()
    // reaches 0 and calls gl.deleteBuffer() correctly.
    geometry._vertexBuffers[kind] = vertexBuffer;

    if (kind === VertexBuffer.PositionKind) {
      geometry._totalVertices = totalVertices ?? vertexBuffer._maxVerticesCount;
      geometry._resetPointsArrayCache?.();

      const meshes: Mesh[] = geometry._meshes || [];
      for (const mesh of meshes) {
        mesh._createGlobalSubMesh(mesh.isUnIndexed);
        mesh.computeWorldMatrix(true);
        mesh.synchronizeInstances();
      }
    }

    geometry._notifyUpdate?.(kind);
  }

  /**
   * Call when a mesh is being disposed to return its buffer to the pool.
   * Prevents accumulation of orphaned GPU buffers.
   */
  static releaseBuffer(mesh: Mesh) {
    const entry = this._meshBuffers.get(mesh);
    if (!entry) return;
    this._storeBufferInPool(entry);
    this._meshBuffers.delete(mesh);
  }

  static CreateSubMesh(data: CompactSubMesh, scene: Scene, engine: Engine) {
    const [materialId, vertexBuffer, indexBuffer] = data;
    const mesh = new Mesh("", scene);
    const material = DVEBabylonRenderer.instance.materials.get(materialId);
    mesh.material = material._material;
    this.UpdateVertexDataBuffers(mesh, engine, vertexBuffer, indexBuffer);
    return mesh;
  }

  static UpdateVertexData(mesh: Mesh, engine: Engine, data: CompactSubMesh) {
    this.UpdateVertexDataBuffers(mesh, engine, data[1], data[2]);
  }
  
  static UpdateVertexDataBuffers(
    mesh: Mesh,
    engine: Engine,
    vertices: Float32Array,
    indices: Uint16Array<any> | Uint32Array<any>
  ) {
    const floatCount = vertices.length;
    const totalVertices = floatCount / VoxelMeshVertexStructCursor.VertexFloatSize;
    const existing = this._meshBuffers.get(mesh);

    // Fast path: same buffer size — just push new data to GPU, no VertexBuffer re-registration.
    if (existing && existing.floatCount === floatCount) {
      existing.buffer.update(vertices);
      const geo = mesh.geometry ? mesh.geometry : mesh;
      geo.setIndices(indices);
      return existing.buffer;
    }

    // Return old buffer to pool before replacing it
    if (existing) {
      this._storeBufferInPool(existing);
    }

    // Slow path: acquire (or create) a buffer and re-register all VertexBuffers.
    const buffer = this._acquireBuffer(engine, vertices);
    this._meshBuffers.set(mesh, { buffer, floatCount });
    const geo = mesh.geometry ? mesh.geometry : mesh;
    this._setGeometryVertexBuffer(
      geo,
      new VertexBuffer(
        engine,
        buffer,
        VertexBuffer.PositionKind,
        false,
        undefined,
        VoxelMeshVertexStructCursor.VertexFloatSize,
        undefined,
        VoxelMeshVertexStructCursor.PositionOffset,
        3
      ),
      totalVertices
    );
    this._setGeometryVertexBuffer(
      geo,
      new VertexBuffer(
        engine,
        buffer,
        VertexBuffer.NormalKind,
        false,
        undefined,
        VoxelMeshVertexStructCursor.VertexFloatSize,
        undefined,
        VoxelMeshVertexStructCursor.NormalOffset,
        3
      )
    );
    this._setGeometryVertexBuffer(
      geo,
      new VertexBuffer(
        engine,
        buffer,
        // 3 components: x=diffuse atlas index, y=normal atlas index, z=MER atlas index.
        // ItemMesh uses 1 component (diffuse only) — do NOT unify these two.
        "textureIndex",
        false,
        undefined,
        VoxelMeshVertexStructCursor.VertexFloatSize,
        undefined,
        VoxelMeshVertexStructCursor.TextureIndexOffset,
        3
      )
    );
    this._setGeometryVertexBuffer(
      geo,
      new VertexBuffer(
        engine,
        buffer,
        "uv",
        false,
        undefined,
        VoxelMeshVertexStructCursor.VertexFloatSize,
        undefined,
        VoxelMeshVertexStructCursor.UVOffset,
        2
      )
    );
    this._setGeometryVertexBuffer(
      geo,
      new VertexBuffer(
        engine,
        buffer,
        "worldContext",
        false,
        undefined,
        VoxelMeshVertexStructCursor.VertexFloatSize,
        undefined,
        VoxelMeshVertexStructCursor.ColorOffset,
        3
      )
    );
    this._setGeometryVertexBuffer(
      geo,
      new VertexBuffer(
        engine,
        buffer,
        "voxelData",
        false,
        undefined,
        VoxelMeshVertexStructCursor.VertexFloatSize,
        undefined,
        VoxelMeshVertexStructCursor.VoxelDataOFfset,
        4
      )
    );
    this._setGeometryVertexBuffer(
      geo,
      new VertexBuffer(
        engine,
        buffer,
        "metadata",
        false,
        undefined,
        VoxelMeshVertexStructCursor.VertexFloatSize,
        undefined,
        VoxelMeshVertexStructCursor.MetadataOffset,
        4
      )
    );
    // Dissolution / subdivision data — packed into padding slots and tail floats
    this._setGeometryVertexBuffer(
      geo,
      new VertexBuffer(
        engine, buffer, "dissolutionProximity", false, undefined,
        VoxelMeshVertexStructCursor.VertexFloatSize, undefined,
        VoxelMeshVertexStructCursor.DissolutionProximityOffset, 1
      )
    );
    this._setGeometryVertexBuffer(
      geo,
      new VertexBuffer(
        engine, buffer, "pullStrength", false, undefined,
        VoxelMeshVertexStructCursor.VertexFloatSize, undefined,
        VoxelMeshVertexStructCursor.PullStrengthOffset, 1
      )
    );
    this._setGeometryVertexBuffer(
      geo,
      new VertexBuffer(
        engine, buffer, "subdivLevel", false, undefined,
        VoxelMeshVertexStructCursor.VertexFloatSize, undefined,
        VoxelMeshVertexStructCursor.SubdivLevelOffset, 1
      )
    );
    this._setGeometryVertexBuffer(
      geo,
      new VertexBuffer(
        engine, buffer, "pullDirectionBias", false, undefined,
        VoxelMeshVertexStructCursor.VertexFloatSize, undefined,
        VoxelMeshVertexStructCursor.PullDirectionBiasOffset, 1
      )
    );
    // R06: Vertex-baked AO — tail float 0
    this._setGeometryVertexBuffer(
      geo,
      new VertexBuffer(
        engine, buffer, "subdivAO", false, undefined,
        VoxelMeshVertexStructCursor.VertexFloatSize, undefined,
        VoxelMeshVertexStructCursor.SubdivAOOffset, 1
      )
    );
    this._setGeometryVertexBuffer(
      geo,
      new VertexBuffer(
        engine, buffer, "phNormalized", false, undefined,
        VoxelMeshVertexStructCursor.VertexFloatSize, undefined,
        VoxelMeshVertexStructCursor.PhNormalizedOffset, 1
      )
    );
    // Phase 3 / Phase 4 — water surface derivative fields at slots 28-30.
    // Non-water meshes leave these floats as zero (safe: shader guards on dveStableWaterSurfaceY).
    this._setGeometryVertexBuffer(
      geo,
      new VertexBuffer(
        engine, buffer, "waterGradientX", false, undefined,
        VoxelMeshVertexStructCursor.VertexFloatSize, undefined,
        VoxelMeshVertexStructCursor.WaterGradientXOffset, 1
      )
    );
    this._setGeometryVertexBuffer(
      geo,
      new VertexBuffer(
        engine, buffer, "waterGradientZ", false, undefined,
        VoxelMeshVertexStructCursor.VertexFloatSize, undefined,
        VoxelMeshVertexStructCursor.WaterGradientZOffset, 1
      )
    );
    this._setGeometryVertexBuffer(
      geo,
      new VertexBuffer(
        engine, buffer, "waterCurvature", false, undefined,
        VoxelMeshVertexStructCursor.VertexFloatSize, undefined,
        VoxelMeshVertexStructCursor.WaterCurvatureOffset, 1
      )
    );
    geo.setIndices(indices);
    return buffer;
  }
  /*   static UpdateVertexDataO(mesh: Mesh, engine: Engine, data: CompactSubMesh) {
 
    for (let i = 0; i < data[1].length; i++) {
      const subMesh = data[1][i];
      const id = subMesh[0];
      const array = subMesh[1];
      const stride = subMesh[2];
      if (id == "indices") {
        mesh.setIndices(array as any);
        continue;
      }

      const buffer = new Buffer(engine, array,false,)
      mesh.setVerticesBuffer(
        new VertexBuffer(engine, array, id, false, undefined, stride)
      );
    }
  } */

}
