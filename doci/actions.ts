
import { exportArtifactAsArchive, extractTarArchive, newStackedStore, type OciStoreApi, pullFullArtifact, type StackedStore } from "@cloudydeno/oci-toolkit";
import { BuildContext, type DociLayer } from "../lib/build.ts";
import { ejectToImage } from "../lib/eject-to-image.ts";
import type { DenodirArtifactConfig } from "../lib/types.ts";
import { renderImportmapFlag } from "../lib/util/importmap.ts";
import { type ByteArray, type ManifestOCI, type ManifestOCIDescriptor, parseRepoAndRef } from "@cloudydeno/docker-registry-client";
import { join as joinPath } from "@std/path";

/**
 * Produces a denodir OCI artifact from the local system's Deno installation.
 * @returns OCI digest of the created Manifest, which has been saved to `opts.store`.
 */
export async function buildSimpleImage(opts: {
  store: OciStoreApi;
  depSpecifiers: string[];
  mainSpecifier: string;
  cacheFlags: string[];
  runtimeFlags: string[];
  localFileRoot: string;
  imports?: Record<string,string>;
}): Promise<string> {
  const ctx = new BuildContext();
  try {

    if (opts.imports) {
      ctx.addImportmap(opts.imports);
    }

    // Cache and typecheck the module before we even consider emitting
    await ctx.cacheSpecifier(opts.mainSpecifier, opts.cacheFlags);

    // Keep layering simple - always stack the layers linearly
    let baseSpecifier: string | undefined = undefined;
    for (const specifier of opts.depSpecifiers) {
      console.error('-->', 'Packing', specifier, '...');
      const layer: DociLayer = await ctx.addLayer(specifier, {
        baseSpecifier,
        includeBuildInfo: false,
        includeConfigFile: false,
        localFileRoot: opts.localFileRoot,
        cacheFlags: opts.cacheFlags,
      });
      baseSpecifier = layer.mainSpecifier;
    }

    // Add the entrypoint layer
    console.error('-->', 'Packing', opts.mainSpecifier, '...');
    const mainLayer = await ctx.addLayer(opts.mainSpecifier, {
      baseSpecifier,
      includeBuildInfo: !opts.runtimeFlags?.includes('--no-check'),
      includeConfigFile: true,
      localFileRoot: opts.localFileRoot,
      cacheFlags: opts.cacheFlags,
    });

    // TODO: allow for adding an assets layer based on fs globs?

    // Write out our artifact locally, including configuration
    const finalDigest = await ctx.storeTo(opts.store, {
      builtWith: Deno.version,
      entrypoint: mainLayer.mainSpecifier,
      cacheFlags: opts.cacheFlags ?? [],
      runtimeFlags: opts.runtimeFlags ?? [],
      importmap: opts.imports ? {imports: opts.imports} : undefined,
    });

    console.error('==>', `Stored manifest`, finalDigest);
    return finalDigest;

  } finally {
    await Deno.remove(ctx.tempDir, { recursive: true });
  }
}

// TODO: refactor into a RunContext to enable piecemeal usage (extracting, etc)
/**
 * Extracts a Denodir OCI artifact to a temporary directory and executes it as a subprocess.
 */
export async function runArtifact(opts: {
  store: OciStoreApi;
  digest: string;
  runtimeFlags: string[];
  scriptFlags: string[];
  environmentVariables?: Record<string, string>;
  signal?: AbortSignal;
}) {
  const manifestRaw = await opts.store.getFullLayer('manifest', opts.digest);
  const manifest: ManifestOCI = JSON.parse(new TextDecoder().decode(manifestRaw));

  if (manifest.schemaVersion !== 2) die
    `bad schemaversion ${manifest.schemaVersion}`;
  if (manifest.mediaType as string !== 'application/vnd.oci.image.manifest.v1+json') die
    `bad mediatype ${manifest.mediaType}`;

  const configDigest = manifest.config.digest;
  const configRaw = await opts.store.getFullLayer('blob', configDigest);
  const configData: DenodirArtifactConfig = JSON.parse(new TextDecoder().decode(configRaw));

  const builtWithDeno = `${configData.builtWith?.deno ?? '0.0.0'}`.split('.');
  if (builtWithDeno.length !== 3) die
    `Failed to read builtWith from ${configData}`;
  const thisDeno = Deno.version.deno.split('.');
  if (thisDeno.length !== 3) die
    `Failed to read local Deno version from ${Deno.version}`;

  if (thisDeno[0] !== builtWithDeno[0]) die
    `This artifact came from a different Deno major version: ${builtWithDeno.join('.')}`;
  if (parseInt(thisDeno[1], 10) < parseInt(builtWithDeno[1], 10)) console.error(
    `WARN: This artifact came from a newer Deno minor version: ${builtWithDeno.join('.')}`);

  const tempDir = await Deno.makeTempDir({prefix: 'denodir-run-'});
  // console.error({ tempDir });
  let exitCode = 0;
  try {

    for (const layer of manifest.layers) {
      if (layer.mediaType !== 'application/vnd.deno.denodir.v1.tar+gzip') {
        console.error(`WARN: skipping unexpected layer type "${layer.mediaType}"`);
      } else {
        console.error('Extracting layer', layer.digest, '...');
        await extractLayer(opts.store, layer, tempDir);
      }
    }

    let entrypoint = configData.entrypoint;
    if (entrypoint.startsWith('file:///denodir/')) {
      entrypoint = entrypoint.replace('file://', tempDir);
    }

    const runFlags = [
      ...configData.runtimeFlags,
      ...opts.runtimeFlags,
    ];
    if (configData.importmap) {
      runFlags.push(renderImportmapFlag(configData.importmap.imports));
    }

    const denoArgs = [
      'run',
      '--cached-only',
      ...runFlags,
      '--',
      entrypoint,
      ...opts.scriptFlags,
    ];

    console.error('+', 'deno', denoArgs
      .map(x => /^[-a-z0-9.,_=:\/]+$/i.test(x) ? x : JSON.stringify(x))
      .join(' '));

    // Wait for the child process to exit
    const proc = await new Deno.Command(Deno.execPath(), {
      args: denoArgs,
      env: {
        'DENO_DIR': joinPath(tempDir, 'denodir'),
        ...(opts.environmentVariables ?? {}),
      },
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      signal: opts.signal,
    }).output();

    exitCode = proc.code || 1;

  } finally {
    await Deno.remove(tempDir, {recursive: true});
  }

  if (exitCode) {
    Deno.exit(exitCode);
  }
}

