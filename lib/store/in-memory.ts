import {
  ManifestOCIDescriptor,
  StreamBuffer,
  assertEquals,
} from "../../deps.ts";
import { OciStoreApi } from "./_api.ts";
import { sha256bytesToHex } from "../util/digest.ts";

export class OciStoreInmem implements OciStoreApi {
  protected readonly storage = {
    blob: new Map<string, Uint8Array>(),
    manifest: new Map<string, Uint8Array>(),
  };

  putLayerFromFile(flavor: "blob" | "manifest", descriptor: ManifestOCIDescriptor, sourcePath: string): Promise<ManifestOCIDescriptor> {
    throw new Error("Method not implemented.");
  }
  async putLayerFromStream(flavor: "blob" | "manifest", descriptor: ManifestOCIDescriptor, stream: ReadableStream<Uint8Array>): Promise<ManifestOCIDescriptor> {
    return await this.putLayerFromBytes(flavor, descriptor, new Uint8Array(await new Response(stream).arrayBuffer()));
  }
  describeManifest(reference: string): Promise<ManifestOCIDescriptor> {
    throw new Error("Method not implemented.");
  }

  async putLayerFromBytes(
    flavor: 'blob' | 'manifest',
    descriptor: Omit<ManifestOCIDescriptor, 'digest' | 'size'> & { digest?: string },
    rawData: Uint8Array,
  ): Promise<ManifestOCIDescriptor> {

    const size = rawData.byteLength;
    const digest = `sha256:${await sha256bytesToHex(rawData)}`;

    if (descriptor.digest) {
      assertEquals(digest, descriptor.digest);
    }

    const existingData = this.storage[flavor].get(digest);
    if (!existingData) {
      this.storage[flavor].set(digest, rawData);
    } else if (existingData.byteLength !== size) {
      throw new Error(`Digest ${digest} clashed (size: ${existingData.byteLength} vs ${size}). This isn't supposed to happen`);
    }

    return {
      ...descriptor,
      digest, size,
    };
  }

  statLayer(flavor: "blob" | "manifest", digest: string): Promise<{ size: number; } | null> {
    const data = this.storage[flavor].get(digest);
    return Promise.resolve(data ? {
      size: data.byteLength,
    } : null);
  }
  getFullLayer(flavor: "blob" | "manifest", digest: string): Promise<Uint8Array> {
    const data = this.storage[flavor].get(digest);
    if (!data)
      throw new Deno.errors.NotFound(`Inmem store lacks ${flavor} ${digest}`);
    return Promise.resolve(data);
  }
  async getLayerStream(flavor: "blob" | "manifest", digest: string): Promise<ReadableStream<Uint8Array>> {
    const data = await this.getFullLayer(flavor, digest);
    return new StreamBuffer(data).readable;
  }

}
