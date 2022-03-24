import { ManifestOCI, ManifestOCIDescriptor, path } from "../deps.ts";

import { BuildContext, DociLayer } from "../lib/build.ts";
import * as OciStore from "../lib/store.ts";
import type { DenodirArtifactConfig } from "../lib/types.ts";
import { extractTarArchive } from "../lib/util/extract.ts";

export async function buildSimpleImage(opts: {
  store: OciStore.Api;
  depSpecifiers: string[];
  mainSpecifier: string;
  cacheFlags: string[];
  runtimeFlags: string[];
  localFileRoot: string;
}) {
  const ctx = new BuildContext();
  try {

    // Cache and typecheck the module before we even consider emitting
    await ctx.cacheSpecifier(opts.mainSpecifier, opts.cacheFlags);

    // Keep it simple - always stack the layers linearly
    let baseSpecifier: string | undefined = undefined;
    for (const specifier of opts.depSpecifiers) {
      console.error('-->', 'Packing', specifier, '...');
      const layer: DociLayer = await ctx.addLayer(specifier, {
        baseSpecifier,
        includeBuildInfo: false,
        localFileRoot: opts.localFileRoot,
      });
      baseSpecifier = layer.mainSpecifier;
    }

    console.error('-->', 'Packing', opts.mainSpecifier, '...');
    const mainLayer = await ctx.addLayer(opts.mainSpecifier, {
      baseSpecifier,
      includeBuildInfo: !opts.runtimeFlags?.includes('--no-check'),
      localFileRoot: opts.localFileRoot,
    });

    const finalDigest = await ctx.storeTo(opts.store, {
      builtWith: Deno.version,
      entrypoint: mainLayer.mainSpecifier,
      cacheFlags: opts.cacheFlags ?? [],
      runtimeFlags: opts.runtimeFlags ?? [],
    });

    console.error('==>', `Stored manifest`, finalDigest);
    return finalDigest;

  } finally {
    await Deno.remove(ctx.tempDir, { recursive: true });
  }
}

// TODO: refactor into a RunContext to enable piecemeal usage (extracting, etc)
export async function runArtifact(opts: {
  store: OciStore.Api;
  digest: string;
  runtimeFlags: string[];
  scriptFlags: string[];
  environmentVariables?: Record<string, string>;
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
  let status: Deno.ProcessStatus | null = null;
  try {

    for (const layer of manifest.layers) {
      if (layer.mediaType !== 'application/vnd.deno.denodir.v1.tar+gzip') {
        console.error(`WARN: skipping unexpected layer type "${layer.mediaType}"`);
      } else {
        console.error('Extracting layer', layer.digest, '...');
        await extractLayer(opts.store, layer, tempDir);
      }
    }

    const denoCmd = [
      Deno.execPath(),
      'run',
      '--cached-only',
      ...configData.runtimeFlags,
      ...opts.runtimeFlags,
      '--',
      configData.entrypoint,
      ...opts.scriptFlags,
    ];
    console.error('+', denoCmd
      .map(x => /^[a-z0-9._-]+$/i.test(x) ? x : JSON.stringify(x))
      .join(' '));
    const proc = Deno.run({
      cmd: denoCmd,
      env: {
        'DENO_DIR': path.join(tempDir, 'denodir'),
        ...(opts.environmentVariables ?? {}),
      },
    })

    // Wait for the child process to exit
    status = await proc.status();

  } finally {
    await Deno.remove(tempDir, {recursive: true});
  }

  if (status?.success == false) {
    Deno.exit(status.code);
  }
}

export async function extractLayer(store: OciStore.Api, layer: ManifestOCIDescriptor, destFolder: string) {
  if (!layer.mediaType.endsWith('.tar+gzip')) die
    `Cannot extract non-tarball layer ${layer.mediaType}`;

  const layerReader = await store.getLayerStream('blob', layer.digest);
  const unzippedStream = layerReader.pipeThrough(new DecompressionStream('gzip'));
  await extractTarArchive(unzippedStream, destFolder);
}

export function die(template: TemplateStringsArray, ...stuff: unknown[]) {
  console.error(`\ndoci:`, String.raw(template, ...stuff.map(x => JSON.stringify(x))), '\n');
  Deno.exit(1);
}
