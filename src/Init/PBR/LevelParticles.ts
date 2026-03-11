import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { GPUParticleSystem } from "@babylonjs/core/Particles/gpuParticleSystem";
import "@babylonjs/core/Particles/webgl2ParticleSystem";
import { CustomParticleEmitter } from "@babylonjs/core/Particles/EmitterTypes/customParticleEmitter";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import type { Observer } from "@babylonjs/core/Misc/observable";


export class LevelParticles {
  static particle: ParticleSystem | GPUParticleSystem;
  static emitter: Mesh;
  static activeParticles: ParticleSystem | GPUParticleSystem;
  static texture: Texture;
  static scene: Scene;
  static cameraObserver?: Observer<Scene>;
  static init(scene: Scene) {
    this.scene = scene;
    const box = CreateBox("", { size: 1 }, scene);
    this.emitter = box;
    box.isVisible = false;
    box.alwaysSelectAsActiveMesh = false;

    const texture = new Texture(
      "assets/particle.png",
      scene,
      false,
      false,
      Texture.NEAREST_SAMPLINGMODE,
      () => {
        texture.hasAlpha = true;
        texture.updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);
      }
    );
    texture.hasAlpha = true;
    this.texture = texture;
  }

  static _getParticleSystem() {
    const scene = this.scene;
    let particleSystem: GPUParticleSystem | ParticleSystem;
    if (GPUParticleSystem.IsSupported) {
      particleSystem = new GPUParticleSystem(
        "particles",
        { capacity: 2_500, randomTextureSize: 2048 },
        scene
      );
    } else {
      particleSystem = new ParticleSystem("paritcles", 1400, scene);
    }
    this.particle = particleSystem;

    particleSystem.particleTexture = this.texture;
    particleSystem.emitter = this.emitter;
    particleSystem.minEmitBox = new Vector3(-2, -1, -2);
    particleSystem.maxEmitBox = new Vector3(2, 1, 2);

    particleSystem.blendMode = ParticleSystem.BLENDMODE_STANDARD;

    particleSystem.color1 = new Color4(0.89, 0.85, 0.68, 0.28);
    particleSystem.color2 = new Color4(0.61, 0.78, 0.56, 0.2);
    particleSystem.colorDead = new Color4(0.44, 0.52, 0.35, 0);

    particleSystem.minSize = 0.35;
    particleSystem.maxSize = 1.15;

    particleSystem.minLifeTime = 10;
    particleSystem.maxLifeTime = 18;

    particleSystem.emitRate = 120;

    particleSystem.gravity = new Vector3(0, -0.015, 0);

    particleSystem.direction1 = new Vector3(-0.3, -0.04, 0.24);
    particleSystem.direction2 = new Vector3(0.3, 0.1, 0.56);

    particleSystem.isAnimationSheetEnabled = true;
    particleSystem.spriteCellHeight = 32;
    particleSystem.spriteCellWidth = 32;
    particleSystem.spriteRandomStartCell = true;
    particleSystem.startSpriteCellID = 0;
    particleSystem.endSpriteCellID = 3;
    particleSystem.spriteCellChangeSpeed = 0;

    particleSystem.minAngularSpeed = -Math.PI * 0.04;
    particleSystem.maxAngularSpeed = Math.PI * 0.04;


    const customEmitter = new CustomParticleEmitter();
    customEmitter.particlePositionGenerator = (index, particle, out) => {
      out.x = (Math.random() - 0.5) * 56;
      out.y = 2 + Math.random() * 18;
      out.z = (Math.random() - 0.5) * 56;
    };
    customEmitter.particleDestinationGenerator = (index, particle, out) => {
      out.x = out.x + (Math.random() - 0.5) * 18;
      out.y = -8 + Math.random() * 6;
      out.z = out.z + 18 + Math.random() * 16;
    };
    particleSystem.particleEmitterType = customEmitter;
    particleSystem.minEmitPower = 0.2;
    particleSystem.maxEmitPower = 0.5;
    return particleSystem;
  }

  static _bindEmitterToCamera() {
    if (this.cameraObserver) {
      this.scene.onBeforeRenderObservable.remove(this.cameraObserver);
      this.cameraObserver = undefined;
    }
    this.cameraObserver = this.scene.onBeforeRenderObservable.add(() => {
      const camera = this.scene.activeCamera;
      if (!camera) return;
      this.emitter.position.copyFrom(camera.globalPosition);
      this.emitter.position.y += 6;
    });
  }

  static start(
    color1: Color4,
    color2: Color4 = color1,
    colorDead: Color4 = color1
  ) {
    if (this.activeParticles) {
      this.stop();
    }
    this.activeParticles = this._getParticleSystem();
    this._bindEmitterToCamera();
    this.activeParticles.color1.copyFrom(color1);
    this.activeParticles.color2.copyFrom(color2);
    this.activeParticles.colorDead.copyFrom(colorDead);
    this.activeParticles.start();
  }

  static startNatureAmbient(profile: "lush" | "premium" = "lush") {
    const colors =
      profile === "premium"
        ? {
            color1: new Color4(0.92, 0.88, 0.7, 0.24),
            color2: new Color4(0.68, 0.79, 0.58, 0.18),
            dead: new Color4(0.52, 0.57, 0.46, 0),
          }
        : {
            color1: new Color4(0.82, 0.92, 0.68, 0.2),
            color2: new Color4(0.58, 0.76, 0.5, 0.16),
            dead: new Color4(0.46, 0.56, 0.38, 0),
          };
    this.start(colors.color1, colors.color2, colors.dead);
  }

  static stop() {
    if (!this.activeParticles) return;
    if (this.cameraObserver) {
      this.scene.onBeforeRenderObservable.remove(this.cameraObserver);
      this.cameraObserver = undefined;
    }
    this.activeParticles.stop();
    this.activeParticles.dispose(false);
  }
}
