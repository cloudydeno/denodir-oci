export interface DenodirArtifactConfig {
  builtWith: typeof Deno.version;
  entrypoint: string;
  cacheFlags?: Array<string>;
  runtimeFlags: Array<string>;
  importmap?: {
    imports: Record<string,string>;
  };
};

export interface OciImageConfig {
  architecture: string;
  config: Record<string, unknown> & {
    Env: Array<string>;
    Cmd: Array<string>;
    Entrypoint: Array<string>;
  };
  container?: string;
  container_config?: Record<string, unknown>;
  created?: string;
  docker_version?: string;
  history?: Array<{
    created: string;
    created_by: string;
    empty_layer?: true;
    author?: string;
    comment?: string;
  }>;
  os: string;
  rootfs: {
    type: 'layers';
    diff_ids: Array<string>;
  };
};
