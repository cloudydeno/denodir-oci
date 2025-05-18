import { defineCommand } from "komando";
import { newLocalStore } from "@cloudydeno/oci-toolkit";
import { addShutdownHandler, shutdownCtlr } from "@cloudydeno/bitesized/system/shutdown";

import { die, runArtifact } from "../actions.ts";

export const runCommand = defineCommand({
  name: 'run',
  description: `Launch a Denodir artifact locally`,
  args: {},
  flags: {
    digest: {
      typeFn: String,
      placeholder: 'sha256:...',
      description: 'A locally stored digest to execute.',
    },
  },
  async run(args, flags) {
    if (!flags.digest) throw die
      `--digest is required for now`;
    if (!flags.digest.startsWith('sha256:')) throw die
      `--digest should be a sha256:... string`;

    // Break apart the arguments
    const argsAll = [...args['--']];
    if (!argsAll.includes('--')) argsAll.push('--');
    const scriptFlags = argsAll.slice(argsAll.indexOf('--') + 1);
    const runtimeFlags = argsAll.slice(0, argsAll.indexOf('--'));

    addShutdownHandler();
    await runArtifact({
      store: await newLocalStore(),
      digest: flags.digest,
      runtimeFlags,
      scriptFlags,
      signal: shutdownCtlr.signal,
    });
  }});
