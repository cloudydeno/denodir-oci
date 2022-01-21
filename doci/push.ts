import { ManifestOCI, parseRepoAndRef } from "../deps.ts";
import { getOciRegistry } from "../lib/registry.ts";
import { OciStore } from "../lib/store.ts";
import { showStreamProgress } from "./progress.ts";

export async function pushFullArtifact(store: OciStore, manifestDigest: string, destination: string) {
  const manifestRaw = await store.getFullLayer('manifest', manifestDigest);
  const manifest: ManifestOCI = JSON.parse(new TextDecoder().decode(manifestRaw));

  var rar = parseRepoAndRef(destination);
  const ref = rar.tag ?? rar.digest;
  if (!ref) throw 'No desired tag or digest found';

  const client = await getOciRegistry(rar, ['pull', 'push']);

  for (const layer of [manifest.config, ...manifest.layers]) {
    if (await client.hasBlob(layer.digest)) {
      console.log('   ', 'Layer', layer.digest, 'is already present on registry');
    } else {
      console.log('   ', 'Need to upload', layer.digest, '...');
      await client.uploadBlob(layer, () => store
        .getLayerStream('blob', layer.digest)
        .then(stream => stream
          .pipeThrough(showStreamProgress(layer.size))));
      console.log('-->', 'Layer', layer.digest, 'uploaded!');
    }
  }

  const resp = await client.api.putManifest({
    manifestData: manifestRaw,
    mediaType: manifest.mediaType,
    ref,
  });
  console.log('==>', 'Upload complete!', resp);
}
