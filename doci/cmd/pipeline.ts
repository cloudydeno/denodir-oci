import {
  defineCommand,
  parseYaml,
  path,
  oci,
} from "../../deps.ts";

import { buildSimpleImage, die, ejectArtifact, exportTarArchive } from "../actions.ts";

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
  importmap?: {
    imports: Record<string,string>;
  };
}

const commonFlags = {
  config: {
    typeFn: String,
    defaultV: Deno.env.get('DOCI_CONFIG_FILE') || 'doci.yaml',
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
      description: 'Select what is printed to stdout (options: "digest")',
    },
  },
  async run(args, flags) {
    const configText = await Deno.readTextFile(flags.config);
    const config = parseYaml(configText) as DociConfig;

    const finalDigest = await buildSimpleImage({
      store: await oci.newLocalStore(),
      cacheFlags: config.cacheFlags ?? [],
      runtimeFlags: config.runtimeFlags ?? [],
      depSpecifiers: config.dependencyLayers?.map(x => x.specifier) ?? [],
      mainSpecifier: config.entrypoint.specifier,
      localFileRoot: path.resolve(path.dirname(flags.config), config.localFileRoot ?? '.'),
      imports: config.importmap?.imports,
    });

    if (flags.output == 'digest') {
      console.log(finalDigest);
    }

    const fullPath = path.resolve(config.entrypoint.specifier);
    localStorage.setItem(`specifier_${fullPath}`, finalDigest);

    const githubOutput = Deno.env.get('GITHUB_OUTPUT');
    if (githubOutput) {
      const file = await Deno.open(githubOutput, {
        write: true,
        append: true,
      });
      const writer = file.writable.getWriter();
      await writer.write(new TextEncoder().encode(`digest=${finalDigest}`));
      writer.close();
      console.error(`Step output: digest=${finalDigest}`);
    }

  }});

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
    if (flags.output == '-' && Deno.stdout.isTerminal()) throw die
      `Refusing to write a tarball to a TTY, please redirect stdout`;

    const fullPath = path.resolve(config.entrypoint.specifier);
    const knownDigest = localStorage.getItem(`specifier_${fullPath}`);
    if (!knownDigest) throw die
      `No existing digest for ${fullPath} - did you not already build?`;
    console.error(`Using known digest`, knownDigest);

    await exportTarArchive({
      baseRef: target.baseRef ?? null,
      digest: knownDigest,
      format: flags.format,
      targetRef: target.ref,

      baseStore: await oci.newLocalStore('base-storage'),
      dociStore: await oci.newLocalStore(),
      stagingStore: oci.newInMemoryStore(),
      targetStream: flags.output == '-'
        ? Deno.stdout.writable
        : await Deno.open(flags.output, {
            write: true,
            truncate: true,
            create: true,
          }).then(x => x.writable),
    });
  }});

export const pushCommand = defineCommand({
  name: 'push',
  description: `Pushes a previously built artifact, optionally combined with a base image`,
  args: {
  },
  flags: {
    ...commonFlags,
    target: {
      short: 't',
      typeFn: String,
      description: `Use a named target from the project's configuration file`,
    },
    tag: {
      typeFn: String,
      description: `Provide a specific tag for the published image, such as a commit hash`,
    },
  },
  async run(args, flags) {
    const configText = await Deno.readTextFile(flags.config);
    const config = parseYaml(configText) as DociConfig;

    const fullPath = path.resolve(config.entrypoint.specifier);
    const knownDigest = localStorage.getItem(`specifier_${fullPath}`);
    if (!knownDigest) throw die
      `No digest found for ${fullPath}`;
    console.error(`Using known digest`, knownDigest);

    if (!flags.target) throw die
      `Please specify a target from config file ${flags.config}`;
    const target: DociConfigTarget | undefined = config.targets?.[flags.target ?? ''];
    if (!target) throw die
      `Target ${flags.target} not found in config file ${flags.config}`;

    if (!target.baseRef) {
      await oci.pushFullArtifact(await oci.newLocalStore(), knownDigest, target.ref, flags.tag);

    } else {
      const {ejected, store} = await ejectArtifact({
        baseRef: target.baseRef,
        digest: knownDigest,

        baseStore: await oci.newLocalStore('base-storage'),
        dociStore: await oci.newLocalStore(),
        stagingStore: oci.newInMemoryStore(),
      });

      await oci.pushFullArtifact(store, ejected.digest, target.ref, flags.tag);
    }
  }});

  export const pushAllCommand = defineCommand({
    name: 'push-all',
    description: `Pushes the same artifact from GHA to multiple places`,
    args: {
    },
    flags: {
      ...commonFlags,
    },
    async run(args, flags) {

      const params = {
        target: Deno.env.get('doci_target'),
        destinations: Deno.env.get('doci_destinations')?.split('\n') ?? [],
        labels: Deno.env.get('doci_labels')?.split('\n') ?? [],
        // or maybe .split(/\W+/)
      };
      console.error(`Pipeline inputs:`, params);

      const configText = await Deno.readTextFile(flags.config);
      const config = parseYaml(configText) as DociConfig;

      const fullPath = path.resolve(config.entrypoint.specifier);
      const knownDigest = localStorage.getItem(`specifier_${fullPath}`);
      if (!knownDigest) throw die
        `No digest found for ${fullPath}`;
      console.error(`Using known digest`, knownDigest);

      if (!params.target) throw die
        `Please specify a target from config file ${flags.config}`;
      const target: DociConfigTarget | undefined = config.targets?.[params.target ?? ''];
      if (!target) throw die
        `Target ${params.target} not found in config file ${flags.config}`;

      const localStore = await oci.newLocalStore('storage');
      let originStore: oci.OciStoreApi = localStore;
      let originDigest = knownDigest;

      // Perform an ejection if requested
      if (target.baseRef) {
        const {ejected, store} = await ejectArtifact({
          baseRef: target.baseRef,
          digest: knownDigest,

          baseStore: await oci.newLocalStore('base-storage'),
          dociStore: localStore,
          stagingStore: oci.newInMemoryStore(),
        });

        originStore = store;
        originDigest = ejected.digest;
      }

      const githubOutput = Deno.env.get('GITHUB_OUTPUT');
      if (githubOutput) {
        const file = await Deno.open(githubOutput, {
          write: true,
          append: true,
        });
        const writer = file.writable.getWriter();
        await writer.write(new TextEncoder().encode(`digest=${originDigest}`));
        writer.close();
        console.error(`Step output: digest=${originDigest}`);
      }

      for (const destination of params.destinations) {
        await oci.pushFullArtifact(originStore, originDigest, destination);
      }
    }});

export const pipelineCommand = defineCommand({
  name: 'pipeline',
  description: `Automates components of a CI/CD pipeline using a YAML config file`,
  flags: commonFlags,
  commands: [
    buildCommand,
    exportCommand,
    pushCommand,
    pushAllCommand,
  ],
});
