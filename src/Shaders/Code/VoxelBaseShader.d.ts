export declare class VoxelBaseShader {
    static GetVertex(props: {
        doAO: boolean;
        top?: string;
        uniforms?: string;
        attributes?: string;
        instanceAttributes?: string;
        functions?: string;
        varying?: string;
        inMainBefore?: string;
        inMainAfter?: string;
    }): string;
    static DefaultLiquidFragmentMain: (doAO: boolean) => string;
    static DefaultFragmentMain: (doAO: boolean) => string;
    static GetFragment(props: {
        top?: string;
        main: string;
        uniforms?: string;
        functions?: string;
        varying?: string;
        inMainBefore?: string;
        inMainAfter?: string;
    }): string;
}
