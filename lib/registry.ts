import {
  ManifestOCIDescriptor,
  RegistryClientOpts,
  RegistryClientV2,
  RegistryHttpError,
  RegistryImage,
} from "../deps.ts";
import { fetchDockerCredential } from "./docker-config.ts";

/** Simple API around an OCI / Docker registry. */
export class OciRegistry {
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
      contentType: layer.mediaType,
      stream: await streamFactory(),
    });
  }

  async getBlobStream(digest: string) {
    const bundle = await this.api.createBlobReadStream({digest});
    return bundle.stream;
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

  console.log('-->', 'Creating OCI client for', repo.index.name,
    'for', scopes, 'as', config.username);
  const apiClient = new RegistryClientV2(config);
  return new OciRegistry(apiClient);
}
