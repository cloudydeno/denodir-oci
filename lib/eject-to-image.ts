import {
  Manifest,
  ManifestOCI,
  ManifestOCIIndex,
  MEDIATYPE_MANIFEST_LIST_V2,
  MEDIATYPE_MANIFEST_V2,
  MEDIATYPE_OCI_MANIFEST_INDEX_V1,
  MEDIATYPE_OCI_MANIFEST_V1,
} from "../deps.ts";

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

  const manifestRaw = await opts.store.getFullLayer('manifest', opts.dociDigest);
  const manifest: ManifestOCI = JSON.parse(new TextDecoder().decode(manifestRaw));

  const baseConfig: OciImageConfig = JSON.parse(new TextDecoder().decode(await opts.store.getFullLayer('blob', baseManifest.config.digest)));

  // Add the DOCI layers to the Docker config
  for (const layer of manifest.layers) {
    const uncompressedHasher = new Sha256Writer();
    await gunzipReaderToWriter(
      await opts.store.getLayerReader('blob', layer.digest),
      uncompressedHasher);

    const uncompressedSha256 = uncompressedHasher.toHexString();

    baseConfig.history?.push({
      created: new Date().toISOString(),
      created_by: `deno cache ${layer.annotations?.['specifier'].replace('file:///denodir/deps/file/', '') ?? '[...]'}`,
      comment: `Ejected from denodir-oci`,
    });
    baseConfig.rootfs.diff_ids.push(`sha256:${uncompressedSha256}`);
  }

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
      ...manifest.layers,
    ],
    annotations: {
      ...opts.annotations,
      'org.opencontainers.image.base.digest': opts.baseDigest,
    },
  }));

  return manifestDesc;
}

interface OciImageConfig {
  architecture: string;
  config: Record<string, unknown> & {
    Env: Array<string>;
    Cmd: Array<string>;
    Entrypoint: Array<string>;
  };
  container?: string;
  container_config?: Record<string, unknown>;
  created?: string;
  docker_version?: string;
  history?: Array<{
    created: string;
    // '/bin/sh -c #(nop)  ENTRYPOINT ["/tini" "--" "docker-entrypoint.sh"]'
    // "/bin/sh -c #(nop)  ENV DENO_VERSION=1.18.2",
    // "/bin/sh -c #(nop) ADD file:ca1682d5ead8dac405b02e4fb8281ffcc95bee5b63f69e7bafca35359765ad90 in / "
    // "/bin/sh -c chmod 755 /usr/local/bin/docker-entrypoint.sh"
    created_by: string;
    empty_layer?: true;
    author?: string;
    comment?: string;
  }>;
  os: string;
  rootfs: {
    type: 'layers',
    diff_ids: Array<string>;
  };
};
