import { newLocalStore, pullFullArtifact } from "@cloudydeno/oci-toolkit";
import { defineCommand } from "komando";

export const pullCommand = defineCommand({
  name: 'pull',
  description: `Downloads a Denodir artifact from a remote registry`,
  args: {
    remote: {
      nargs: '1',
      description: "A remote artifact reference to download, with optional tag.",
    },
  },
  flags: {
  },
  async run(args, flags) {
    await pullFullArtifact(await newLocalStore(), args.remote);
  }});
