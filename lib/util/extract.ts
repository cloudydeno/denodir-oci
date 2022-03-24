import { copy, path, readerFromIterable, Untar } from "../../deps.ts";

// This is to be rewritten when a streams-based Untar is available

export async function extractTarArchive(tar: ReadableStream<Uint8Array>, destFolder: string) {
  // if (!layer.mediaType.endsWith('.tar+gzip')) throw new Error(
  //   `Cannot extract non-tarball layer "${layer.mediaType}"`);

  // const layerReader = await this.getLayerStream('blob', layer.digest);
  // const unzippedStream = layerReader.pipeThrough(new DecompressionStream('gzip'));
  const untar = new Untar(readerFromIterable(tar));

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
    fileCount,
    fileSize,
  };
}
