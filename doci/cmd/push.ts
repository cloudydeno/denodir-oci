import { defineCommand } from "../../deps.ts";
import * as OciStore from "../../lib/store.ts";
import { pushFullArtifact } from "../transfers.ts";

export const pushCommand = defineCommand({
  name: 'push',
  description: `Pushes a Denodir artifact to a remote registry`,
  args: {},
  flags: {
    digest: {
      typeFn: String,
    },
    destination: {
      typeFn: String,
      short: 'dest',
    },
  },
  async run(args, flags) {
    console.log('');
    if (!flags.digest || !flags.destination) throw '--digest and --reference are required';
    if (!flags.digest.startsWith('sha256:')) throw '--digest should be a sha256:... string';

    const store = await OciStore.local();

    await pushFullArtifact(store, flags.digest, flags.destination);
  }});
