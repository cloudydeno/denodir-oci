import {
  defineCommand,
  parseRepoAndRef,
  parseYaml,
  path,
} from "../../deps.ts";

import { BuildContext, DociLayer } from "../../lib/build.ts";
import * as OciStore from "../../lib/store.ts";
import { pushFullArtifact } from "../transfers.ts";
import { ejectToImage } from "../../lib/eject-to-image.ts";

interface DociConfig {
  entrypoint: {
    specifier: string;
  };
  dependencyLayers?: Array<{
    specifier: string;
  }>;
  cacheFlags?: Array<string>;
  runtimeFlags?: Array<string>;
  ejections?: Record<string, {
    base: string;
  }>;
}

const commonFlags = {
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
    await ctx.cacheSpecifier(config.entrypoint.specifier, config.cacheFlags);

    const store = await OciStore.local();

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

      console.log('-->', 'Packing', config.entrypoint.specifier, '...');
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

export const pushCommand = defineCommand({
  name: 'push',
  description: `Pushes a previously built artifact, optionally combined with a base image`,
  args: {
    target: {
      nargs: '1',
      description: `A registry to push the image to.`,
    },
  },
  flags: {
    ...commonFlags,
    eject: {
      typeFn: String,
    },
  },
  async run(args, flags) {
    const configText = await Deno.readTextFile(flags.config);
    const config = parseYaml(configText) as DociConfig;

    const fullPath = path.resolve(config.entrypoint.specifier);
    const knownDigest = localStorage.getItem(`specifier_${fullPath}`);
    if (!knownDigest) throw `No digest found for ${JSON.stringify(fullPath)}`;
    console.error(`Using known digest`, knownDigest);

    const store = await OciStore.local();

    if (!flags.eject) {
      await pushFullArtifact(store, knownDigest, args.target);
      return;
    }

    const ejectBase = config.ejections?.[flags.eject];
    if (!ejectBase) throw `No ejection config found for ${flags.eject}`;
    var rar = parseRepoAndRef(ejectBase.base);
    const ref = rar.tag ?? rar.digest;
    if (!ref) throw 'No base tag or digest found';

    const baseStore = await OciStore.registry(rar, ['pull']);

    // TODO: only needs to resolve ref to digest (with HEAD)
    const {manifest, resp: manifestResp} = await baseStore.api.getManifest({
      ref,
      acceptOCIManifests: true,
      acceptManifestLists: true,
    });

    const manifestDigest = manifestResp.headers.get('docker-content-digest');
    if (!manifestDigest) throw new Error(`No digest returned on manifest fetch`);

    // Inmemory store for the generated manifest
    const storeStack = OciStore.stack({
      writable: OciStore.inMemory(),
      readable: [
        await OciStore.local(),
        baseStore,
      ],
    });

    const annotations: Record<string, string> = {
      'org.opencontainers.image.created': new Date().toISOString(),
      'org.opencontainers.image.base.digest': manifestDigest,
      'org.opencontainers.image.base.name': rar.canonicalName ?? '',
    };
    {
      const gitSha = Deno.env.get('GITHUB_SHA');
      if (gitSha) {
        annotations['org.opencontainers.image.revision'] = gitSha;
      }
      const gitServer = Deno.env.get('GITHUB_SERVER_URL');
      const gitRepo = Deno.env.get('GITHUB_REPOSITORY');
      if (gitServer && gitRepo) {
        annotations['org.opencontainers.image.source'] = `${gitServer}/${gitRepo}`;
      }
    }

    const ejected = await ejectToImage({
      baseDigest: manifestDigest,
      dociDigest: knownDigest,
      store: storeStack,
      annotations,
    });

    await pushFullArtifact(storeStack, ejected.digest, args.target);
  },
});

export const pipelineCommand = defineCommand({
  name: 'pipeline',
  description: `Automates components of a CI/CD pipeline using a YAML config file`,
  flags: commonFlags,
  commands: [
    buildCommand,
    pushCommand,
  ],
});
