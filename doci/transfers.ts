import {
  forEach,
  ManifestOCI,
  ManifestOCIIndex,
  MEDIATYPE_MANIFEST_V2,
  MEDIATYPE_MANIFEST_LIST_V2,
  MEDIATYPE_OCI_MANIFEST_V1,
  MEDIATYPE_OCI_MANIFEST_INDEX_V1,
  parseRepoAndRef,
  ProgressBar,
  RegistryRepo,
  Manifest,
  ManifestOCIDescriptor,
  ManifestV2,
} from "../deps.ts";
import * as OciStore from "../lib/store.ts";
import { OciRegistry } from "../lib/store/registry.ts";

export async function pushFullArtifact(sourceStore: OciStore.Api, manifestDigest: string, destination: string, forceTag?: string) {
  const manifestRaw = await sourceStore.getFullLayer('manifest', manifestDigest);
  const manifest: ManifestOCI | ManifestOCIIndex = JSON.parse(new TextDecoder().decode(manifestRaw));

  var rar = parseRepoAndRef(destination);
  const ref = forceTag ?? rar.tag ?? rar.digest;
  if (!ref) throw 'No desired tag or digest found';

  const client = await OciStore.registry(rar, ['pull', 'push']);

  if (manifest.mediaType == 'application/vnd.oci.image.manifest.v1+json') {
    const resp = await pushFullImage({
      manifest,
      manifestRaw,
      ref,
      sourceStore,
      client,
    });
    console.error('==>', 'Image upload complete!', resp.digest);

  } else if (manifest.mediaType == 'application/vnd.oci.image.index.v1+json') {
    for (const item of manifest.manifests) {
      const innerManifestRaw = await sourceStore.getFullLayer('manifest', item.digest);
      const innerManifest: ManifestOCI = JSON.parse(new TextDecoder().decode(innerManifestRaw));

      const resp = await pushFullImage({
        manifest: innerManifest,
        manifestRaw: innerManifestRaw,
        ref: item.digest,
        sourceStore,
        client,
      });
    }

    const resp = await client.api.putManifest({
      manifestData: manifestRaw,
      mediaType: manifest.mediaType,
      ref: ref,
    });
    console.error('==>', 'Index upload complete!', resp.digest);

  } else throw new Error(`Unhandled manifest mediaType ${JSON.stringify(manifest.mediaType)}`);
}

export async function pushFullImage(opts: {
  sourceStore: OciStore.Api;
  manifest: ManifestOCI;
  manifestRaw: Uint8Array;
  client: OciRegistry;
  ref: string;
}) {
  for (const layer of [opts.manifest.config, ...opts.manifest.layers]) {
    if (await opts.client.hasBlob(layer.digest)) {
      console.error('   ', 'Registry already has', layer.digest);
    } else {
      console.error('   ', 'Uploading', layer.digest, '...');
      await opts.client.uploadBlob(layer, () => opts.sourceStore
        .getLayerStream('blob', layer.digest)
        .then(stream => stream
          .pipeThrough(showStreamProgress(layer.size))));
      console.error('-->', 'Layer', layer.digest, 'uploaded!');
    }
  }

  return await opts.client.api.putManifest({
    manifestData: opts.manifestRaw,
    mediaType: opts.manifest.mediaType,
    ref: opts.ref,
  });
}

export async function pullFullArtifact(store: OciStore.Api, reference: string) {

  var rar = parseRepoAndRef(reference);
  const ref = rar.tag ?? rar.digest;
  if (!ref) throw 'No desired tag or digest found';

  const puller = await ArtifactPuller.makeForReference(store, rar);

  const descriptor = await puller.resolveRef(ref);

  return {
    descriptor: await puller.pullArtifact(descriptor),
    reference: rar,
  };
}

class ArtifactPuller {
  constructor(
    private readonly sourceStore: OciStore.Api,
    private readonly targetStore: OciStore.Api,
    public readonly image: RegistryRepo,
  ) {}

  static async makeForReference(targetStore: OciStore.Api, image: RegistryRepo) {
    const client = await OciStore.registry(image, ['pull']);
    return new ArtifactPuller(client, targetStore, image);
  }

