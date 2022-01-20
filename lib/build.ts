import {
  ManifestOCIDescriptor,
  ManifestOCI,
  readAll,
  ModuleGraphJson,
  assertEquals,
  Tar,
  assert,
  copy,
  Buffer,
  path,
} from "../deps.ts";
import { OciStore } from "./store.ts";
import { sha256file, sha256string } from "./util/digest.ts";
import { gzipReaderToFile } from "./util/gzip.ts";
import { stableJsonStringify } from "./util/serialize.ts";

export class BuildContext {
  tempDir = Deno.makeTempDirSync({prefix: 'denodir-oci-build-'});
  layers = new Array<DociLayer>();

  config?: Record<string, unknown>;
  configBlob?: ManifestOCIDescriptor;

  manifest?: ManifestOCI;
  manifestBlob?: ManifestOCIDescriptor;

  async addLayer(specifier: string, opts: {
    baseSpecifier?: string;
    includeBuildInfo?: boolean;
  }) {
    this.layers.push(await buildDenodirLayer({
      specifier,
      dataPath: path.join(this.tempDir, `layer-${this.layers.length+1}.tar.gz`),
      baseLayer: this.layers.find(x => x.mainSpecifier == opts.baseSpecifier),
      includeBuildInfo: opts.includeBuildInfo,
    }));
  }

  async storeTo(store: OciStore) {
    if (this.layers.length < 1) throw new Error(
      `Need at least one layer to make a manifest`);
    if (this.layers.some(x => !x.descriptor?.digest)) throw new Error(
      `Every layer must have a descriptor + digest before building a manifest`);

    Object.freeze(this.layers);

    this.config = {
      builtWith: Deno.version,
      entrypoint: this.layers.slice(-1)[0]?.mainSpecifier,
    };
    const configData = stableJsonStringify(this.config);
    const configDigest = await sha256string(configData);
    this.configBlob = {
      digest: `sha256:${configDigest}`,
      size: configDigest.length, // TODO: byte length
      mediaType: "application/vnd.deno.denobox.config.v1+json",
    };

    this.manifest = {
      schemaVersion: 2,
      config: this.configBlob,
      layers: this.layers.map(x => x.descriptor!),
    };
    const manifestData = stableJsonStringify(this.manifest);
    const manifestDigest = await sha256string(manifestData);
    this.manifestBlob = {
      digest: `sha256:${manifestDigest}`,
      size: manifestDigest.length, // TODO: byte length
      mediaType: "application/vnd.oci.image.manifest.v1+json",
    };

    for (const layer of this.layers) {
      await store.putLayerFromFile('blob', layer.descriptor!, layer.dataPath);
    }
    await store.putLayerFromString('blob', this.configBlob, configData);
    await store.putLayerFromString('manifest', this.manifestBlob, manifestData);

    return this.manifestBlob.digest;
  }
}

export interface DociLayer {
  dataPath: string;
  buildInfoPath?: string;
  mainSpecifier: string;
  baseLayer?: DociLayer;
  storedSpecifiers: Set<string>;
  descriptor?: ManifestOCIDescriptor;
}

