import {
  assertEquals,
  copy,
  ManifestOCIDescriptor,
  path,
  readableStreamFromReader,
  Untar,
  writeAll,
} from "../deps.ts";
import { sha256bytesToHex } from "./util/digest.ts";

export class OciStore {
  constructor(
    readonly identifier = 'storage',
  ) {
    this.rootPath = path.join(
      Deno.env.get('HOME') ?? '.',
      '.local', 'share', 'denodir-oci',
      this.identifier);
  }
  public readonly rootPath: string;

  async init() {
    await Deno.mkdir(path.join(this.rootPath, 'blobs', 'sha256'), {recursive: true});
    await Deno.mkdir(path.join(this.rootPath, 'manifests', 'sha256'), {recursive: true});
    // await Deno.mkdir(path.join(this.rootPath, 'references'), {recursive: true});
  }

  async putLayerFromFile(
    flavor: 'blob' | 'manifest',
    descriptor: ManifestOCIDescriptor,
    sourcePath: string,
  ) {
    const [digestType, digestValue] = descriptor.digest.split(':');
    const layerPath = path.join(this.rootPath, `${flavor}s`, digestType, digestValue);
    const layerStat = await Deno.stat(layerPath)
      .catch(err => err instanceof Deno.errors.NotFound ? null : Promise.reject(err));

    if (!layerStat) {
      await Deno.copyFile(sourcePath, layerPath);
    } else if (layerStat.size !== descriptor.size) {
      throw new Error(`Digest ${descriptor.digest} clashed (size: ${layerStat.size} vs ${descriptor.size}). This isn't supposed to happen`);
    }

    return descriptor;
  }

  async putLayerFromStream(
    flavor: 'blob' | 'manifest',
    descriptor: ManifestOCIDescriptor,
    stream: ReadableStream<Uint8Array>,
  ) {
    const [digestType, digestValue] = descriptor.digest.split(':');
    const layerPath = path.join(this.rootPath, `${flavor}s`, digestType, digestValue);

    const target = await Deno.open(layerPath, {
      write: true, truncate: true, create: true,
    });
    for await (const chunk of stream) {
      await writeAll(target, chunk);
    }
    target.close();

    return descriptor;
  }

  async putLayerFromString(
    flavor: 'blob' | 'manifest',
    descriptor: Omit<ManifestOCIDescriptor, 'digest' | 'size'> & { digest?: string },
    rawString: string
  ): Promise<ManifestOCIDescriptor> {
    const rawData = new TextEncoder().encode(rawString);
    return await this.putLayerFromBytes(flavor, descriptor, rawData);
  }

  async putLayerFromBytes(
    flavor: 'blob' | 'manifest',
    descriptor: Omit<ManifestOCIDescriptor, 'digest' | 'size'> & { digest?: string },
    rawData: Uint8Array
  ): Promise<ManifestOCIDescriptor> {
    const size = rawData.byteLength;
    const digest = `sha256:${await sha256bytesToHex(rawData)}`;

    if (descriptor.digest) {
      assertEquals(digest, descriptor.digest);
    }

    const [digestType, digestValue] = digest.split(':');
    const layerPath = path.join(this.rootPath, `${flavor}s`, digestType, digestValue);
    const layerStat = await Deno.stat(layerPath)
      .catch(err => err instanceof Deno.errors.NotFound ? null : Promise.reject(err));

    if (!layerStat) {
      await Deno.writeFile(layerPath, rawData);
    } else if (layerStat.size !== size) {
      throw new Error(`Digest ${digest} clashed (size: ${layerStat.size} vs ${size}). This isn't supposed to happen`);
    }

    return {
      ...descriptor,
      digest, size,
    }
  }

  async statLayer(flavor: 'blob' | 'manifest', digest: string) {
    const [digestType, digestValue] = digest.split(':');
    const layerPath = path.join(this.rootPath, `${flavor}s`, digestType, digestValue);

    return await Deno.stat(layerPath)
      .catch(err => err instanceof Deno.errors.NotFound ? null : Promise.reject(err));
  }

  async getFullLayer(flavor: 'blob' | 'manifest', digest: string) {
    const [digestType, digestValue] = digest.split(':');
    assertEquals(digestType, 'sha256');
    const layerPath = path.join(this.rootPath, `${flavor}s`, digestType, digestValue);

    return await Deno.readFile(layerPath)
      .catch(cause => {
        if (cause instanceof Deno.errors.NotFound) throw new Deno.errors.NotFound(
          `Local ${flavor} with digest ${digest} not found.`, { cause });
        throw cause;
      });
  }

  async getLayerReader(flavor: 'blob' | 'manifest', digest: string) {
    const [digestType, digestValue] = digest.split(':');
    const layerPath = path.join(this.rootPath, `${flavor}s`, digestType, digestValue);

    return await Deno.open(layerPath, {read: true})
      .catch(cause => {
        if (cause instanceof Deno.errors.NotFound) throw new Deno.errors.NotFound(
          `Local ${flavor} with digest ${digest} not found.`, { cause });
        throw cause;
      });
  }

  async getLayerStream(flavor: 'blob' | 'manifest', digest: string) {
    return readableStreamFromReader(await this.getLayerReader(flavor, digest));
  }

  // Is this the best location for this logic?
  async extractLayerLocally(layer: ManifestOCIDescriptor, destFolder: string) {
    if (!layer.mediaType.endsWith('.tar+gzip')) throw new Error(
      `Cannot extract non-tarball layer "${layer.mediaType}"`);

    const layerReader = await this.getLayerReader('blob', layer.digest);

    const gunzip = Deno.run({
      cmd: ['gzip', '--decompress'],
      stdin: 'piped',
      stdout: 'piped',
    });

    const toGunzipPromise = copy(layerReader, gunzip.stdin)
      .then(size => (gunzip.stdin.close(), size));

    const untar = new Untar(gunzip.stdout);

    let fileCount = 0;
    let fileSize = 0;
    let madeDirs = new Set<string>();
    for await (const entry of untar) {
      // console.error(entry.fileName, entry.fileSize);
      const fullPath = path.join(destFolder, entry.fileName);

      const dirname = path.dirname(fullPath);
      if (!madeDirs.has(dirname)) {
        await Deno.mkdir(dirname, { recursive: true });
        madeDirs.add(dirname);
      }

      const target = await Deno.open(fullPath, {
        write: true, truncate: true, create: true,
      });
      fileSize += await copy(entry, target);
      target.close();
      fileCount++;
    }

    return {
      compressedSize: await toGunzipPromise,
      fileCount,
      fileSize,
    };
  }
}
