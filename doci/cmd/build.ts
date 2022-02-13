import { BuildContext } from "../../lib/build.ts";
import { defineCommand } from "../../deps.ts";
import * as OciStore from "../../lib/store.ts";
import { pushFullArtifact } from "../transfers.ts";

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
    const mainMod = args.specifiers.slice(-1)[0];

    const ctx = new BuildContext();

    // Cache and typecheck the module before we even consider emitting
    const cacheFlags = [
      ...(flags.unstable ? ['--unstable'] : []),
      ...(flags.skipCheck ? ['--no-check'] : []),
    ];
    await ctx.cacheSpecifier(mainMod, cacheFlags);

    const store = await OciStore.local();

    try {

      // Keep it simple - always stack the layers linearly
      let baseSpecifier: string | undefined = undefined;
      for (const specifier of args.specifiers) {
        console.log('-->', 'Packing', specifier, '...');
        await ctx.addLayer(specifier, {
          baseSpecifier,
          includeBuildInfo: specifier == mainMod && !flags.skipCheck,
        });
        baseSpecifier = specifier;
      }

      const finalDigest = await ctx.storeTo(store, {
        builtWith: Deno.version,
        entrypoint: ctx.layers.slice(-1)[0]?.mainSpecifier,
        runtimeFlags: cacheFlags,
      });
      console.log('==>', `Stored manifest`, finalDigest);

      if (flags.push) {
        console.log('-->', 'Pushing built artifact to', flags.push, '...');
        await pushFullArtifact(store, finalDigest, flags.push);
      }

    } finally {
      await Deno.remove(ctx.tempDir, { recursive: true });
    }

  },
});
