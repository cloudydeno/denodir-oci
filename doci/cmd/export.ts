import { defineCommand } from "komando";
import { die, exportTarArchive } from "../actions.ts";
import { newInMemoryStore, newLocalStore } from "@cloudydeno/oci-toolkit";

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
      defaultV: 'auto',
      description: 'Either "docker" for a legacy archive or "oci" for the modern OCI Image Layout archive',
    },
    tag: {
      typeFn: String,
      defaultV: 'deno.dir/export',
    },
  },
  async run(args, flags) {
    if (!flags.digest?.startsWith('sha256:')) throw die
      `--digest should be a sha256:... string`;
    if (flags.format !== 'docker' && flags.format !== 'oci' && flags.format !== 'auto') throw die
      `--format needs to be "docker" or "oci" or "auto", not ${flags.format}`;

    if (Deno.stdout.isTerminal()) throw die
      `Refusing to write a tarball to a TTY, please redirect stdout`;

    const tarStream = await exportTarArchive({
      baseRef: flags.base,
      digest: flags.digest,
      format: flags.format,
      targetRef: flags.tag,

      baseStore: await newLocalStore('base-storage'),
      dociStore: await newLocalStore(),
      stagingStore: newInMemoryStore(),
    });
    await tarStream.pipeTo(Deno.stdout.writable);
  }});
