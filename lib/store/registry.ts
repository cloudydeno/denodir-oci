import {
  ManifestOCIDescriptor,
  RegistryClientOpts,
  RegistryClientV2,
  RegistryHttpError,
  RegistryRepo,
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
  putLayerFromBytes(flavor: "blob"|"manifest",descriptor: Omit<ManifestOCIDescriptor,"digest"|"size">&{ digest?: string|undefined; },rawData: Uint8Array): Promise<ManifestOCIDescriptor> {
    throw new Error("Method not implemented.");
  }
  async statLayer(flavor: "blob"|"manifest", ref: string): Promise<{ size: number; digest: string }|null> {
    if (flavor == 'blob') {
      const resp = await this.api.headBlob({ digest: ref });
      console.log({headers:resp[0].headers})
      throw new Error("Method not implemented.");
    }
    if (flavor == 'manifest') {
      // TODO: this should only be a HEAD request; needs library support
      const {resp} = await this.api.getManifest({ ref });
      const contentLength = resp.headers.get('content-length');
      const contentDigest = resp.headers.get('docker-content-digest');
      if (!contentLength || !contentDigest) throw new Error(`Registry didn't give length/digest`);
      return {
        size: parseInt(contentLength),
        digest: contentDigest,
      };
    }
    throw new Error("Flavor not implemented.");
  }

  async describeManifest(reference: string): Promise<ManifestOCIDescriptor> {
    // TODO: this should only be a HEAD request; needs library support
    const {resp} = await this.api.getManifest({ ref: reference });
    // if (resp.status == 404)

    const contentType = resp.headers.get('content-type');
    const contentLength = resp.headers.get('content-length');
    const contentDigest = resp.headers.get('docker-content-digest');
    if (!contentType || !contentLength || !contentDigest) throw new Error(
      `Registry didn't give type/length/digest headers for ${reference}`);

    return {
      mediaType: contentType,
      size: parseInt(contentLength),
      digest: contentDigest,
    };
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
    throw new Error("Flavor not implemented.");
  }
  async getLayerStream(flavor: "blob"|"manifest",digest: string): Promise<ReadableStream<Uint8Array>> {
    if (flavor == 'blob') {
      const bundle = await this.api.createBlobReadStream({digest});
      return bundle.stream;
    }
    throw new Error("Flavor not implemented.");
  }
}

function nullIf404(err: unknown) {
  if (err instanceof RegistryHttpError && err.resp.status == 404) return null;
  throw err;
}


export async function getOciRegistry(repo: RegistryRepo, scopes: ['pull', 'push'] | ['pull']) {
  const config: RegistryClientOpts = {
    repo, scopes,
    acceptOCIManifests: true,
    acceptManifestLists: true,
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