/**
 * Produces a tar archive containing a Denodir OCI artifact.
 * When a base Docker image is provided, the Denodir is ejected/stacked
 *   onto the base image and a Docker archive is produced by default.
 *   The archive can be streamed into `docker load` as desired.
 * When there is no base image, the Denodir is exported as-is
 *   using a OCI Image Layout structure by default.
 * If a compressed archive is desired,
 *   use `.pipeTo(new CompressionStream('gzip'))`
 */
export async function exportTarArchive(opts: {
  dociStore: OciStoreApi;
  baseStore: OciStoreApi;
  stagingStore: OciStoreApi;
  digest: string;
  baseRef: string | null;
  targetRef: string;
  format: 'oci' | 'docker' | 'auto';
}): Promise<ReadableStream<ByteArray>> {

  if (!opts.baseRef) {
    console.error(`Exporting to archive...`, opts.digest);
    return await exportArtifactAsArchive({
      format: opts.format == 'auto' ? 'oci' : opts.format,
      manifestDigest: opts.digest,
      store: opts.dociStore,
      fullRef: opts.targetRef,
    });

  } else {
    const {ejected, store} = await ejectArtifact({
      ...opts,
      baseRef: opts.baseRef,
    });

    console.error(`Exporting to archive...`, ejected.digest);
    return await exportArtifactAsArchive({
      format: opts.format == 'auto' ? 'docker' : opts.format,
      manifestDigest: ejected.digest,
      store,
      fullRef: parseRepoAndRef(opts.targetRef).canonicalRef,
    });
  }
}

/**
 * Accepts a digest of a Denodir OCI artifact and a reference to a base image (a normal Deno image).
 * The Denodir blobs are stacked onto the base image, efficiently producing a combined image.
 * The resulting image can then be run normally by Docker and/or uploaded to a Docker registry.
 * @returns A descriptor of the newly created Docker image, and a store API to access it from.
 */
export async function ejectArtifact(opts: {
  dociStore: OciStoreApi;
  baseStore: OciStoreApi;
  stagingStore: OciStoreApi;
  digest: string;
  baseRef: string;
}): Promise<{
  ejected: ManifestOCIDescriptor;
  store: StackedStore;
}> {
  // Pull base manifest
  // TODO: can skip pulling if we already have a version of the manifest (by digest?)
  const baseImage = await pullFullArtifact(opts.baseStore,
    opts.baseRef.replace('$DenoVersion', Deno.version.deno.replace(/\+.+$/, '')));

  // Inmemory store for the generated manifest
  const storeStack = newStackedStore({
    writable: opts.stagingStore,
    readable: [
      opts.dociStore,
      opts.baseStore,
    ],
  });

  const annotations: Record<string, string> = {
    'org.opencontainers.image.created': new Date().toISOString(),
    'org.opencontainers.image.base.digest': baseImage.descriptor.digest,
    'org.opencontainers.image.base.name': baseImage.reference.canonicalRef,
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

  return {
    ejected: await ejectToImage({
      baseDigest: baseImage.descriptor.digest,
      dociDigest: opts.digest,
      store: storeStack,
      annotations,
    }),
    store: storeStack,
  };
}

/**
 * Extracts one OCI layer to a local folder.
 * @param store The store containing the blob.
 * @param layer Descriptor indicating which blob to extract.
 * @param destFolder Local path where the files should be written to.
 */
export async function extractLayer(store: OciStoreApi, layer: ManifestOCIDescriptor, destFolder: string) {
  if (!layer.mediaType.endsWith('.tar+gzip')) die
    `Cannot extract non-tarball layer ${layer.mediaType}`;

  const layerReader = await store.getLayerStream('blob', layer.digest);
  const unzippedStream = layerReader.pipeThrough(new DecompressionStream('gzip'));
  await extractTarArchive(unzippedStream, destFolder);
}

/** Internal function to produce user-friendly error messages at the CLI. */
export function die(template: TemplateStringsArray, ...stuff: unknown[]) {
  console.error(`\ndoci:`, String.raw(template, ...stuff.map(x => JSON.stringify(x))), '\n');
  Deno.exit(1);
}
