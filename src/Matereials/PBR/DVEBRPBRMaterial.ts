import { Material } from "@babylonjs/core/Materials/material";
import { PBRBaseMaterial } from "@babylonjs/core/Materials/PBR/pbrBaseMaterial";
import { Scene } from "@babylonjs/core/scene";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Vector3, Vector4 } from "@babylonjs/core/Maths/";
import { DVEPBRMaterialPlugin } from "./DVEPBRMaterialPlugin";
import { IMatrixLike } from "@babylonjs/core/Maths/math.like";
import { MaterialData, MaterialInterface } from "../MaterialInterface.js";
import { SceneOptions } from "../../Scene/SceneOptions";
import { TextureManager } from "@divinevoxel/vlox/Textures/TextureManager.js";
import { EngineSettings } from "@divinevoxel/vlox/Settings/EngineSettings.js";
import {
  applyActiveTerrainMaterialProfiles,
  classifyTerrainMaterial,
} from "./MaterialFamilyProfiles";

const neutralDetailTextures = new WeakMap<Scene, RawTexture>();

function getNeutralDetailTexture(scene: Scene) {
  const cached = neutralDetailTextures.get(scene);
  if (cached) {
    return cached;
  }

  const texture = RawTexture.CreateRGBATexture(
    new Uint8Array([128, 128, 255, 128]),
    1,
    1,
    scene,
    false,
    false,
    Texture.NEAREST_NEAREST_MIPLINEAR
  );
  neutralDetailTextures.set(scene, texture);
  return texture;
}

export type DVEBRPBRMaterialData = MaterialData<{
  textureTypeId: string;
  effectId: string;

  material?: PBRBaseMaterial;
  plugin?: DVEPBRMaterialPlugin;
  textures?: Map<string, Texture>;
}>;

export class DVEBRPBRMaterial implements MaterialInterface {
  static ready = false;
  _material: PBRMaterial;
  scene: Scene;

  plugin: DVEPBRMaterialPlugin;
  animationSizes = new Map<string, number>();
  static importedMaterialMapSamplerIds = ["dve_voxel_normal", "dve_voxel_material"] as const;

  afterCreate: ((material: PBRMaterial) => void)[] = [];
  constructor(
    public options: SceneOptions,
    public id: string,
    public data: DVEBRPBRMaterialData
  ) {}

  createMaterial(scene: Scene) {
    this.scene = scene;
    this._create(this.data);
    return this;
  }

  _create(data: DVEBRPBRMaterialData): PBRMaterial {
    this.scene = data.scene;

    if (this.data.data.material && this.data.data.textures) {
      this._material = this.data.data.material as PBRMaterial;
      this.textures = this.data.data.textures;
      this.plugin = this.data.data.plugin!;
      return this._material;
    }

    let texture;
    let animationTexture;
    if (data.data.textureTypeId) {
      texture = TextureManager.getTexture(
        data.data.textureTypeId ? data.data.textureTypeId : this.id
      );

      if (!texture && data.data.textureTypeId) {
        throw new Error(
          `Could find the texture type for material ${this.id}. Texture typeid:  ${data.data.textureTypeId}`
        );
      }
      animationTexture = texture.animatedTexture;
    }

    const extraTextureTypes = [...DVEBRPBRMaterial.importedMaterialMapSamplerIds];

    const material = new PBRMaterial(this.id, data.scene);
    const pluginId = `${this.id.replace("#", "")}`;

    const pluginBase = DVEPBRMaterialPlugin;
    const newPlugin = new Function(
      "extendedClass",
      /* js */ `
      return class ${pluginId} extends extendedClass {
        getClassName() {
          return ${pluginId};
        }
      };
    `
    )(pluginBase);

    const plugin = new newPlugin(material, pluginId, this, () => {});
    this.plugin = plugin;
    this._material = material;

    if (this.data.alphaTesting) {
      material.alphaMode = Material.MATERIAL_ALPHATEST;
    }
    /*   if (this.data.stencil) {
      material.stencil.enabled = true;
      material.stencil.func = Engine.NOTEQUAL;
      this.scene.setRenderingAutoClearDepthStencil(0, false, false, false);
    } */
    if (this.data.backFaceCulling !== undefined) {
      material.backFaceCulling = this.data.backFaceCulling;
    }
    if (this.id.includes("liquid")) {
      material.roughness = 0.1;
      material.reflectionColor.set(0.1, 0.1, 0.1);
      material.metallic = 1;
      material.reflectivityColor.set(0.8, 0.8, 0.8);
      //  material.wireframe = true;
      material.alphaMode = Material.MATERIAL_ALPHABLEND;

      material.alpha = 0.7;
    } else {
      material.metallic = 0.0;
      material.roughness = 0.92;
      material.reflectionColor.set(0.45, 0.45, 0.45);
      material.reflectivityColor.set(0.04, 0.04, 0.04);
      material.environmentIntensity = 0.45;
      material.directIntensity = 1;
      material.backFaceCulling = false;
      material.twoSidedLighting = true;
      material.forceNormalForward = true;
    }
    (material as any).useVertexColors = false;
    (material as any).hasVertexAlpha = false;
    material.emissiveColor;
    // material.sheen.isEnabled = false;
    // material.sheen.intensity = 0;
    //  material.emissiveColor.set(0,0,0);
    // material.ambientColor.set(0,0,0);
    material.anisotropy.dispose();

    if (texture) {
      this.textures.set(texture.id, texture.shaderTexture!);
      this.textures.set(
        `${texture.id}_animation`,
        animationTexture!.shaderTexture!
      );
      this.animationSizes.set(
        `${texture.id}_animation_size`,
        animationTexture!._size
      );
    }

    for (const textureType of extraTextureTypes) {
      try {
        const extraTexture = TextureManager.getTexture(textureType);
        if (!extraTexture.shaderTexture) continue;
        this.textures.set(extraTexture.id, extraTexture.shaderTexture);
      } catch {
        // Extra material maps are optional and only exist for specific benchmarks.
      }
    }

    if (this.shouldUseImportedMaterialMaps()) {
      material.detailMap.texture = getNeutralDetailTexture(this.scene);
      material.detailMap.isEnabled = true;
      material.detailMap.diffuseBlendLevel = 0;
      material.detailMap.roughnessBlendLevel = 0;
      material.detailMap.bumpLevel = 1;
      material.forceIrradianceInFragment = true;
    }

    applyActiveTerrainMaterialProfiles(material, this.id, EngineSettings.settings.terrain);

    material.markAsDirty(Material.AllDirtyFlag);

    //  material.wireframe = true;
    //  material.refraction.set(0.1,0.1,0.1);
    return this._material;
  }

