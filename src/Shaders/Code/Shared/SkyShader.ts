export class SkyShaders {
    static Functions = /* glsl */ `

// dveSunDirection: world-space direction the DirectionalLight points (FROM scene TOWARD nothing).
// Negate it to get the vector FROM scene TOWARD the sun.
uniform vec3 dveSunDirection;

vec3 getSkyColor(vec3 fogColor) {
    float heightBlend = smoothstep(scene_skyOptions.x, scene_skyOptions.z, worldPOS.y);
    vec3 skyBase = mix(fogColor, scene_skyColor, heightBlend);

    // --- Sun disk + atmospheric glow ---
    vec3 viewDir = normalize(worldPOS - cameraPosition);
    vec3 sunDir  = normalize(-dveSunDirection); // direction FROM scene TO sun

    float cosAngle = dot(viewDir, sunDir);

    // Hard sun disk (very tight cone, ~0.27°)
    float sunDisk = smoothstep(0.9998, 1.0, cosAngle);

    // Soft atmospheric halo decays with angular distance
    float angularDist = acos(clamp(cosAngle, -1.0, 1.0));
    float sunHalo = exp(-angularDist * angularDist * 3.8) * 0.45;

    // Horizon scatter: warm band near the sun on the horizon
    float belowHorizon = clamp(-sunDir.y * 2.5, 0.0, 1.0); // brighter when sun is low
    float scatter = exp(-angularDist * angularDist * 0.9) * belowHorizon * 0.25;

    vec3 sunColor  = vec3(1.4, 1.35, 1.1);  // warm white disk
    vec3 haloColor = vec3(1.2, 1.0, 0.65);  // golden halo
    vec3 scatterColor = vec3(1.1, 0.7, 0.4); // orange scatter near horizon

    // Only draw sun elements above a minimum elevation (avoid sun underground)
    float sunVisible = smoothstep(-0.12, 0.02, sunDir.y);

    return skyBase
         + sunColor   * sunDisk  * sunVisible
         + haloColor  * sunHalo  * sunVisible
         + scatterColor * scatter;
}

vec4 blendSkyColor(vec3 skyColor, vec4 baseColor) {
    if(vDistance > scene_skyShadeOptions.y) {
        return vec4( skyColor, 1.);
    }
    float blendFactor = smoothstep(scene_skyShadeOptions.x, scene_skyShadeOptions.y, vDistance);
    return vec4( mix(baseColor.rgb, skyColor, blendFactor), baseColor.a);
}


      `;

  }
  