export async function buildDenodirLayer(opts: {
  specifier: string;
  dataPath: string;
  baseLayer?: DociLayer;
  includeBuildInfo?: boolean;
}) {

  const layer: DociLayer = {
    dataPath: opts.dataPath,
    // mediaType: 'application/vnd.deno.denodir.v1.tar+gzip',
    mainSpecifier: opts.specifier,
    baseLayer: opts.baseLayer,
    storedSpecifiers: new Set(opts.baseLayer?.storedSpecifiers),
  }

  const proc = Deno.run({
    cmd: ['deno', 'info', '--json', '--', opts.specifier],
    stdin: 'null',
    stdout: 'piped',
  });
  const raw = await readAll(proc.stdout);
  const status = await proc.status();
  if (!status.success) throw 'deno info failed';

  const data = JSON.parse(new TextDecoder().decode(raw)) as ModuleGraphJson;

  assertEquals(data.roots.length, 1);
  for (const module of data.modules) {
    if (!module.local) throw new Error(`Module ${module.specifier} not in local`);
    // TODO: is there a correct assert here? should we just not care about asserting this?
    if (module.mediaType == 'TypeScript') {
      if (!module.emit) throw new Error(`Module ${module.specifier} not in emit`);
    }
  }

  const firstEmitted = data.modules.find(x => x.emit);
  if (!firstEmitted?.emit) throw new Error(`No firstEmitted found`);
  const prefixLength = firstEmitted.emit.indexOf('/gen/') + 1;
  const prefix = firstEmitted.emit.slice(0, prefixLength);

  const tar = new Tar();

  for (const [fromUrl, toUrl] of Object.entries(data.redirects)) {
    if (!toUrl.startsWith('https://crux.land/api/get/')) continue;
    const url = new URL(toUrl);
    if (!url.pathname.includes('.')) continue;
    const midUrl = toUrl.replace(/\.[^.]+$/, '');
    data.redirects[fromUrl] = midUrl;
    data.redirects[midUrl] = toUrl;
  }

  // Need to explicitly capture redirections
  for (const [fromUrl, toUrl] of Object.entries(data.redirects)) {
    const url = new URL(fromUrl);
    const hashString = url.pathname + url.search;
    // TODO: nonstandard port is _PORT or something
    const cachePath = path.join(prefix, 'deps',
      url.protocol.replace(/:$/, ''),
      url.hostname,
      await sha256string(hashString));
    // console.log('redirect', fromUrl, 'to', cachePath)

    await tar.append('denodir/'+cachePath.slice(prefixLength), {
      filePath: cachePath,
      mtime: 0,
    });
    await tar.append('denodir/'+cachePath.slice(prefixLength)+'.metadata.json', {
      // filePath: cachePath+'.metadata.json',
      ...await cleanDepsMeta(cachePath+'.metadata.json'),
      mtime: 0,
    });

  }

  for (const module of data.modules.sort((a,b) => a.specifier.localeCompare(b.specifier))) {
    if (module.error) throw new Error(`${module.specifier}: ${module.error}`);
    if (layer.storedSpecifiers.has(module.specifier)) continue;
    layer.storedSpecifiers.add(module.specifier);
    // console.log(module.specifier, module.local, module.emit);

    if (!module.local) throw new Error(`Module ${module.specifier} not local`);
    if (module.local.startsWith(prefix)) {
      await tar.append('denodir/'+module.local.slice(prefixLength), {
        filePath: module.local,
        mtime: 0,
      });
      await tar.append('denodir/'+module.local.slice(prefixLength)+'.metadata.json', {
        // filePath: module.local+'.metadata.json',
        ...await cleanDepsMeta(module.local+'.metadata.json'),
        mtime: 0,
      });
    } else {
      // TODO: rewrite specifier to denodir path somehow
      // (potentially rewrite files into https://deno/ caches?)
      // I suppose import maps may save the day here, really
      console.log(`WARN: file:// modules aren't really supported yet`);
      await tar.append('denodir/deps/file/'+module.local.slice(1), {
        filePath: module.local,
        mtime: 0,
      });
    }

    // Only compiled artifacts have these
    if (module.emit) {
      assert(module.emit.startsWith(prefix));
      await tar.append('denodir/'+module.emit.slice(prefixLength), {
        filePath: module.emit,
        mtime: 0,
      });
      const metaPath = module.emit.replace(/\.[^.]+$/, '')+'.meta';
      await tar.append('denodir/'+metaPath.slice(prefixLength), {
        filePath: metaPath,
        mtime: 0,
      });

      if (opts.includeBuildInfo && data.roots.includes(data.redirects[module.specifier] ?? module.specifier)) {
        const buildInfoPath = module.emit.replace(/\.[^.]+$/, '.buildinfo');
        await tar.append('denodir/'+buildInfoPath.slice(prefixLength), {
          filePath: buildInfoPath,
          mtime: 0,
          // type: 'deno-gen',
        });
      }
    }
  }

  const compressedSize = await gzipReaderToFile(tar.getReader(), layer.dataPath);
  const shaSum = await sha256file(layer.dataPath);

  layer.descriptor = {
    digest: `sha256:${shaSum}`,
    mediaType: "application/vnd.deno.denodir.v1.tar+gzip",
    size: compressedSize,
    annotations: {
      specifier: opts.specifier,
    },
  };

  const rootModule = data.modules.find(x =>
    data.roots.includes(data.redirects[x.specifier] ?? x.specifier));
  if (!rootModule) throw new Error(`No root module found in graph`);
  layer.buildInfoPath = rootModule.emit?.replace(/\.[^.]+$/, '.buildinfo');

  return layer;
}

async function cleanDepsMeta(filePath: string) {
  const meta = JSON.parse(await Deno.readTextFile(filePath));

  delete meta.headers['date'];
  delete meta.headers['report-to'];
  delete meta.headers['expect-ct'];
  delete meta.headers['cf-ray'];
  delete meta.headers['x-amz-request-id'];
  delete meta.headers['x-amz-id-2'];
  if (meta.headers.server?.startsWith('deploy/')) {
    meta.headers.server = 'deploy/...';
  }

  delete meta.now;

  const cleanMeta = new TextEncoder().encode(stableJsonStringify(meta));
  return {
    reader: new Buffer(cleanMeta),
    contentSize: cleanMeta.byteLength,
  };
}
