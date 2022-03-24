import { defineCommand } from "../../deps.ts";
import * as OciStore from "../../lib/store.ts";
import { pullFullArtifact } from "../transfers.ts";

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
    await pullFullArtifact(await OciStore.local(), args.remote);
  }});
