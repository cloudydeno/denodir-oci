import { BuildContext } from "../../lib/build.ts";
import { defineCommand } from "../../deps.ts";
import { OciStore } from "../../lib/store.ts";

export const buildCommand = defineCommand({
  name: 'build',
  description: `Builds a local OCI artifact containing a Deno module`,
  args: {
    specifiers: {
      nargs: '+',
    },
  },
  flags: {
    ref: {
      typeFn: String,
    },
  },
  async run(args, flags) {
    console.log('');
    // console.log({args, flags});
    const mainMod = args.specifiers.slice(-1)[0];

    { // Cache and typecheck the module before we even consider building
      const proc = Deno.run({
        cmd: ['deno', 'cache', '--', mainMod],
        stdin: 'null',
      });

      const status = await proc.status();
      if (!status.success) throw 'deno cache fails';
    }

    const store = new OciStore();
    await store.init();

    const ctx = new BuildContext();
    // console.log(ctx.tempDir);
    try {

      // Keep it simple - always stack the layers linearly
      let baseSpecifier: string | undefined = undefined;
      for (const specifier of args.specifiers) {
        console.log('-->', 'Packing', specifier, '...');
        await ctx.addLayer(specifier, {
          baseSpecifier,
          includeBuildInfo: specifier == mainMod,
        });
        baseSpecifier = specifier;
      }

      // console.log(ctx.layers.map(x => ([x.dataPath, x.descriptor?.digest])));

      const finalDigest = await ctx.storeTo(store);
      console.log('==>', `Stored manifest`, finalDigest);

    } finally {
      await Deno.remove(ctx.tempDir, { recursive: true });
    }
  },
});
