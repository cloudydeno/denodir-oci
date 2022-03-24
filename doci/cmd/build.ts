import { defineCommand } from "../../deps.ts";
import * as OciStore from "../../lib/store.ts";
import { pushFullArtifact } from "../transfers.ts";
import { buildSimpleImage } from "../actions.ts";

export const buildCommand = defineCommand({
  name: 'build',
  description: `Builds a local OCI artifact containing a Deno module`,
  args: {
    specifiers: {
      nargs: '+',
    },
  },
  flags: {
    // ref: {
    //   typeFn: String,
    // },
    push: {
      typeFn: String,
      placeholder: 'reference',
      description: "Immediately upload the built artifact to a remote registry",
    },
    unstable: {
      typeFn: Boolean,
      description: "Pass --unstable when typechecking the module",
    },
    skipCheck: {
      typeFn: Boolean,
      description: "Pass --no-check when caching the module",
    },
  },
  async run(args, flags) {
    console.log('');

    const denoFlags = [
      ...(flags.unstable ? ['--unstable'] : []),
      ...(flags.skipCheck ? ['--no-check'] : []),
    ];

    const store = await OciStore.local();
    const mainSpecifier = args.specifiers.pop()!;

    const digest = await buildSimpleImage({
      store,
      cacheFlags: denoFlags,
      runtimeFlags: denoFlags,
      depSpecifiers: args.specifiers,
      mainSpecifier: mainSpecifier,
      localFileRoot: Deno.cwd(),
    });

    if (flags.push) {
      console.log('-->', 'Pushing built artifact to', flags.push, '...');
      await pushFullArtifact(store, digest, flags.push);
    }
  },
});
