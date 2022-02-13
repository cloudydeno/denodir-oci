import {
  forEach,
  ManifestOCI,
  MEDIATYPE_MANIFEST_V2,
  MEDIATYPE_OCI_MANIFEST_V1,
  parseRepoAndRef,
  ProgressBar,
} from "../deps.ts";
import * as OciStore from "../lib/store.ts";

export async function pushFullArtifact(sourceStore: OciStore.Api, manifestDigest: string, destination: string) {
  const manifestRaw = await sourceStore.getFullLayer('manifest', manifestDigest);
  const manifest: ManifestOCI = JSON.parse(new TextDecoder().decode(manifestRaw));

  var rar = parseRepoAndRef(destination);
  const ref = rar.tag ?? rar.digest;
  if (!ref) throw 'No desired tag or digest found';

  const client = await OciStore.registry(rar, ['pull', 'push']);

  for (const layer of [manifest.config, ...manifest.layers]) {
    if (await client.hasBlob(layer.digest)) {
      console.error('   ', 'Layer', layer.digest, 'is already present on registry');
    } else {
      console.error('   ', 'Need to upload', layer.digest, '...');
      await client.uploadBlob(layer, () => sourceStore
        .getLayerStream('blob', layer.digest)
        .then(stream => stream
          .pipeThrough(showStreamProgress(layer.size))));
      console.error('-->', 'Layer', layer.digest, 'uploaded!');
    }
  }

  const resp = await client.api.putManifest({
    manifestData: manifestRaw,
    mediaType: manifest.mediaType,
    ref,
  });
  console.error('==>', 'Upload complete!', resp.digest);
}

export async function pullFullArtifact(store: OciStore.Api, reference: string) {
  var rar = parseRepoAndRef(reference);
  const ref = rar.tag ?? rar.digest;
  if (!ref) throw 'No desired tag or digest found';

  const client = await OciStore.registry(rar, ['pull']);

  const {manifest, resp: manifestResp} = await client.api.getManifest({ ref })
  if (manifest.mediaType != MEDIATYPE_OCI_MANIFEST_V1
      && manifest.mediaType != MEDIATYPE_MANIFEST_V2) {
    throw new Error(`Received manifest of unsupported type "${manifest.mediaType}. Is this actually a Denodir artifact, or just a normal Docker image?`);
  }

  const manifestDigest = manifestResp.headers.get('docker-content-digest');
  if (!manifestDigest?.startsWith('sha256:')) {
    throw new Error(`Received manifest with weird digest "${manifestDigest}`);
  }

  for (const layer of [manifest.config, ...manifest.layers]) {
    const layerStat = await store.statLayer('blob', layer.digest);
    if (layerStat) {
      if (layerStat.size !== layer.size) {
        throw new Error(`Digest ${layer.digest} clashed (size: ${layerStat.size} vs ${layer.size}). This isn't supposed to happen`);
      }
      console.error('   ', 'Layer', layer.digest, 'is already present on disk');
    } else {
      console.error('   ', 'Need to download', layer.digest, '...');
      await store.putLayerFromStream('blob', layer, await client
        .getBlobStream(layer.digest)
        .then(stream => stream
          .pipeThrough(showStreamProgress(layer.size))));
      console.error('-->', 'Layer', layer.digest, 'downloaded!');
    }
  }

  const manifestDescriptor = await store.putLayerFromBytes('manifest', {
    mediaType: manifest.mediaType,
    digest: manifestDigest,
    annotations: {
      'vnd.denodir.origin': rar.canonicalName ?? '',
    },
  }, await manifestResp.dockerBody());

  console.error('==>', 'Pull complete!', manifestDescriptor.digest);
  return manifestDescriptor;
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
