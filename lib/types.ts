export interface DenodirArtifactConfig {
  builtWith: typeof Deno.version;
  entrypoint: string;
  cacheFlags?: Array<string>;
  runtimeFlags: Array<string>;
  importmap?: {
    imports: Record<string,string>;
  };
};
