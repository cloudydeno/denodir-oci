import {
  defineCommand,
  parseRepoAndRef,
  parseYaml,
  path,
} from "../../deps.ts";

import * as OciStore from "../../lib/store.ts";
import { pushFullArtifact } from "../transfers.ts";
import { ejectToImage } from "../../lib/eject-to-image.ts";
import { buildSimpleImage, die, exportTarArchive } from "../actions.ts";

interface DociConfigLayer {
  specifier: string;
}
interface DociConfigTarget {
  ref: string;
  baseRef?: string;
}
interface DociConfig {
  localFileRoot?: string;
  entrypoint: DociConfigLayer;
  dependencyLayers?: Array<DociConfigLayer>;
  cacheFlags?: Array<string>;
  runtimeFlags?: Array<string>;
  ejections?: Record<string, {
    base: string;
  }>;
  targets?: Record<string, DociConfigTarget>;
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
  flags: {
    ...commonFlags,
    output: {
      short: 'o',
      typeFn: String,
      description: 'Select what is printed to stdout (options: "output")',
    },
  },
  async run(args, flags) {
    const configText = await Deno.readTextFile(flags.config);
    const config = parseYaml(configText) as DociConfig;

    const finalDigest = await buildSimpleImage({
      store: await OciStore.local(),
      cacheFlags: config.cacheFlags ?? [],
      runtimeFlags: config.runtimeFlags ?? [],
      depSpecifiers: config.dependencyLayers?.map(x => x.specifier) ?? [],
      mainSpecifier: config.entrypoint.specifier,
      localFileRoot: path.resolve(path.dirname(flags.config), config.localFileRoot ?? '.'),
    });

    if (flags.output == 'digest') {
      console.log(finalDigest);
    }

    const fullPath = path.resolve(config.entrypoint.specifier);
    localStorage.setItem(`specifier_${fullPath}`, finalDigest);
  },
});

export const exportCommand = defineCommand({
  name: 'export',
  description: `Saves an image as a tar archive, for loading into e.g. Podman or Docker`,
  flags: {
    ...commonFlags,
    target: {
      short: 't',
      typeFn: String,
      description: `Use a named target from the project's configuration file`,
    },
    output: {
      short: 'o',
      typeFn: String,
      default: '-',
      description: `Optionally a path on the filesystem to save the tar archive to`,
    },
    format: {
      typeFn: String,
      defaultV: 'auto',
      description: 'Set either "docker" for a legacy archive or "oci" for the modern OCI Image Layout archive. Left alone, "auto" will use "oci" for raw artifacts and "docker" for runnable images',
    },
  },
  async run(args, flags) {
    const configText = await Deno.readTextFile(flags.config);
    const config = parseYaml(configText) as DociConfig;

    const target: DociConfigTarget | undefined = flags.target
      ? config.targets?.[flags.target]
      : { ref: 'deno.dir/pipeline' };
    if (!target) throw die
      `Target ${flags.target} not found in config file ${flags.config}`;

    if (flags.format !== 'docker' && flags.format !== 'oci' && flags.format !== 'auto') throw die
      `--format needs to be "docker" or "oci" or "auto", not ${flags.format}`;

    flags.output ??= '-';
    if (flags.output == '-' && Deno.isatty(Deno.stdout.rid)) die
      `Refusing to write a tarball to a TTY, please redirect stdout`;

    const fullPath = path.resolve(config.entrypoint.specifier);
    const knownDigest = localStorage.getItem(`specifier_${fullPath}`);
    if (!knownDigest) return die
      `No existing digest for ${fullPath} - did you not already build?`;
    console.error(`Using known digest`, knownDigest);

    await exportTarArchive({
      baseRef: target.baseRef ?? null,
      digest: knownDigest,
      format: flags.format,
      targetRef: target.ref,

      baseStore: await OciStore.local('base-storage'),
      dociStore: await OciStore.local(),
      stagingStore: OciStore.inMemory(),
      targetStream: flags.output == '-'
        ? Deno.stdout.writable
        : await Deno.open(flags.output, {
            write: true,
            truncate: true,
            create: true,
          }).then(x => x.writable),
    });
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
    var rar = parseRepoAndRef(ejectBase.base.replace('$DenoVersion', Deno.version.deno));
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
    exportCommand,
    pushCommand,
  ],
});
