import {
  ManifestOCIDescriptor,
  ManifestOCI,
  ModuleGraphJson,
  assertEquals,
  Tar,
  Buffer,
  path,
  readableStreamFromReader,
  oci,
} from "../deps.ts";
import type { DenodirArtifactConfig } from "./types.ts";

export class BuildContext {
  tempDir = Deno.makeTempDirSync({prefix: 'denodir-oci-build-'});
  layers = new Array<DociLayer>();

  config?: DenodirArtifactConfig;
  configBlob?: ManifestOCIDescriptor;

  manifest?: ManifestOCI;
  manifestBlob?: ManifestOCIDescriptor;

  globalFlags = new Array<string>;
  cacheFlags = new Array<string>;
  infoFlags = new Array<string>;
  runFlags = new Array<string>;

  addImportmap(imports: Record<string,string>) {
    const importmap = {
      imports: Object.fromEntries(Object.entries(imports).map(([key, value]) => {
        if (value.startsWith('./')) {
          return [key, 'file://' + Deno.cwd() + value.slice(1)];
        }
        return [key, value];
      })),
    };
    this.globalFlags.push(`--importmap=data:application/importmap+json;base64,${btoa(JSON.stringify(importmap))}`);
  }

  async addLayer(specifier: string, opts: {
    baseSpecifier?: string;
    includeBuildInfo?: boolean;
    localFileRoot?: string;
    cacheFlags: string[];
  }) {

    const flags = [
      ...this.globalFlags,
      ...this.infoFlags,
      ...opts.cacheFlags.filter(x =>
        x.startsWith('--allow-import=')
        || x == '--allow-import'),
      ...opts.cacheFlags.filter(x =>
        x == '--unstable-sloppy-imports'),
    ];

    const layer = await buildDenodirLayer({
      specifier,
      dataPath: path.join(this.tempDir, `layer-${this.layers.length+1}.tar.gz`),
      baseLayer: this.layers.find(x => x.mainSpecifier == opts.baseSpecifier),
      includeBuildInfo: opts.includeBuildInfo,
      localFileRoot: opts.localFileRoot,
      denoFlags: flags,
    });
    this.layers.push(layer);
    return layer;
  }

  async storeTo(store: oci.OciStoreApi, config: DenodirArtifactConfig) {
    if (this.layers.length < 1) throw new Error(
      `Need at least one layer to make a manifest`);
    if (this.layers.some(x => !x.descriptor?.digest)) throw new Error(
      `Every layer must have a descriptor + digest before building a manifest`);

    Object.freeze(this.layers);

    for (const layer of this.layers) {
      await store.putLayerFromFile('blob', layer.descriptor!, layer.dataPath);
    }

    this.config = config;
    this.configBlob = await store.putLayerFromBytes('blob', {
      mediaType: "application/vnd.deno.denodir.config.v1+json",
    }, oci.stableJsonSerialize(this.config));

    this.manifest = {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: this.configBlob,
      layers: this.layers.map(x => x.descriptor!),
    };
    this.manifestBlob = await store.putLayerFromBytes('manifest', {
      mediaType: this.manifest.mediaType!,
    }, oci.stableJsonSerialize(this.manifest));

    return this.manifestBlob.digest;
  }

