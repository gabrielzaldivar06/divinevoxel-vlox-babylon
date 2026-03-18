import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { Buffer } from "@babylonjs/core/Meshes/buffer.js";
import { Engine } from "@babylonjs/core/Engines/engine";
import { CompactSubMesh } from "@divinevoxel/vlox/Mesher/Types/Mesher.types";
import { Scene } from "@babylonjs/core/scene";
export declare class DVEBRVoxelMesh {
    /** Map of mesh → its underlying GPU buffer (for fast in-place updates). */
    private static _meshBuffers;
    /**
     * Buffer pool keyed by vertex float count.
     * Buffers released here are reused on next acquire of the same size,
     * avoiding create/destroy GPU allocations for constant-size chunk rebuilds.
     */
    private static _bufferPool;
    private static _acquireBuffer;
    /**
     * Call when a mesh is being disposed to return its buffer to the pool.
     * Prevents accumulation of orphaned GPU buffers.
     */
    static releaseBuffer(mesh: Mesh): void;
    static CreateSubMesh(data: CompactSubMesh, scene: Scene, engine: Engine): Mesh;
    static UpdateVertexData(mesh: Mesh, engine: Engine, data: CompactSubMesh): void;
    static UpdateVertexDataBuffers(mesh: Mesh, engine: Engine, vertices: Float32Array, indices: Uint16Array<any> | Uint32Array<any>): Buffer;
}
