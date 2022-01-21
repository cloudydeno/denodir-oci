import {
  assertEquals,
  ManifestOCIDescriptor,
  path,
  RegistryClientOpts,
  RegistryClientV2,
  RegistryHttpError,
  RegistryImage,
} from "../deps.ts";

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

  const dockerConfig = await readDockerConfig();
  if (repo.index.name in (dockerConfig.credHelpers ?? {})) {
    throw new Error(`TODO: credHelpers`);
  } else {
    for (const [server, {auth}] of Object.entries(dockerConfig.auths ?? {})) {
      const hostname = server.includes('://') ? new URL(server).hostname : server;
      if (hostname == repo.index.name
          || (hostname == 'index.docker.io' && repo.index.name == 'docker.io')) {
        const basicAuth = atob(auth).split(':');
        assertEquals(basicAuth.length, 2);
        config.username = basicAuth[0];
        config.password = basicAuth[1];
        break;
      }
    }
  }

  console.log('   ', 'Creating OCI client for', repo.index.name,
    'as user', config.username, 'for', scopes);
  const apiClient = new RegistryClientV2(config);
  return new OciRegistry(apiClient);
}

async function readDockerConfig(): Promise<DockerConfig> {
  const filePath = path.join(Deno.env.get('HOME') ?? '.', '.docker', 'config.json');
  try {
    return await import(filePath, { assert: { type: "json" }}).then(x => x.default);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return {};
    throw err;
  }
}

interface DockerConfig {
  auths?: Record<string, {
    auth: string;
    email?: string;
  }>;
  credHelpers?: Record<string, string>;
}