  async readManifest(digestOrTag: string) {
    const blob = await this.sourceStore.getFullLayer('manifest', digestOrTag);
    const json: Manifest = JSON.parse(new TextDecoder().decode(blob));
    return {bytes: blob, json};
  }

  async resolveRef(ref: string) {
    const stat = await this.sourceStore.describeManifest(ref);
    if (!stat?.digest) throw new Error(`Failed to resolve remote ref ${ref}`);
    return stat;
  }

  async pullArtifact(descriptor: ManifestOCIDescriptor) {
    if (descriptor.mediaType == MEDIATYPE_MANIFEST_LIST_V2
        || descriptor.mediaType == MEDIATYPE_OCI_MANIFEST_INDEX_V1) {
      return await this.pullList(descriptor);
    }

    if (descriptor.mediaType != MEDIATYPE_OCI_MANIFEST_V1
        && descriptor.mediaType != MEDIATYPE_MANIFEST_V2) {
      throw new Error(`Received manifest of unsupported type "${descriptor.mediaType}. Is this actually a Denodir artifact, or just a normal Docker image?`);
    }

    return await this.pullImage(descriptor);
  }

  async pullList(descriptor: ManifestOCIDescriptor) {
    const manifest = await this.readManifest(descriptor.digest);

    const indexManifest = manifest.json as ManifestOCIIndex;
    for (const childManifest of indexManifest.manifests) {
      await this.pullImage(childManifest);
    }

    const result = await this.targetStore.putLayerFromBytes('manifest', {
      mediaType: manifest.json.mediaType ?? descriptor.mediaType,
      digest: descriptor.digest,
      annotations: {
        ...descriptor.annotations,
        'vnd.denodir.origin': this.image.canonicalName ?? '',
      },
    }, manifest.bytes);

    console.error('==>', `Pull of ${indexManifest.manifests.length} images complete!`, descriptor.digest);
    return result;
  }

  async pullImage(descriptor: ManifestOCIDescriptor) {
    const manifest = await this.readManifest(descriptor.digest);

    const manifestMediaType = manifest.json.mediaType ?? descriptor.mediaType;
    if (manifestMediaType != MEDIATYPE_OCI_MANIFEST_V1
        && manifestMediaType != MEDIATYPE_MANIFEST_V2) {
      throw new Error(`Received manifest of unsupported type "${manifestMediaType}". Is this actually a normal container image?`);
    }
    const manifestJson = manifest.json as ManifestV2 | ManifestOCI;

    for (const layer of [manifestJson.config, ...manifestJson.layers]) {
      const layerStat = await this.targetStore.statLayer('blob', layer.digest);
      if (layerStat) {
        if (layerStat.size !== layer.size) {
          throw new Error(`Digest ${layer.digest} clashed (size: ${layerStat.size} vs ${layer.size}). This isn't supposed to happen`);
        }
        console.error('   ', 'Layer', layer.digest, 'is already present on disk');
      } else {
        console.error('   ', 'Need to download', layer.digest, '...');
        await this.targetStore.putLayerFromStream('blob', layer, await this.sourceStore
          .getLayerStream('blob', layer.digest)
          .then(stream => stream
            .pipeThrough(showStreamProgress(layer.size))));
        console.error('-->', 'Layer', layer.digest, 'downloaded!');
      }
    }

    const result = await this.targetStore.putLayerFromBytes('manifest', {
      mediaType: manifestMediaType,
      digest: descriptor.digest,
      annotations: {
        ...descriptor.annotations,
        'vnd.denodir.origin': this.image.canonicalName ?? '',
      },
    }, manifest.bytes);

    console.error('==>', 'Pull complete!', descriptor.digest);
    return result;
  }
}

function showStreamProgress(totalSize: number) {
  const progressBar = new ProgressBar({
    total: totalSize,
  });

  let bytesSoFar = 0;
  return forEach<Uint8Array>(buffer => {
    bytesSoFar += buffer.byteLength;
    progressBar.render(bytesSoFar);
  });
}
