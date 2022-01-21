import { assertEquals, ManifestOCIDescriptor, path, readableStreamFromReader } from "../deps.ts";
import { sha256bytesToHex } from "./util/digest.ts";

export class OciStore {
  public readonly rootPath = path.join(Deno.env.get('HOME') ?? '.', '.local', 'share', 'denodir-oci', 'storage');

  async init() {
    await Deno.mkdir(path.join(this.rootPath, 'blobs', 'sha256'), {recursive: true});
    await Deno.mkdir(path.join(this.rootPath, 'manifests', 'sha256'), {recursive: true});
    await Deno.mkdir(path.join(this.rootPath, 'references'), {recursive: true});
  }

  async putLayerFromFile(flavor: 'blob' | 'manifest', descriptor: ManifestOCIDescriptor, sourcePath: string) {
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

  async putLayerFromString(flavor: 'blob' | 'manifest', descriptor: Omit<ManifestOCIDescriptor, 'digest' | 'size'>, rawString: string): Promise<ManifestOCIDescriptor> {
    const rawData = new TextEncoder().encode(rawString);
    const size = rawData.byteLength;
    const digest = `sha256:${await sha256bytesToHex(rawData)}`;

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

  async getLayerStat(flavor: 'blob' | 'manifest', digest: string) {
    const [digestType, digestValue] = digest.split(':');
    const layerPath = path.join(this.rootPath, `${flavor}s`, digestType, digestValue);

    return await Deno.stat(layerPath)
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

}
