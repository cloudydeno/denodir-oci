import {
  ManifestOCIDescriptor,
  readerFromIterable,
  RegistryClientOpts,
  RegistryClientV2,
  RegistryHttpError,
  RegistryImage,
} from "../../deps.ts";
import { fetchDockerCredential } from "../docker-config.ts";
import { OciStoreApi } from "./_api.ts";

/** Simple API around an OCI / Docker registry. */
export class OciRegistry implements OciStoreApi {
  constructor(
    public readonly api: RegistryClientV2,
  ) {}

  async hasBlob(digest: string) {
    return await this.api
      .headBlob({ digest })
      .catch(nullIf404)
      .then(x => !!x);
  }

  async uploadBlob(
    layer: ManifestOCIDescriptor,
    streamFactory: () => Promise<ReadableStream<Uint8Array>>,
  ) {
    await this.api.blobUpload({
      digest: layer.digest,
      contentLength: layer.size,
      stream: await streamFactory(),
    });
  }

  async getBlobStream(digest: string) {
    const bundle = await this.api.createBlobReadStream({digest});
    return bundle.stream;
  }


  putLayerFromFile(flavor: "blob"|"manifest",descriptor: ManifestOCIDescriptor,sourcePath: string): Promise<ManifestOCIDescriptor> {
    throw new Error("Method not implemented.");
  }
  putLayerFromStream(flavor: "blob"|"manifest",descriptor: ManifestOCIDescriptor,stream: ReadableStream<Uint8Array>): Promise<ManifestOCIDescriptor> {
    throw new Error("Method not implemented.");
  }
  putLayerFromString(flavor: "blob"|"manifest",descriptor: Omit<ManifestOCIDescriptor,"digest"|"size">&{ digest?: string|undefined; },rawString: string): Promise<ManifestOCIDescriptor> {
    throw new Error("Method not implemented.");
  }
  putLayerFromBytes(flavor: "blob"|"manifest",descriptor: Omit<ManifestOCIDescriptor,"digest"|"size">&{ digest?: string|undefined; },rawData: Uint8Array): Promise<ManifestOCIDescriptor> {
    throw new Error("Method not implemented.");
  }
  statLayer(flavor: "blob"|"manifest",digest: string): Promise<{ size: number; }|null> {
    throw new Error("Method not implemented.");
  }
  async getFullLayer(flavor: "blob"|"manifest",digest: string): Promise<Uint8Array> {
    if (flavor == 'blob') {
      const resps = await this.api._headOrGetBlob('GET', digest)
      return resps.slice(-1)[0].dockerBody();
    }
    if (flavor == 'manifest') {
      const { resp } = await this.api.getManifest({
        ref: digest,
        acceptOCIManifests: true,
        acceptManifestLists: true,
      });
      return await resp.dockerBody();
    }
    throw new Error("Method not implemented.");
  }
  async getLayerStream(flavor: "blob"|"manifest",digest: string): Promise<ReadableStream<Uint8Array>> {
    if (flavor == 'blob') {
      const bundle = await this.api.createBlobReadStream({digest});
      return bundle.stream;
    }
    throw new Error("Method not implemented.");
  }
}

function nullIf404(err: unknown) {
  if (err instanceof RegistryHttpError && err.resp.status == 404) return null;
  throw err;
}


export async function getOciRegistry(repo: RegistryImage, scopes: ['pull', 'push'] | ['pull']) {
  const config: RegistryClientOpts = {
    repo, scopes,
    acceptOCIManifests: true,
  };

  const credential = await fetchDockerCredential(repo.index.name);
  if (credential) {
    config.username = credential.Username;
    config.password = credential.Secret;
  }

  console.error('-->', 'Creating OCI client for', repo.index.name,
    'for', scopes, 'as', config.username);
  const apiClient = new RegistryClientV2(config);
  return new OciRegistry(apiClient);
}
