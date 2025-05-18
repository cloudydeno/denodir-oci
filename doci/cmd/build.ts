import { defineCommand } from "komando";
import { buildSimpleImage } from "../actions.ts";
import { newLocalStore, pushFullArtifact } from "@cloudydeno/oci-toolkit";

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

    // TODO: update flags for Deno 2
    const denoFlags = [
      ...(flags.unstable ? ['--unstable'] : []),
      ...(flags.skipCheck ? ['--no-check'] : []),
    ];

    const store = await newLocalStore();
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
