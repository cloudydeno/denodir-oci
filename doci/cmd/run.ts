import { assertEquals, copy, defineCommand, ManifestOCI, path, Untar } from "../../deps.ts";
import * as OciStore from "../../lib/store.ts";

export const runCommand = defineCommand({
  name: 'run',
  description: `Launch a Denodir artifact locally`,
  args: {},
  flags: {
    digest: {
      typeFn: String,
      placeholder: 'sha256:...',
      description: 'A locally stored digest to execute.',
    },
    // remote: {
    //   typeFn: String,
    //   placeholder: 'reference',
    //   description: 'A registry reference to pull (if needed) and then execute.',
    // },
    // local: {
    //   typeFn: String,
    //   placeholder: 'reference',
    //   description: 'A reference to an artifact already built on or pulled to your local machine.',
    // },
  },
  async run(args, flags) {
    console.error('');
    // if (!flags.digest && !flags.pull) throw 'One of --digest or --remote or --local are required';
    if (!flags.digest) throw '--digest is required for now';
    if (!flags.digest.startsWith('sha256:')) throw '--digest should be a sha256:... string';

    const digest = flags.digest;

    const store = await OciStore.local();

    const manifestRaw = await store.getFullLayer('manifest', digest);
    const manifest: ManifestOCI = JSON.parse(new TextDecoder().decode(manifestRaw));

    if (manifest.schemaVersion !== 2) throw new Error(
      `bad schemaversion ${manifest.schemaVersion}`);
    if (manifest.mediaType as string !== 'application/vnd.oci.image.manifest.v1+json') throw new Error(
      `bad mediatype ${JSON.stringify(manifest.mediaType)}`);

    const configDigest = manifest.config.digest;
    const configRaw = await store.getFullLayer('blob', configDigest);
    const configData = JSON.parse(new TextDecoder().decode(configRaw));

    const runtimeFlags = ['--cached-only'];
    if (configData.cacheFlags?.includes?.('--unstable')) runtimeFlags.push('--unstable');
    if (configData.cacheFlags?.includes?.('--no-check')) runtimeFlags.push('--no-check');

    const argsAll = [...args['--']];
    if (!argsAll.includes('--')) argsAll.push('--');
    const scriptFlags = argsAll.slice(argsAll.indexOf('--') + 1);
    for (const arg of argsAll.slice(0, argsAll.indexOf('--'))) {
      runtimeFlags.push(arg);
    }

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

    const tempDir = await Deno.makeTempDir({prefix: 'denobox-run-'});
    // console.error({ tempDir });

    for (const layer of manifest.layers) {
      if (layer.mediaType !== 'application/vnd.deno.denodir.v1.tar+gzip') {
        console.error(`WARN: skipping unexpected layer type "${layer.mediaType}"`);
      }
      console.error('Extracting layer', layer.digest, '...');
      await store.extractLayerLocally(layer, tempDir);
      // console.error('Done with layer.', result);
    }

    const denoCmd = [`deno`, `run`, ...runtimeFlags, `--`, `${configData.entrypoint}`, ...scriptFlags];
    console.error('$', denoCmd
      .map(x => /^[a-z0-9.-]+$/i.test(x) ? x : JSON.stringify(x))
      .join(' '));
    const proc = Deno.run({
      cmd: denoCmd,
      env: {
        'DENO_DIR': path.join(tempDir, 'denodir'),
      },
    })

    const status = await proc.status();

    await Deno.remove(tempDir, {recursive: true});

    if (!status.success) {
      Deno.exit(status.code);
    }

  }});
