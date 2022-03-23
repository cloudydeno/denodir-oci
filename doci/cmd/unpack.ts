// explode the raw contents of a built artifact into (a temp directory?) for inspection/debugging

import { defineCommand, ManifestOCI, path } from "../../deps.ts";
import * as OciStore from "../../lib/store.ts";
import type { DenodirArtifactConfig } from "../../lib/types.ts";

export const unpackCommand = defineCommand({
  name: 'unpack',
  description: `Extract a denodir artifact into a local directory for inspection or debugging`,
  args: {},
  flags: {
    digest: {
      typeFn: String,
      placeholder: 'sha256:...',
      description: 'A locally stored digest to unpack.',
    },
    destination: {
      typeFn: String,
      short: 'dest',
      description: 'A path to unpack the resources to.',
    }
  },
  async run(args, flags) {
    console.error('');
    if (!flags.digest) throw '--digest is required for now';
    if (!flags.digest.startsWith('sha256:')) throw '--digest should be a sha256:... string';

    if (!flags.destination) throw '--destination is required and must exist';
    try {
      for await (const item of Deno.readDir(flags.destination)) {
        throw `The destination folder ${JSON.stringify(flags.destination)} is not empty, I saw ${JSON.stringify(item.name)}`;
      }
    } catch (err) {
      throw `The destination folder ${JSON.stringify(flags.destination)} could not be read: ${err.message}`;
    }

    const store = await OciStore.local();

    const manifestRaw = await store.getFullLayer('manifest', flags.digest);
    const manifest: ManifestOCI = JSON.parse(new TextDecoder().decode(manifestRaw));

    if (manifest.schemaVersion !== 2) throw new Error(
      `bad schemaversion ${manifest.schemaVersion}`);
    if (manifest.mediaType as string !== 'application/vnd.oci.image.manifest.v1+json') throw new Error(
      `bad mediatype ${JSON.stringify(manifest.mediaType)}`);

    const configDigest = manifest.config.digest;
    const configRaw = await store.getFullLayer('blob', configDigest);
    const configData: DenodirArtifactConfig = JSON.parse(new TextDecoder().decode(configRaw));

    const runtimeFlags = ['--cached-only'];
    if (configData.runtimeFlags?.includes?.('--unstable')) runtimeFlags.push('--unstable');
    if (configData.runtimeFlags?.includes?.('--no-check')) runtimeFlags.push('--no-check');

    const builtWithDeno = `${configData.builtWith?.deno ?? '0.0.0'}`.split('.');
    if (builtWithDeno.length !== 3) throw new Error(
      `Failed to read builtWith from ${JSON.stringify(configData)}`);
    const thisDeno = Deno.version.deno.split('.');
    if (thisDeno.length !== 3) throw new Error(
      `Failed to read local Deno version from ${JSON.stringify(Deno.version)}`);

    if (thisDeno[0] !== builtWithDeno[0]) throw new Error(
      `This artifact came from a different Deno major version: ${builtWithDeno.join('.')}`);
    if (parseInt(thisDeno[1], 10) < parseInt(builtWithDeno[1], 10)) console.error(
      `WARN: This artifact came from a newer Deno minor version: ${builtWithDeno.join('.')}`);

    for (const layer of manifest.layers) {
      if (layer.mediaType !== 'application/vnd.deno.denodir.v1.tar+gzip') {
        console.error(`WARN: skipping unexpected layer type "${layer.mediaType}"`);
      }
      console.error('Extracting layer', layer.digest, '...');
      await store.extractLayerLocally(layer, flags.destination);
      // console.error('Done with layer.', result);
    }

    const denoCmd = [`deno`, `run`, ...runtimeFlags, `--`, `${configData.entrypoint}`];
    console.error(`$ set -x DENO_DIR`, path.join(flags.destination, 'denodir'));
    console.error('$', denoCmd
      .map(x => /^[a-z0-9.-]+$/i.test(x) ? x : JSON.stringify(x))
      .join(' '));

  }});
