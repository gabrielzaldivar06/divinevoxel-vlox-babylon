import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
import { Scene } from "@babylonjs/core/scene";
import { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import { CompactedMeshData } from "@divinevoxel/vlox/Mesher/Voxels/Geometry/CompactedSectionVoxelMesh";
import { BufferMesh } from "./Meshes/BufferMesh";
import { SubBufferMesh } from "./Meshes/SubBufferMesh";
import { VoxelSceneInterface } from "../VoxelScene.interface";
export declare class SingleBufferVoxelScene extends VoxelSceneInterface<SubBufferMesh> {
    _material: MultiMaterial;
    _meshBuffers: BufferMesh[];
    active: Map<SubMesh, SubBufferMesh>;
    init(scene: Scene): void;
    _addBufferMesh(): BufferMesh;
    removeMesh(mesh: SubBufferMesh): null;
    updateMesh(subBufferMesh: SubBufferMesh, data: CompactedMeshData): SubBufferMesh | null;
    addMesh(data: CompactedMeshData, x: number, y: number, z: number): SubBufferMesh;
    beforRender(): void;
    render(): void;
}