  /** Helper to run "deno cache" and make sure it succeeds */
  async cacheSpecifier(specifier: string, runtimeFlags?: string[]) {
    const allowImports = runtimeFlags?.filter(x =>
      x.startsWith('--allow-import=')
      || x == '--allow-import');
    const unstables = runtimeFlags?.filter(x =>
      x.startsWith('--unstable-')
      || x == '--unstable');
    const cacheFlags = [
      ...unstables ?? [],
      ...runtimeFlags?.includes('--no-check') ? ['--no-check'] : [], // TODO: deno 2 changed the default
      ...allowImports ?? [],
      ...this.globalFlags,
      ...this.cacheFlags,
    ];
    console.error('+', 'deno', 'cache', ...cacheFlags, '--', specifier);
    const proc = await new Deno.Command('deno', {
      args: ['cache', ...cacheFlags, '--', specifier],
      stdin: 'null',
      stdout: 'inherit',
      stderr: 'inherit',
    }).output();

    if (!proc.success) throw new Error(
      `"deno cache" failed, exit code ${proc.code}`);
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
  denoFlags: string[];
  dataPath: string;
  localFileRoot?: string;
  baseLayer?: DociLayer;
  includeBuildInfo?: boolean;
}) {
  if (opts.localFileRoot && !path.isAbsolute(opts.localFileRoot)) throw new Error(
    `When passed, localFileRoot needs to be an absolute path.`);

  console.error('+', 'deno', 'info', '--json', ...opts.denoFlags, '--', opts.specifier);
  const proc = await new Deno.Command('deno', {
    args: ['info', '--json', ...opts.denoFlags, '--', opts.specifier],
    stdin: 'null',
    stdout: 'piped',
    stderr: 'inherit',
  }).output();
  if (!proc.success) throw 'deno info failed';
  const raw = new TextDecoder().decode(proc.stdout);

  const data = JSON.parse(raw) as ModuleGraphJson;

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
    if (module.error) throw `Deno reported a module error: ${module.error}`;
    if (!module.local && !module.specifier.startsWith('node:')) throw new Error(
      `Module ${module.specifier} not in local`);
  }

  const firstLocal = data.modules.find(x => x.local?.includes('/remote/'));
  if (!firstLocal?.local) throw new Error(`No firstLocal found`);
  const prefixLength = firstLocal.local.indexOf('/remote/') + 1;
  const prefix = firstLocal.local.slice(0, prefixLength);

  const tar = new Tar();

  const addedPaths = new Set<string>;
  async function addFromUrl(rawUrl: string) {
    const url = new URL(rawUrl);
    const hashString = url.pathname + url.search;
    // TODO: nonstandard port is _PORT or something
    const cachePath = path.join(prefix, 'remote',
      url.protocol.replace(/:$/, ''),
      url.hostname,
      await oci.sha256string(hashString));
    // console.log('redirect', fromUrl, 'to', cachePath)

    if (addedPaths.has(cachePath)) return;
    addedPaths.add(cachePath);

    await tar.append('denodir/'+cachePath.slice(prefixLength), {
      filePath: cachePath,
      // ...await cleanDepsMeta(cachePath),
      // mtime: 0,
    });
  }

  // Need to explicitly capture redirections
  for (const [fromUrl, toUrl] of Object.entries(data.redirects)) {
    if (fromUrl.startsWith('jsr:')) {
      // JSR redirections go from the virtual protocol to https URLs
      // We need to cache the https URLs for the JSR metadata as well
      const [host, scope, name, version] = toUrl.split('/').slice(2);
      // https://jsr.io/docs/api
      await addFromUrl(`https://${host}/${scope}/${name}/meta.json`);
      await addFromUrl(`https://${host}/${scope}/${name}/${version}_meta.json`);
    } else {
      await addFromUrl(fromUrl);
    }
  }

  for (const module of data.modules.sort((a,b) => a.specifier.localeCompare(b.specifier))) {
    if (module.error) throw new Error(`${module.specifier}: ${module.error}`);
    if (module.specifier.startsWith('node:')) continue;

    if (layer.storedSpecifiers.has(module.specifier)) continue;
    layer.storedSpecifiers.add(module.specifier);
    // console.log(module.specifier, module.local, module.emit);

    let emitPathRemap: string | null = null;

    if (!module.local) throw new Error(`Module ${module.specifier} not local`);
    if (module.local.startsWith(prefix)) {
      // TODO: clean the metadata - the gen metadata is a set of complex deno hashes
      await tar.append('denodir/'+module.local.slice(prefixLength), {
        filePath: module.local,
        // ...await cleanDepsMeta(module.local),
        // mtime: 0,
      });
      if (module.mediaType == 'TypeScript') {
        const genSubpath = module.local.slice(prefixLength).replace(/^remote/, 'gen')+'.js';
        if (prefix+genSubpath == module.local) throw new Error(`failed to get gen path for ${genSubpath}`);
        await tar.append('denodir/'+genSubpath, {
          filePath: prefix+genSubpath,
          // ...await cleanDepsMeta(prefix+genSubpath),
          // mtime: 0,
        });
      }
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
        // mtime: 0,
      });

      emitPathRemap = newLoc.genPath;
    } else {
      throw new Error(`Don't know how to handle local side of module: ${module.specifier}`);
    }

    // Only compiled artifacts have these
    if (module.emit) {
      throw new Error(`TODO: what does module.emit mean in Deno 2?`);
      // assert(module.emit.startsWith(prefix));
      // const emitPath = emitPathRemap ?? `denodir/${module.emit.slice(prefixLength).replace(/\.[^.]+$/, '')}`;
      // const emitExt = path.extname(module.emit);

      // await tar.append(emitPath+emitExt, {
      //   filePath: module.emit,
      //   mtime: 0,
      // });
      // const metaPath = module.emit.replace(/\.[^.]+$/, '')+'.meta';
      // await tar.append(emitPath+'.meta', {
      //   filePath: metaPath,
      //   mtime: 0,
      // });
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
  let rawFile = await Deno.readFile(filePath);
  const lastNewline = rawFile.findLastIndex(value => value == 10);
  if (lastNewline > 0) {
    const rawLastLine = rawFile.slice(lastNewline);
    const sentinel = new TextEncoder().encode('// denoCacheMetadata=');
    if (rawLastLine.slice(1, sentinel.length+1).join(',') == sentinel.join(',')) {
      const rawMetadata = new TextDecoder().decode(rawLastLine.slice(sentinel.length+1));
      const cleanMetadata = cleanDepsMetaInner(rawMetadata);
      // Produce a new version of the file buffer
      const cleanFile = new Uint8Array(lastNewline+1+sentinel.length+cleanMetadata.length);
      cleanFile.set(rawFile.slice(0, lastNewline+1+sentinel.length), 0);
      cleanFile.set(cleanMetadata, lastNewline+1+sentinel.length);
      rawFile = cleanFile;
    }
  }
  return {
    reader: new Buffer(rawFile),
    contentSize: rawFile.byteLength,
  };
}

function cleanDepsMetaInner(metadata: string) {
  const meta = JSON.parse(metadata);

  delete meta.headers['date'];
  delete meta.headers['report-to'];
  delete meta.headers['expect-ct'];
  delete meta.headers['cf-ray'];
  delete meta.headers['x-amz-cf-id'];
  delete meta.headers['x-amz-request-id'];
  delete meta.headers['x-amz-id-2'];
  if (meta.headers.server?.startsWith('deploy/')) {
    meta.headers.server = 'deploy/...';
  }

  delete meta.time;

  return oci.stableJsonSerialize(meta);
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
  const uncompressedHashPromise = oci.sha256stream(rawLeft);
  const [compressedData, compressionStatsPromise] = oci.gzipStream(rawRight);

  const [gzipLeft, gzipRight] = compressedData.tee();
  const compressedHashPromise = oci.sha256stream(gzipLeft);
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
