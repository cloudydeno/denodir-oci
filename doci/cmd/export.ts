// make a tarball for a built artifact
// https://github.com/opencontainers/image-spec/blob/main/image-layout.md

import { defineCommand, copy } from "../../deps.ts";
import { pullFullArtifact } from "../transfers.ts";
import { ejectToImage } from "../../lib/eject-to-image.ts";
import { exportArtifactAsArchive } from "../../lib/export-archive.ts";
import * as OciStore from "../../lib/store.ts";

export const exportCommand = defineCommand({
  name: 'export',
  description: `Exports a Denodir image as a loadable Docker archive`,
  args: {},
  flags: {
    digest: {
      typeFn: String,
    },
    base: {
      typeFn: String,
      defaultV: 'docker.io/denoland/deno:alpine-$DenoVersion',
      description: 'Stacks the DOCI artifact over an existing Docker image (presumably containing a Deno runtime) to create a normal runnable Docker image',
    },
    format: {
      typeFn: String,
      defaultV: 'docker',
      description: 'Either "docker" for a legacy archive or "oci" for the modern OCI Image Layout archive',
    },
    tag: {
      typeFn: String,
    },
  },
  async run(args, flags) {
    console.error('');

    if (!flags.digest)
      throw '--digest is required';
    if (!flags.digest.startsWith('sha256:'))
      throw '--digest should be a sha256:... string';
    if (flags.format !== 'docker' && flags.format !== 'oci')
      throw '--format needs to be "docker" or "oci"';

    // Pull base manifest
    // TODO: can skip pulling if we already have a version of the manifest (by digest?)
    const baseStore = await OciStore.local('base-storage');
    const baseId = await pullFullArtifact(baseStore,
      flags.base.replace('$DenoVersion', Deno.version.deno));

    // Inmemory store for the generated manifest
    const storeStack = OciStore.stack({
      writable: OciStore.inMemory(),
      readable: [
        await OciStore.local(),
        baseStore,
      ],
    });

    // TODO: export without ejecting (as OCI artifact format)
    const ejected = await ejectToImage({
      baseDigest: baseId.digest,
      dociDigest: flags.digest,
      store: storeStack,
    });

    console.error(`Exporting to archive...`, ejected.digest);

    const tar = await exportArtifactAsArchive({
      format: flags.format,
      manifestDigest: ejected.digest,
      store: storeStack,
      fullRef: flags.tag,
    });

    await copy(tar.getReader(), Deno.stdout);
  }});
