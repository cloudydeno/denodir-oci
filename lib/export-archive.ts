// make a tarball for a built artifact
// https://github.com/opencontainers/image-spec/blob/main/image-layout.md

import {
  ManifestOCIDescriptor,
  ManifestV2, ManifestV2Descriptor,
  MEDIATYPE_MANIFEST_V2,
  Tar,
  Buffer,
ManifestOCIIndex,
ManifestOCI,
MEDIATYPE_OCI_MANIFEST_V1,
} from "../deps.ts";
import { OciStore } from "./store.ts";
import { sha256bytesToHex } from "./util/digest.ts";
import { stableJsonStringify } from "./util/serialize.ts";

/**
 * Given a description of an OCI or Docker image,
 * stream the contents of the image to a Tar archive.
 *
 * The whole artifact can be referenced from OciStores by digest.
 * It's also possible to specify inline Manifest info,
 *   including an optional inline Config blob.
 * However all Layer blobs must be stored in the OciStores.
 *
 * When "format" is "docker", the results can be loaded with `docker load`.
 * When "format" is "oci", an OCI Image Layout is created instead.
 * Podman is supposed to be able to load OCI Image Layouts.
 * We'll also be able to load denodir artifact layouts eventually.
 */
export async function exportArtifactAsArchive(opts: {
  manifest: {
    digest: string;
  } | {
    digest?: undefined;
    config: Uint8Array | ManifestOCIDescriptor;
    layers: Array<ManifestOCIDescriptor>;
  };
  stores: Array<OciStore>;
  fullRef?: string;
  format: 'docker' | 'oci';
}) {

  // TODO: virtual OciStore that handles stacking them
  async function getFullLayer(flavor: 'blob' | 'manifest', digest: string) {
    let firstErr: unknown;
    for (const store of opts.stores) {
      try {
        return await store.getFullLayer(flavor, digest);
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
        firstErr ??= err;
      }
    }
    throw firstErr ?? new Deno.errors.NotFound(
      `Local ${flavor} with digest ${digest} not found.`);
  }
  async function getLayerReader(flavor: 'blob' | 'manifest', digest: string) {
    let firstErr: unknown;
    for (const store of opts.stores) {
      try {
        return await store.getLayerReader(flavor, digest);
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
        firstErr ??= err;
      }
    }
    throw firstErr ?? new Deno.errors.NotFound(
      `Local ${flavor} with digest ${digest} not found.`);
  }


  let configBytes: Uint8Array;
  let manifestBytes: Uint8Array;
  let manifestData: ManifestV2 | ManifestOCI;

  if (opts.manifest.digest != null) {
    manifestBytes = await getFullLayer('manifest', opts.manifest.digest);
    manifestData = JSON.parse(new TextDecoder().decode(manifestBytes));
    configBytes = await getFullLayer('blob', manifestData.config.digest);

  } else {
    let configDesc: ManifestV2Descriptor;
    if (opts.manifest.config instanceof Uint8Array) {
      configBytes = opts.manifest.config;
      configDesc = {
        mediaType: "application/vnd.docker.container.image.v1+json",
        digest: `sha256:${await sha256bytesToHex(configBytes)}`,
        size: configBytes.byteLength,
      };
    } else {
      configDesc = opts.manifest.config;
      configBytes = await getFullLayer('blob', configDesc.digest);
    }

    manifestData = {
      schemaVersion: 2,
      mediaType: opts.format == 'docker'
        ? MEDIATYPE_MANIFEST_V2
        : MEDIATYPE_OCI_MANIFEST_V1,
      config: configDesc,
      layers: opts.manifest.layers,
    };
    manifestBytes = new TextEncoder().encode(stableJsonStringify(manifestData));
  }


  const tar = new Tar();

  if (opts.format === 'docker') {
    // TODO: consider that docker format probably can't store OCI artifacts (denodirs)

    const tarManifest = {
      Config: `${encodeDigest(manifestData.config.digest)}.json`,
      RepoTags: opts.fullRef ? [opts.fullRef] : [],
      Layers: new Array<string>(), // ['<sha256>.tar'],
    };

    tar.append(tarManifest.Config, tarBytes(configBytes));

    let parent: string | undefined = undefined;

    // Export each layer
    for (const layer of manifestData.layers) {
      const dirname = encodeDigest(layer.digest);
      const compressedSha256 = layer.digest.split(':')[1];

      tarManifest.Layers.push(dirname+'/layer.tar');
      tar.append(dirname+'/layer.tar', {
        reader: await getLayerReader('blob', layer.digest),
        contentSize: layer.size,
        mtime: 0,
        fileMode: 0o444,
      });
      tar.append(dirname+'/VERSION', tarBytes(new TextEncoder().encode('1.0')));
      tar.append(dirname+'/json', tarJson({
        id: compressedSha256,
        parent,
      }));

      parent = compressedSha256;
    }

    tar.append('manifest.json', tarJson([tarManifest]));
    if (opts.fullRef) {
      tar.append('repositories', tarJson({
        [opts.fullRef.split(':')[0]]: {
          [opts.fullRef.split(':')[1]]: parent,
        },
      }));
    }

    return tar;
  }

  if (opts.format === 'oci') {
    // TODO: find a way to verify OCI image layout archive

    const manifestDigest = await sha256bytesToHex(manifestBytes);

    tar.append('oci-layout', tarJson({
      "imageLayoutVersion": "1.0.0",
    }));

    const tarIndex: ManifestOCIIndex = {
      schemaVersion: 2,
      manifests: [{
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        size: manifestBytes.byteLength,
        digest: `sha256:${manifestDigest}`,
        // TODO: way to specify the platform
        // platform: {
        //   os: baseConfig.os,
        //   architecture: baseConfig.architecture,
        // },
        annotations: opts.fullRef ? {
          'org.opencontainers.image.ref.name': opts.fullRef,
        } : {},
      }],
    };
    tar.append('index.json', tarJson([tarIndex]));

    tar.append(`blobs/sha256/${manifestDigest}`, tarBytes(manifestBytes));

    // Config blob
    tar.append(`blobs/${encodeDigest(manifestData.config.digest)}`, tarBytes(configBytes));

    // Layer blobs
    for (const layer of manifestData.layers) {
      tar.append(`blobs/${encodeDigest(layer.digest)}`, {
        reader: await getLayerReader('blob', layer.digest),
        contentSize: layer.size,
        mtime: 0,
        fileMode: 0o444,
      });
    }

    // const newManifest: ManifestV2 = {
    //   ...baseManifest,
    //   layers: [
    //     ...baseManifest.layers,
    //     ...manifest.layers,
    //   ],
    //   config: {
    //     mediaType: baseManifest.config.mediaType,
    //     size: encodedConfig.byteLength,
    //     digest: `sha256:${configDigest}`,
    //   },
    // };
    // const encodedManifest = new TextEncoder().encode(JSON.stringify(newManifest));

    return tar;
  }

  throw new Error(`Unsupported export format ${opts.format}`);
}


function tarJson(data: unknown) {
  return tarBytes(new TextEncoder().encode(stableJsonStringify(data)));
}

function tarBytes(raw: Uint8Array) {
  return {
    reader: new Buffer(raw),
    contentSize: raw.byteLength,
    mtime: 0,
    fileMode: 0o444,
  };
}

function encodeDigest(digest: string) {
  return digest.replaceAll(':', '/');
}
