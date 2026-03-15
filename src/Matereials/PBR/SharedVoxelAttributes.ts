/**
 * SharedVoxelAttributes — fuente canónica de los nombres de atributo de vértice
 * compartidos entre DVEDissolutionPlugin y DVELODMorphPlugin.
 *
 * Ambos plugins deben importar desde aquí. Ninguno debe asumir que el otro
 * ya registró el atributo — BabylonJS deduplica en el shader, por lo que
 * declararlo en los dos es seguro e intencionado.
 */
export const SharedVoxelAttributes = {
  DissolutionProximity: "dissolutionProximity",
  PullStrength: "pullStrength",
  SubdivLevel: "subdivLevel",
  PullDirectionBias: "pullDirectionBias",
  PhNormalized: "phNormalized",
  SubdivAO: "subdivAO",
} as const;
