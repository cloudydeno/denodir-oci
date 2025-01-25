// make a tarball for a built artifact
// https://github.com/opencontainers/image-spec/blob/main/image-layout.md

import {
  Buffer,
  ManifestOCI,
  ManifestOCIIndex,
  ManifestV2,
  ManifestV2List,
  MEDIATYPE_MANIFEST_LIST_V2,
  MEDIATYPE_MANIFEST_V2,
  MEDIATYPE_OCI_MANIFEST_INDEX_V1,
  MEDIATYPE_OCI_MANIFEST_V1,
  readableStreamFromReader,
  readerFromIterable,
  Tar,
} from "../deps.ts";
import * as OciStore from "./store.ts";
import { sha256bytesToHex } from "./util/digest.ts";
import { stableJsonSerialize } from "./util/serialize.ts";

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
  manifestDigest: string;
  destination: WritableStream<Uint8Array>;
  store: OciStore.Api;
  fullRef?: string;
  format: 'docker' | 'oci';
}) {

  let configBytes: Uint8Array;
  let manifestBytes: Uint8Array;
  let manifestData: ManifestV2 | ManifestOCI | ManifestV2List | ManifestOCIIndex;

  manifestBytes = await opts.store.getFullLayer('manifest', opts.manifestDigest);
  manifestData = JSON.parse(new TextDecoder().decode(manifestBytes));

  // When given a multi-arch manifest, pick one to use
  if (manifestData.mediaType == MEDIATYPE_OCI_MANIFEST_INDEX_V1
    || manifestData.mediaType == MEDIATYPE_MANIFEST_LIST_V2) {

    const selectedManifest = manifestData.manifests.find(archManifest => {
      if (archManifest.platform?.os === 'unknown') return false;
      if (archManifest.platform?.architecture == 'arm64' && Deno.build.arch == 'aarch64') {
        return true;
      }
      if (archManifest.platform?.architecture == 'amd64' && Deno.build.arch == 'x86_64') {
        return true;
      }
    })

    if (!selectedManifest) throw new Error(`TODO: No suitable manifest found in multimanifest artifact`);

    return await exportArtifactAsArchive({
      ...opts,
      manifestDigest: selectedManifest.digest,
    });

  } else if (manifestData.mediaType !== MEDIATYPE_MANIFEST_V2
   && manifestData.mediaType !== MEDIATYPE_OCI_MANIFEST_V1) {
    throw new Error(`Base manifest at ${opts.manifestDigest} has unsupported mediaType`);
  }

  configBytes = await opts.store.getFullLayer('blob', manifestData.config.digest);

  const tar = new Tar();

  if (opts.format === 'docker') {
    // docker can't handle OCI artifacts (denodirs): "invalid image JSON, no RootFS key"
    if (manifestData.config.mediaType !== "application/vnd.oci.image.config.v1+json") {
      throw new Error(`docker cannot load non-image artifacts, either export to 'oci' format or eject the image first`);
    }

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
        reader: readerFromIterable(await opts.store.getLayerStream('blob', layer.digest)),
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

    await readableStreamFromReader(tar.getReader()).pipeTo(opts.destination);
    return;
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
        reader: readerFromIterable(await opts.store.getLayerStream('blob', layer.digest)),
        contentSize: layer.size,
        mtime: 0,
        fileMode: 0o444,
      });
    }

    await readableStreamFromReader(tar.getReader()).pipeTo(opts.destination);
    return;
  }

  throw new Error(`Unsupported export format ${opts.format}`);
}


function tarJson(data: unknown) {
  return tarBytes(stableJsonSerialize(data));
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
