import {
  Manifest,
  ManifestOCI,
  ManifestOCIIndex,
  MEDIATYPE_MANIFEST_LIST_V2,
  MEDIATYPE_MANIFEST_V2,
  MEDIATYPE_OCI_MANIFEST_INDEX_V1,
  MEDIATYPE_OCI_MANIFEST_V1,
  oci,
} from "../deps.ts";

import type { DenodirArtifactConfig } from "./types.ts";
import { renderImportmapFlag } from "./util/importmap.ts";

/**
 * Combine a base docker image with a denodir artifact
 * Results in a runnable image
 * Tested with: Docker, podman, containerd
 */
export async function ejectToImage(opts: {
  store: oci.OciStoreApi;
  baseDigest: string;
  dociDigest: string;
  annotations?: Record<string, string>;
}) {

  const baseManifest: Manifest = JSON.parse(new TextDecoder().decode(await opts.store.getFullLayer('manifest', opts.baseDigest)));

  // When given a multi-arch manifest, produce a multi-arch manifest as well
  if (baseManifest.mediaType == MEDIATYPE_OCI_MANIFEST_INDEX_V1
    || baseManifest.mediaType == MEDIATYPE_MANIFEST_LIST_V2) {

    const newList: ManifestOCIIndex = {
      schemaVersion: 2,
      mediaType: MEDIATYPE_OCI_MANIFEST_INDEX_V1,
      annotations: opts.annotations,
      manifests: await Promise.all((<ManifestOCIIndex>baseManifest).manifests
        .filter(archManifest => archManifest.platform?.os !== 'unknown') // remove attestation-manifests
        .map(archManifest =>
          ejectToImage({ ...opts,
            baseDigest: archManifest.digest,
          }).then(ejected => ({ ...archManifest, ...ejected }))
        )),
    };

    return await opts.store.putLayerFromBytes('manifest', {
      mediaType: MEDIATYPE_OCI_MANIFEST_INDEX_V1,
    }, oci.stableJsonSerialize(newList));

  } else if (baseManifest.mediaType !== MEDIATYPE_MANIFEST_V2
   && baseManifest.mediaType !== MEDIATYPE_OCI_MANIFEST_V1) {
    throw new Error(`Base manifest at ${opts.baseDigest} has unsupported mediaType`);
  }

  const dociManifest: ManifestOCI = JSON.parse(new TextDecoder().decode(await opts.store.getFullLayer('manifest', opts.dociDigest)));

  const baseConfig: oci.OciImageConfig = JSON.parse(new TextDecoder().decode(await opts.store.getFullLayer('blob', baseManifest.config.digest)));
  const dociConfig: DenodirArtifactConfig = JSON.parse(new TextDecoder().decode(await opts.store.getFullLayer('blob', dociManifest.config.digest)));

  const configWriter = new oci.ImageConfigWriter(baseConfig, `cloudydeno.denodir-oci.v0`);

  const knownDenodir = configWriter.getEnv('DENO_DIR');
  if (knownDenodir !== '/denodir') {
    configWriter.setEnv(`DENO_DIR`, `/denodir`);
  }

  // Add the DOCI layers to the Docker config
  for (const layer of dociManifest.layers) {
    const diffDigest = layer.annotations?.['uncompressed-digest']
      ?? await getUncompressedDigest(opts.store, layer.digest);
    const briefSpecifier = layer.annotations?.['specifier']
      .replace('file:///denodir/deps/file/', '');

    configWriter.recordDiffLayer({
      command: `RUN deno cache ${briefSpecifier ?? '[...]'}`,
      diffDigest,
    });
  }

  const runFlags = [
    ...dociConfig.runtimeFlags,
  ];
  if (dociConfig.importmap) {
    runFlags.push(renderImportmapFlag(dociConfig.importmap.imports));
  }

  configWriter.setEntrypoint([
    `deno`, `run`,
    `--cached-only`,
    ...runFlags,
    dociConfig.entrypoint,
  ]);
  configWriter.setCommand([]);

  const configDesc = await opts.store.putLayerFromBytes('blob', {
    mediaType: "application/vnd.oci.image.config.v1+json",
  }, oci.stableJsonSerialize(configWriter.data));

  const manifestDesc = await opts.store.putLayerFromBytes('manifest', {
    mediaType: MEDIATYPE_OCI_MANIFEST_V1,
  }, oci.stableJsonSerialize<ManifestOCI>({
    schemaVersion: 2,
    mediaType: MEDIATYPE_OCI_MANIFEST_V1,
    config: configDesc,
    layers: [
      ...baseManifest.layers,
      ...dociManifest.layers.map(descriptor => ({
        ...descriptor,
        mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
      })),
    ],
    annotations: {
      ...opts.annotations,
      'org.opencontainers.image.base.digest': opts.baseDigest,
    },
  }));

  return manifestDesc;
}

async function getUncompressedDigest(store: oci.OciStoreApi, blobDigest: string) {
  const blobReader = await store.getLayerStream('blob', blobDigest);
  const decompressed = blobReader.pipeThrough(new DecompressionStream("gzip"));
  return `sha256:${await oci.sha256stream(decompressed)}`;
}
