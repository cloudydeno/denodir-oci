
export interface DociConfigLayer {
  specifier: string;
}
export interface DociConfigTarget {
  ref: string;
  baseRef?: string;
}
export interface DociConfig {
  localFileRoot?: string;
  entrypoint: DociConfigLayer;
  dependencyLayers?: Array<DociConfigLayer>;
  cacheFlags?: Array<string>;
  runtimeFlags?: Array<string>;
  ejections?: Record<string, {
    base: string;
  }>;
  targets?: Record<string, DociConfigTarget>;
  importmap?: {
    imports: Record<string,string>;
  };
}
