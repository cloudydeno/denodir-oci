import { ManifestOCIDescriptor } from "../deps.ts";
import { Manifest } from "../deps.ts";
import { ManifestOCI } from "../deps.ts";
import { OciStore } from "./store.ts";
import { Sha256Writer } from "./util/digest.ts";
import { gunzipReaderToWriter } from "./util/gzip.ts";
import { stableJsonStringify } from "./util/serialize.ts";

/**
 * combine a base docker image with a denodir artifact
 * results in a runnable image
 */
export async function ejectToImage(opts: {
  baseStore: OciStore;
  baseDigest: string;
  dociStore: OciStore;
  dociDigest: string;
}) {

  const manifestRaw = await opts.dociStore.getFullLayer('manifest', opts.dociDigest);
  const manifest: ManifestOCI = JSON.parse(new TextDecoder().decode(manifestRaw));

  const rawBaseMani = await opts.baseStore.getFullLayer('manifest', opts.baseDigest);
  const baseManifest: Manifest = JSON.parse(new TextDecoder().decode(rawBaseMani));
  if (baseManifest.mediaType !== 'application/vnd.docker.distribution.manifest.v2+json') {
    throw new Error(`TODO: weird manifest type for base`);
  }

  const baseConfig: {
    architecture: string;
    config: Record<string, unknown> & {
      Env: Array<string>;
      Cmd: Array<string>;
      Entrypoint: Array<string>;
    };
    container?: string;
    container_config?: Record<string, unknown>;
    created?: string; // 2022-02-04T02:07:57.258877599Z
    docker_version?: string;
    history?: Array<{
      created: string; // 2022-01-26T01:42:33.419780362Z
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
  } = JSON.parse(new TextDecoder().decode(await opts.baseStore.getFullLayer('blob', baseManifest.config.digest)));

  // Add the DOCI layers to the Docker config
  for (const layer of manifest.layers) {
    const uncompressedHasher = new Sha256Writer();
    await gunzipReaderToWriter(
      await opts.dociStore.getLayerReader('blob', layer.digest),
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

  return {
    config: new TextEncoder().encode(stableJsonStringify(baseConfig)),
    layers: [
      ...baseManifest.layers,
      ...manifest.layers,
    ],
    annotations: {
      'org.opencontainers.image.base.digest': opts.baseDigest,
    },
  };
}
