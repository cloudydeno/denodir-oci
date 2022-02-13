// make a tarball for a built artifact
// https://github.com/opencontainers/image-spec/blob/main/image-layout.md

import { defineCommand, copy } from "../../deps.ts";
import { pullFullArtifact } from "../transfers.ts";
import { OciStore } from "../../lib/store.ts";
import { ejectToImage } from "../../lib/eject-to-image.ts";
import { exportArtifactAsArchive } from "../../lib/export-archive.ts";

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
      defaultV: 'docker.io/denoland/deno:latest',
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

    const baseStore = new OciStore('base-storage');
    await baseStore.init();

    const store = new OciStore();
    await store.init();

    // Pull base manifest
    // TODO: can skip if we already have a version of the manifest
    const baseId = await pullFullArtifact(baseStore, flags.base);

    // TODO: export without ejecting (as OCI artifact format)
    const ejected = await ejectToImage({
      baseDigest: baseId.digest,
      baseStore: baseStore,
      dociDigest: flags.digest,
      dociStore: store,
    });

    console.error(`Exporting to archive...`);

    const tar = await exportArtifactAsArchive({
      format: flags.format,
      manifest: ejected,
      stores: [baseStore, store],
      fullRef: flags.tag,
    });

    await copy(tar.getReader(), Deno.stdout);
  }});
