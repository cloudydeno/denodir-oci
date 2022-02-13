import type {
  ManifestOCIDescriptor,
} from "../../deps.ts";

export interface OciStoreApi {

  putLayerFromFile(
    flavor: 'blob' | 'manifest',
    descriptor: ManifestOCIDescriptor,
    sourcePath: string,
  ): Promise<ManifestOCIDescriptor>;

  putLayerFromStream(
    flavor: 'blob' | 'manifest',
    descriptor: ManifestOCIDescriptor,
    stream: ReadableStream<Uint8Array>,
  ): Promise<ManifestOCIDescriptor>;

  putLayerFromString(
    flavor: 'blob' | 'manifest',
    descriptor: Omit<ManifestOCIDescriptor, 'digest' | 'size'> & { digest?: string },
    rawString: string,
  ): Promise<ManifestOCIDescriptor>;

  putLayerFromBytes(
    flavor: 'blob' | 'manifest',
    descriptor: Omit<ManifestOCIDescriptor, 'digest' | 'size'> & { digest?: string },
    rawData: Uint8Array,
  ): Promise<ManifestOCIDescriptor>;

  statLayer(flavor: 'blob' | 'manifest', digest: string): Promise<{
    size: number;
  } | null>;

  getFullLayer(flavor: 'blob' | 'manifest', digest: string): Promise<Uint8Array>;

  getLayerReader(flavor: 'blob' | 'manifest', digest: string): Promise<Deno.Reader>;

  getLayerStream(flavor: 'blob' | 'manifest', digest: string): Promise<ReadableStream<Uint8Array>>;

  // async extractLayerLocally(layer: ManifestOCIDescriptor, destFolder: string);
}
