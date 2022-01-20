import { copy } from "../../deps.ts";

export async function gzipReaderToFile(reader: Deno.Reader, targetPath: string) {

  const gzip = Deno.run({
    cmd: ['gzip'],
    stdin: 'piped',
    stdout: 'piped',
  });

  const target = await Deno.open(targetPath, {
    create: true,
    truncate: true,
    write: true,
  });

  const [rawSize, compressedSize] = await Promise.all([
    copy(reader, gzip.stdin)
      .then(size => (gzip.stdin.close(), size)),
    copy(gzip.stdout, target)
      .then(size => (target.close(), size)),
  ]);

  const ratio = (rawSize - compressedSize) / rawSize;
  console.log('   ',
    'gzipped', Math.round(rawSize/1024), 'KiB',
    'to', Math.round(compressedSize/1024), 'KiB',
    `-`, Math.round(ratio*10000)/100, '% smaller');

  return compressedSize;
}
