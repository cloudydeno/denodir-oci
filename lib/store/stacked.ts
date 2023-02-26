import { ManifestOCIDescriptor } from "../../deps.ts";
import { OciStoreApi } from "./_api.ts";

export class StackedStore implements OciStoreApi {
  constructor(
    private readonly roStores: Array<OciStoreApi>,
    private readonly rwStore: OciStoreApi | null,
  ) {
    this.allStores = [
      ...(rwStore ? [rwStore] : []),
      ...roStores,
    ];
  }
  private readonly allStores: OciStoreApi[];

  // Helpers to route to relevant store

  protected async firstReadWithout404<T>(func: (store: OciStoreApi) => Promise<T>): Promise<T> {
    let firstErr: unknown;
    for (const store of this.allStores) {
      try {
        const result = await func(store);
        if (result) return result;
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
        firstErr ??= err;
      }
    }
    throw firstErr ?? new Deno.errors.NotFound(
      `No registered OCI store found the requested resource.`);
  }
  protected ensureRwStore() {
    if (!this.rwStore) throw new Error(`BUG: No writable OCI store registered; write refused`);
    return this.rwStore;
  }

  // Read methods

  async getFullLayer(flavor: 'blob' | 'manifest', digest: string) {
    return await this.firstReadWithout404(store =>
      store.getFullLayer(flavor, digest));
  }
  async getLayerStream(flavor: 'blob' | 'manifest', digest: string) {
    return await this.firstReadWithout404(store =>
      store.getLayerStream(flavor, digest));
  }
  async statLayer(flavor: 'blob' | 'manifest', digest: string) {
    return await this.firstReadWithout404(store =>
      store.statLayer(flavor, digest));
  }
  async describeManifest(reference: string) {
    return await this.firstReadWithout404(store =>
      store.describeManifest(reference));
  }

  // Write methods

  async putLayerFromFile(
    flavor: 'blob' | 'manifest',
    descriptor: ManifestOCIDescriptor,
    sourcePath: string,
  ) {
    const store = this.ensureRwStore();
    return await store.putLayerFromFile(flavor, descriptor, sourcePath);
  }
  async putLayerFromStream(
    flavor: 'blob' | 'manifest',
    descriptor: ManifestOCIDescriptor,
    stream: ReadableStream<Uint8Array>,
  ) {
    const store = this.ensureRwStore();
    return await store.putLayerFromStream(flavor, descriptor, stream);
  }
  async putLayerFromBytes(
    flavor: 'blob' | 'manifest',
    descriptor: Omit<ManifestOCIDescriptor, 'digest' | 'size'> & { digest?: string },
    rawData: Uint8Array,
  ) {
    const store = this.ensureRwStore();
    return await store.putLayerFromBytes(flavor, descriptor, rawData);
  }
}
