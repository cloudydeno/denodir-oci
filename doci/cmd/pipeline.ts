import { BuildContext, DociLayer } from "../../lib/build.ts";
import { defineCommand, Flags, parseYaml, path } from "../../deps.ts";
import { OciStore } from "../../lib/store.ts";
import { pushFullArtifact } from "../transfers.ts";

interface DociConfig {
  entrypoint: {
    specifier: string;
  };
  dependencyLayers?: Array<{
    specifier: string;
  }>;
  runtimeFlags?: Array<string>;
  ejections?: Record<string, {
    base: string;
  }>;
}

const commonFlags: Flags = {
  config: {
    typeFn: String,
    defaultV: 'doci.yaml',
    description: 'Path to a denodir-oci pipeline configuration file',
  },
};

export const buildCommand = defineCommand({
  name: 'build',
  description: `Builds a local OCI artifact containing a Deno module`,
  flags: { ...commonFlags },
  async run(args, flags) {
    const configText = await Deno.readTextFile(flags.config);
    const config = parseYaml(configText) as DociConfig;

    const ctx = new BuildContext();

    // Cache and typecheck the module before we even consider emitting
    await ctx.cacheSpecifier(config.entrypoint.specifier, config.runtimeFlags);

    const store = new OciStore();
    await store.init();

    try {
      // Keep it simple - always stack the layers linearly
      let baseSpecifier: string | undefined = undefined;
      for (const {specifier} of config.dependencyLayers ?? []) {
        console.log('-->', 'Packing', specifier, '...');
        const layer: DociLayer = await ctx.addLayer(specifier, {
          baseSpecifier,
          includeBuildInfo: false,
          localFileRoot: path.resolve(path.dirname(flags.config)),
        });
        baseSpecifier = layer.mainSpecifier;
      }

      const mainLayer = await ctx.addLayer(config.entrypoint.specifier, {
        baseSpecifier,
        includeBuildInfo: !config.runtimeFlags?.includes('--no-check'),
        localFileRoot: path.resolve(path.dirname(flags.config)),
      });

      const finalDigest = await ctx.storeTo(store, {
        builtWith: Deno.version,
        entrypoint: mainLayer.mainSpecifier,
        runtimeFlags: config.runtimeFlags,
      });
      console.log('==>', `Stored manifest`, finalDigest);

      const fullPath = path.resolve(config.entrypoint.specifier);
      localStorage.setItem(`specifier_${fullPath}`, finalDigest);

    } finally {
      await Deno.remove(ctx.tempDir, { recursive: true });
    }

  },
});

export const pipelineCommand = defineCommand({
  name: 'pipeline',
  description: `Automates components of a CI/CD pipeline using a YAML config file`,
  flags: commonFlags,
  commands: [
    buildCommand,
  ],
});
