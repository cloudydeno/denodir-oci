import { defineCommand, oci } from "../../deps.ts";
import { die } from "../actions.ts";

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
    if (!flags.digest || !flags.destination) throw die
      `--digest and --reference are required`;
    if (!flags.digest.startsWith('sha256:')) throw die
      `--digest should be a sha256:... string`;

    await oci.pushFullArtifact(await oci.newLocalStore(), flags.digest, flags.destination);
  }});