  hasImportedMaterialMaps() {
    return DVEBRPBRMaterial.importedMaterialMapSamplerIds.every((samplerId) => {
      return this.textures.has(samplerId);
    });
  }

  shouldUseImportedMaterialMaps() {
    const classification = classifyTerrainMaterial(this.id);
    return (
      this.hasImportedMaterialMaps() &&
      !classification.isLiquid &&
      !classification.isTransparent &&
      !classification.isGlow &&
      !classification.isFlora &&
      (classification.isRock ||
        classification.isSoil ||
        classification.isWood ||
        classification.isCultivated ||
        classification.isExotic)
    );
  }

  setTextureArray(samplerId: string, sampler: Texture[]): void {
    throw new Error(`Function not implemented`);
  }
  textures = new Map<string, Texture>();
  setTexture(samplerId: string, sampler: Texture): void {
    if (this.plugin.uniformBuffer) {
      this.plugin.uniformBuffer.setTexture(samplerId, sampler);
    }
    this.textures.set(samplerId, sampler);
  }
  clone(scene: Scene) {
    for (const [textId] of this.textures) {
      if (this.plugin.uniformBuffer) {
        this.plugin.uniformBuffer.setTexture(textId, null);
      }
    }
    const pluginId = `${this.id.replace("#", "")}`;

    const pluginBase = DVEPBRMaterialPlugin;
    const newPlugin = new Function(
      "extendedClass",
      /* js */ `
      return class ${pluginId} extends extendedClass {
        getClassName() {
          return ${pluginId};
        }
      };
    `
    )(pluginBase);
    const newMat = PBRMaterial.Parse(
      this._material.serialize(),
      scene,
      "/"
    )! as PBRMaterial;
    const plugin = new newPlugin(
      newMat,
      pluginId,
      this,
      () => {}
    ) as DVEPBRMaterialPlugin;

    const textures = new Map<string, Texture>();
    for (const [textId, texture] of this.textures) {
      const newTexture = texture.clone();
      textures.set(textId, newTexture);
      if (plugin.uniformBuffer) {
        plugin.uniformBuffer.setTexture(textId, newTexture);
      }
      if (this.plugin.uniformBuffer) {
        this.plugin.uniformBuffer.setTexture(textId, texture!);
      }
    }

    const mat = new DVEBRPBRMaterial(this.options, this.id, {
      ...this.data,
      data: {
        ...this.data.data,
        material: newMat,
        plugin,
        textures,
      },
    });
    mat.plugin = plugin;
    mat._material = newMat;
    mat.textures = textures;
    mat.animationSizes = new Map(this.animationSizes);
    return mat;
  }

  setNumber(uniform: string, value: number): void {
    if (!this.plugin.uniformBuffer) return;
    this.plugin.uniformBuffer.updateFloat(uniform, value);
  }
  setNumberArray(uniform: string, value: ArrayLike<number>): void {
    if (!this.plugin.uniformBuffer)
      return console.warn(`Material is not ready ${uniform}`);
    this.plugin.uniformBuffer.updateArray(uniform, value as any);
  }
  setVector2(uniform: string, x: number, y: number): void {
    throw new Error(`Function not implemented`);
  }
  setVector3(uniform: string, x: number, y: number, z: number): void {
    if (!this.plugin.uniformBuffer) return;
    this.plugin.uniformBuffer.updateVector3(uniform, new Vector3(x, y, z));
  }
  setVector4(
    uniform: string,
    x: number,
    y: number,
    z: number,
    w: number
  ): void {
    if (!this.plugin.uniformBuffer) return;
    this.plugin.uniformBuffer.updateVector3(uniform, new Vector4(x, y, z, w));
  }
  setMatrix<MatrixType = IMatrixLike>(
    uniform: string,
    matrix: MatrixType
  ): void {
    if (!this.plugin.uniformBuffer) return;
    this.plugin.uniformBuffer.updateMatrix(uniform, matrix as IMatrixLike);
  }

  syncUBO(): void {
    
  }
}
