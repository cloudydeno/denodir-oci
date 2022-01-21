import { defineCommand } from "../../deps.ts";
import { OciStore } from "../../lib/store.ts";
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
    console.log('');
    // if (!flags.digest || !flags.destination) throw '--digest and --reference are required';
    // if (!flags.digest.startsWith('sha256:')) throw '--digest should be a sha256:... string';

    const store = new OciStore();
    await store.init();

    await pullFullArtifact(store, args.remote);
  }});
