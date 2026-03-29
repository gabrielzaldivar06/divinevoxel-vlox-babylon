import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { Material } from "@babylonjs/core/Materials/material";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";

type DepthBinding = {
  depthTexture: BaseTexture;
  near: number;
  far: number;
  screenWidth: number;
  screenHeight: number;
};

const sceneDepthMaps = new WeakMap<Scene, WeakMap<object, BaseTexture>>();
const fallbackDepthTextures = new WeakMap<Scene, RawTexture>();

function getFallbackDepthTexture(scene: Scene) {
  const cached = fallbackDepthTextures.get(scene);
  if (cached) {
    return cached;
  }

  const texture = RawTexture.CreateRGBATexture(
    new Uint8Array([255, 255, 255, 255]),
    1,
    1,
    scene,
    false,
    false,
    Texture.NEAREST_NEAREST
  );
  fallbackDepthTextures.set(scene, texture);
  return texture;
}

function getSceneCameraDepthTexture(scene: Scene, activeCamera: object) {
  let depthMaps = sceneDepthMaps.get(scene);
  if (!depthMaps) {
    depthMaps = new WeakMap<object, BaseTexture>();
    sceneDepthMaps.set(scene, depthMaps);
  }

  let depthTexture: BaseTexture | undefined = depthMaps.get(activeCamera);
  if (!depthTexture) {
    // Only use an existing depth renderer — don't create one lazily.
    // If the renderer was intentionally skipped (e.g. pbr-premium-v2),
    // creating it here would silently add a full-scene extra pass (≈474 draw calls).
    const existing = (scene as any)._depthRenderer?.[""];
    if (existing) {
      depthTexture = existing.getDepthMap() as BaseTexture;
    }
    if (!depthTexture) {
      depthTexture = getFallbackDepthTexture(scene);
    }
    depthMaps.set(activeCamera, depthTexture);
  }

  return depthTexture;
}

export function getDepthTextureBinding(
  material: Material,
  scene?: Scene
): DepthBinding {
  const materialScene = scene || material.getScene();
  const activeCamera = materialScene?.activeCamera;

  if (materialScene && activeCamera) {
    const engine = materialScene.getEngine();
    return {
      depthTexture: getSceneCameraDepthTexture(materialScene, activeCamera as object),
      near: activeCamera.minZ,
      far: activeCamera.maxZ,
      screenWidth: Math.max(1, engine.getRenderWidth()),
      screenHeight: Math.max(1, engine.getRenderHeight()),
    };
  }

  if (materialScene) {
    return {
      depthTexture: getFallbackDepthTexture(materialScene),
      near: 0.1,
      far: 1000,
      screenWidth: 1,
      screenHeight: 1,
    };
  }

  throw new Error("Could not resolve a scene for depth texture binding.");
}