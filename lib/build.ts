import {
  ManifestOCIDescriptor,
  ManifestOCI,
  readAll,
  ModuleGraphJson,
  assertEquals,
  Tar,
  assert,
  Buffer,
  path,
  readableStreamFromReader,
} from "../deps.ts";
import { OciStoreApi } from "./store/_api.ts";
import { sha256stream, sha256string } from "./util/digest.ts";
import { gzipStream } from "./util/gzip.ts";
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
    localFileRoot?: string;
  }) {
    const layer = await buildDenodirLayer({
      specifier,
      dataPath: path.join(this.tempDir, `layer-${this.layers.length+1}.tar.gz`),
      baseLayer: this.layers.find(x => x.mainSpecifier == opts.baseSpecifier),
      includeBuildInfo: opts.includeBuildInfo,
      localFileRoot: opts.localFileRoot,
    });
    this.layers.push(layer);
    return layer;
  }

  async storeTo(store: OciStoreApi, config: Record<string, unknown>) {
    if (this.layers.length < 1) throw new Error(
      `Need at least one layer to make a manifest`);
    if (this.layers.some(x => !x.descriptor?.digest)) throw new Error(
      `Every layer must have a descriptor + digest before building a manifest`);

    Object.freeze(this.layers);

    for (const layer of this.layers) {
      await store.putLayerFromFile('blob', layer.descriptor!, layer.dataPath);
    }

    this.config = config;
    this.configBlob = await store.putLayerFromString('blob', {
      mediaType: "application/vnd.deno.denodir.config.v1+json",
    }, stableJsonStringify(this.config));

    this.manifest = {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: this.configBlob,
      layers: this.layers.map(x => x.descriptor!),
    };
    this.manifestBlob = await store.putLayerFromString('manifest', {
      mediaType: this.manifest.mediaType!,
    }, stableJsonStringify(this.manifest));

    return this.manifestBlob.digest;
  }

  /** Helper to run "deno cache" and make sure it succeeds */
  async cacheSpecifier(specifier: string, runtimeFlags?: string[]) {
    const cacheFlags = [
      ...(runtimeFlags?.includes('--unstable') ? ['--unstable'] : []),
      ...(runtimeFlags?.includes('--no-check') ? ['--no-check'] : []),
    ];
    console.error('+', 'deno', 'cache', ...cacheFlags, '--', specifier);
    const proc = Deno.run({
      cmd: ['deno', 'cache', ...cacheFlags, '--', specifier],
      stdin: 'null',
    });

    const status = await proc.status();
    if (!status.success) throw new Error(
      `"deno cache" failed, exit code ${status.code}`);
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
  localFileRoot?: string;
  baseLayer?: DociLayer;
  includeBuildInfo?: boolean;
}) {
  if (opts.localFileRoot && !path.isAbsolute(opts.localFileRoot)) throw new Error(
    `When passed, localFileRoot needs to be an absolute path.`);

  console.error('+', 'deno', 'info', '--json', '--', opts.specifier);
  const proc = Deno.run({
    cmd: ['deno', 'info', '--json', '--', opts.specifier],
    stdin: 'null',
    stdout: 'piped',
  });
  const raw = await readAll(proc.stdout);
  const status = await proc.status();
  if (!status.success) throw 'deno info failed';

  const data = JSON.parse(new TextDecoder().decode(raw)) as ModuleGraphJson;

  const {localFileRoot} = opts;
  function rewriteFilePath(fileSpecifier: string, opts?: {
    targetDir?: 'deps' | 'gen';
    fileSuffix?: string;
  }) {
    if (!localFileRoot) throw new Error(
      `Need localFileRoot to process file:// modules`);
    const rootPath = path.fromFileUrl(fileSpecifier);
    if (!rootPath.startsWith(localFileRoot)) throw new Error(
      `Root specifier ${fileSpecifier} wasn't underneath localFileRoot ${localFileRoot}`);
    const subPath = path.relative(localFileRoot, rootPath);
    const newPath = path.join('denodir', opts?.targetDir || 'deps', 'file', subPath);
    // console.log({fileSpecifier, subPath, rootPath, newPath})
    // fileSpecifier =
    // console.log({fileSpecifier});
    return {
      virtualPath: newPath,
      virtualSpecifier: path.toFileUrl(path.parse(rootPath).root + newPath).toString(),
      genPath: 'denodir/gen/file/'+newPath,
    };
  }

  assertEquals(data.roots.length, 1);
  let rootSpecifier = data.roots[0];
  if (rootSpecifier.startsWith('file://')) {
    const newLoc = rewriteFilePath(rootSpecifier);
    rootSpecifier = newLoc.virtualSpecifier;
  }

  const layer: DociLayer = {
    dataPath: opts.dataPath,
    // mediaType: 'application/vnd.deno.denodir.v1.tar+gzip',
    // mainSpecifier: opts.specifier,
    mainSpecifier: rootSpecifier,
    baseLayer: opts.baseLayer,
    storedSpecifiers: new Set(opts.baseLayer?.storedSpecifiers),
  }

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

    let emitPathRemap: string | null = null;

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
    } else if (module.specifier.startsWith('file://')) {
      // Move file:// modules into /denodir/deps/file/
      // TODO: consider rewriting file://... modules underneath https://denodir/ ?

      // const rootPath = module.local.slice(1);
      // if (!opts.localFileRoot || !rootPath.startsWith(opts.localFileRoot)) throw new Error(
      //   `Dep specifier ${module.local} wasn't underneath localFileRoot ${opts.localFileRoot}`);
      // const subPath = path.relative(rootPath, rootSpecifier);
      // const newPath = path.join('denodir', 'deps', 'file', subPath);
      // console.log(module);
      const newLoc = rewriteFilePath(module.specifier);

      await tar.append(newLoc.virtualPath, {
        filePath: module.local,
        mtime: 0,
      });

      emitPathRemap = newLoc.genPath;
    } else {
      throw new Error(`Don't know how to handle local side of module: ${module.specifier}`);
    }

    // Only compiled artifacts have these
    if (module.emit) {
      assert(module.emit.startsWith(prefix));
      const emitPath = emitPathRemap ?? `denodir/${module.emit.slice(prefixLength).replace(/\.[^.]+$/, '')}`;
      const emitExt = path.extname(module.emit);

      await tar.append(emitPath+emitExt, {
        filePath: module.emit,
        mtime: 0,
      });
      const metaPath = module.emit.replace(/\.[^.]+$/, '')+'.meta';
      await tar.append(emitPath+'.meta', {
        filePath: metaPath,
        mtime: 0,
      });

      if (opts.includeBuildInfo && rootSpecifier == (data.redirects[module.specifier] ?? module.specifier)) {
        const buildInfoPath = module.emit.replace(/\.[^.]+$/, '.buildinfo');
        await tar.append(emitPath+'.buildinfo', {
          filePath: buildInfoPath,
          mtime: 0,
        });
      }
    }
  }

  const tarStream = readableStreamFromReader(tar.getReader());
  const targetFile = await Deno.open(layer.dataPath, {
    create: true,
    truncate: true,
    write: true,
  });

  const {
    uncompressedHash,
    compressedHash,
    compressionStats,
  } = await digestAndCompressAndDigestAndStore(tarStream, targetFile.writable);

  layer.descriptor = {
    digest: `sha256:${compressedHash}`,
    mediaType: "application/vnd.deno.denodir.v1.tar+gzip",
    size: compressionStats.compressedSize,
    annotations: {
      'specifier': rootSpecifier,
      'uncompressed-size': compressionStats.rawSize.toString(10),
      'uncompressed-digest': `sha256:${uncompressedHash}`,
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


/**
 * ```mermaid
 * graph TD
 *   TarArchive -->|sha256| RawDigest
 *   TarArchive -->|gzip| Compressed
 *   Compressed -->|sha256| GzipDigest
 *   Compressed --> Filesystem
 * ```
 * render @ https://mermaid.live
 */
 export async function digestAndCompressAndDigestAndStore(
  sourceData: ReadableStream<Uint8Array>,
  targetStream: WritableStream<Uint8Array>,
) {
  const [rawLeft, rawRight] = sourceData.tee();
  const uncompressedHashPromise = sha256stream(rawLeft);
  const [compressedData, compressionStatsPromise] = gzipStream(rawRight);

  const [gzipLeft, gzipRight] = compressedData.tee();
  const compressedHashPromise = sha256stream(gzipLeft);
  const storagePromise = gzipRight.pipeTo(targetStream);

  const [
    uncompressedHash,
    compressedHash,
    compressionStats,
  ] = await Promise.all([
    uncompressedHashPromise,
    compressedHashPromise,
    compressionStatsPromise,
    storagePromise,
  ]);

  return {
    uncompressedHash,
    compressedHash,
    compressionStats,
  };
}
