import { Scene } from "@babylonjs/core/scene";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
export declare class ImageArrayTexture extends Texture {
    imgs: HTMLImageElement[] | null;
    scene: Scene;
    useCustomMipmaps: boolean;
    width: number;
    height: number;
    constructor(imgs: HTMLImageElement[] | null, scene: Scene, useCustomMipmaps?: boolean);
    private createMipChainForImage;
    private init;
    copy(scene: Scene): ImageArrayTexture;
}
