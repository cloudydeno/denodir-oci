import { defineCommand, oci } from "../../deps.ts";

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
    await oci.pullFullArtifact(await oci.newLocalStore(), args.remote);
  }});
