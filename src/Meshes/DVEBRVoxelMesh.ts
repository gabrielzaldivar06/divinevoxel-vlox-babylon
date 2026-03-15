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

  /**
   * Buffer pool keyed by vertex float count.
   * Buffers released here are reused on next acquire of the same size,
   * avoiding create/destroy GPU allocations for constant-size chunk rebuilds.
   */
  private static _bufferPool = new Map<number, Buffer[]>();

  private static _acquireBuffer(engine: Engine, vertices: Float32Array): Buffer {
    const floatCount = vertices.length;
    const pool = this._bufferPool.get(floatCount);
    const pooled = pool?.pop();
    if (pooled) {
      pooled.update(vertices);
      return pooled;
    }
    return new Buffer(engine, vertices, true);
  }

  /**
   * Call when a mesh is being disposed to return its buffer to the pool.
   * Prevents accumulation of orphaned GPU buffers.
   */
  static releaseBuffer(mesh: Mesh) {
    const entry = this._meshBuffers.get(mesh);
    if (!entry) return;
    let pool = this._bufferPool.get(entry.floatCount);
    if (!pool) {
      pool = [];
      this._bufferPool.set(entry.floatCount, pool);
    }
    pool.push(entry.buffer);
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
      let pool = this._bufferPool.get(existing.floatCount);
      if (!pool) { pool = []; this._bufferPool.set(existing.floatCount, pool); }
      pool.push(existing.buffer);
    }

    // Slow path: acquire (or create) a buffer and re-register all VertexBuffers.
    const buffer = this._acquireBuffer(engine, vertices);
    this._meshBuffers.set(mesh, { buffer, floatCount });
    const geo = mesh.geometry ? mesh.geometry : mesh;
    geo.setVerticesBuffer(
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
      )
    );
    geo.setVerticesBuffer(
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
    geo.setVerticesBuffer(
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
    geo.setVerticesBuffer(
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
    geo.setVerticesBuffer(
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
    geo.setVerticesBuffer(
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
    geo.setVerticesBuffer(
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
    geo.setVerticesBuffer(
      new VertexBuffer(
        engine, buffer, "dissolutionProximity", false, undefined,
        VoxelMeshVertexStructCursor.VertexFloatSize, undefined,
        VoxelMeshVertexStructCursor.DissolutionProximityOffset, 1
      )
    );
    geo.setVerticesBuffer(
      new VertexBuffer(
        engine, buffer, "pullStrength", false, undefined,
        VoxelMeshVertexStructCursor.VertexFloatSize, undefined,
        VoxelMeshVertexStructCursor.PullStrengthOffset, 1
      )
    );
    geo.setVerticesBuffer(
      new VertexBuffer(
        engine, buffer, "subdivLevel", false, undefined,
        VoxelMeshVertexStructCursor.VertexFloatSize, undefined,
        VoxelMeshVertexStructCursor.SubdivLevelOffset, 1
      )
    );
    geo.setVerticesBuffer(
      new VertexBuffer(
        engine, buffer, "pullDirectionBias", false, undefined,
        VoxelMeshVertexStructCursor.VertexFloatSize, undefined,
        VoxelMeshVertexStructCursor.PullDirectionBiasOffset, 1
      )
    );
    // R06: Vertex-baked AO — tail float 0
    geo.setVerticesBuffer(
      new VertexBuffer(
        engine, buffer, "subdivAO", false, undefined,
        VoxelMeshVertexStructCursor.VertexFloatSize, undefined,
        VoxelMeshVertexStructCursor.SubdivAOOffset, 1
      )
    );
    geo.setVerticesBuffer(
      new VertexBuffer(
        engine, buffer, "phNormalized", false, undefined,
        VoxelMeshVertexStructCursor.VertexFloatSize, undefined,
        VoxelMeshVertexStructCursor.PhNormalizedOffset, 1
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
