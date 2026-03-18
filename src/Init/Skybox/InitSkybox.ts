import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { HDRCubeTexture } from "@babylonjs/core/Materials/Textures/hdrCubeTexture";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { DVEBabylonRenderer } from "Renderer/DVEBabylonRenderer";

const DEFAULT_VISIBLE_SKYBOX_HDRI = "assets/skybox-blouberg-sunrise-2.hdr";

export function InitSkybox({ renderer }: { renderer: DVEBabylonRenderer }) {
  const scene = renderer.scene;
  const existingSkyboxes = scene.meshes.filter((mesh) => mesh.name === "skyBox");
  for (const mesh of existingSkyboxes) {
    mesh.material?.dispose(false, true);
    mesh.dispose(false, true);
  }

  const sourceTexture =
    scene.environmentTexture instanceof HDRCubeTexture
      ? (scene.environmentTexture.clone() as HDRCubeTexture)
      : new HDRCubeTexture(DEFAULT_VISIBLE_SKYBOX_HDRI, scene, 512);
  const reflectionTexture = sourceTexture;
  reflectionTexture.coordinatesMode = Texture.SKYBOX_MODE;
  const skyboxMat = new PBRMaterial("skybox", scene);
  skyboxMat.reflectionTexture = reflectionTexture;
  skyboxMat.backFaceCulling = false;
  skyboxMat.microSurface = 1.0;
  skyboxMat.cameraExposure = 0.5;
  skyboxMat.cameraContrast = 1.0;
  skyboxMat.disableLighting = true;
  skyboxMat.unlit = true;
  skyboxMat.disableDepthWrite = true;
  scene.onDisposeObservable.addOnce(() => reflectionTexture.dispose());

  const renderDistance = 250;
  const skybox = CreateBox(
    "skyBox",
    {
      size: renderDistance,
    },
    scene
  );
  skybox.renderingGroupId = 0;
  skybox.infiniteDistance = true;
  skybox.isPickable = false;
  skybox.material = skyboxMat;

  return skybox;
}
