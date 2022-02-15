import {
  Manifest,
  ManifestOCI,
  ManifestOCIIndex,
  MEDIATYPE_MANIFEST_LIST_V2,
  MEDIATYPE_MANIFEST_V2,
  MEDIATYPE_OCI_MANIFEST_INDEX_V1,
  MEDIATYPE_OCI_MANIFEST_V1,
} from "../deps.ts";

import type { DenodirArtifactConfig, OciImageConfig } from "./types.ts";
import * as OciStore from "./store.ts";
import { Sha256Writer } from "./util/digest.ts";
import { gunzipReaderToWriter } from "./util/gzip.ts";
import { stableJsonStringify } from "./util/serialize.ts";

/**
 * combine a base docker image with a denodir artifact
 * results in a runnable image
 */
export async function ejectToImage(opts: {
  store: OciStore.Api;
  baseDigest: string;
  dociDigest: string;
  annotations?: Record<string, string>;
}) {

  const rawBaseMani = await opts.store.getFullLayer('manifest', opts.baseDigest);
  const baseManifest: Manifest = JSON.parse(new TextDecoder().decode(rawBaseMani));

  // When given a multi-arch manifest, produce a multi-arch manifest as well
  if (baseManifest.mediaType == MEDIATYPE_OCI_MANIFEST_INDEX_V1
    || baseManifest.mediaType == MEDIATYPE_MANIFEST_LIST_V2) {

    const newList: ManifestOCIIndex = {
      schemaVersion: 2,
      mediaType: MEDIATYPE_OCI_MANIFEST_INDEX_V1,
      annotations: opts.annotations,
      manifests: await Promise.all(baseManifest.manifests
        .map(archManifest =>
          ejectToImage({ ...opts,
            baseDigest: archManifest.digest,
          }).then(ejected => ({ ...archManifest, ...ejected }))
        )),
    };

    return await opts.store.putLayerFromString('manifest', {
      mediaType: MEDIATYPE_OCI_MANIFEST_INDEX_V1,
    }, stableJsonStringify(newList));

  } else if (baseManifest.mediaType !== MEDIATYPE_MANIFEST_V2
   && baseManifest.mediaType !== MEDIATYPE_OCI_MANIFEST_V1) {
    throw new Error(`Base manifest at ${opts.baseDigest} has unsupported mediaType`);
  }

  const dociManifestRaw = await opts.store.getFullLayer('manifest', opts.dociDigest);
  const dociManifest: ManifestOCI = JSON.parse(new TextDecoder().decode(dociManifestRaw));

  const baseConfig: OciImageConfig = JSON.parse(new TextDecoder().decode(await opts.store.getFullLayer('blob', baseManifest.config.digest)));
  const dociConfig: DenodirArtifactConfig = JSON.parse(new TextDecoder().decode(await opts.store.getFullLayer('blob', dociManifest.config.digest)));

  const knownDenodir = baseConfig.config.Env.find(x => x.startsWith('DENO_DIR='));
  if (knownDenodir !== 'DENO_DIR=/denodir') {
    baseConfig.config.Env = baseConfig.config.Env.filter(x => !x.startsWith('DENO_DIR='));
    baseConfig.config.Env.push(`DENO_DIR=/denodir`);
    baseConfig.history?.push({
      empty_layer: true,
      created: new Date().toISOString(),
      created_by: "ENV DENO_DIR=/denodir",
      comment: `Ejected from denodir-oci`,
    });
  }

  // Add the DOCI layers to the Docker config
  for (const layer of dociManifest.layers) {
    const uncompressedHasher = new Sha256Writer();
    await gunzipReaderToWriter(
      await opts.store.getLayerReader('blob', layer.digest),
      uncompressedHasher);

    const uncompressedSha256 = uncompressedHasher.toHexString();

    baseConfig.history?.push({
      created: new Date().toISOString(),
      created_by: `RUN deno cache ${layer.annotations?.['specifier'].replace('file:///denodir/deps/file/', '') ?? '[...]'}`,
      comment: `cloudydeno.denodir-oci.v0`,
    });
    baseConfig.rootfs.diff_ids.push(`sha256:${uncompressedSha256}`);
  }

  baseConfig.config.Cmd = [
    `deno`, `run`,
    `--cached-only`,
    ...dociConfig.runtimeFlags,
    dociConfig.entrypoint,
  ];
  baseConfig.history?.push({
    empty_layer: true,
    created: new Date().toISOString(),
    created_by: `CMD [${baseConfig.config.Cmd.map(x => JSON.stringify(x)).join(' ')}]`,
    comment: `Ejected from denodir-oci`,
  });

  baseConfig.created = new Date().toISOString();

  const configDesc = await opts.store.putLayerFromString('blob', {
    mediaType: "application/vnd.oci.image.config.v1+json",
  }, stableJsonStringify(baseConfig));

  const manifestDesc = await opts.store.putLayerFromString('manifest', {
    mediaType: MEDIATYPE_OCI_MANIFEST_V1,
  }, stableJsonStringify<ManifestOCI>({
    schemaVersion: 2,
    mediaType: MEDIATYPE_OCI_MANIFEST_V1,
    config: configDesc,
    layers: [
      ...baseManifest.layers,
      ...dociManifest.layers,
    ],
    annotations: {
      ...opts.annotations,
      'org.opencontainers.image.base.digest': opts.baseDigest,
    },
  }));

  return manifestDesc;
}
