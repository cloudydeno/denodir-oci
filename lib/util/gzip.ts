// import { readableStreamFromReader } from "../../deps.ts";
import { forEach } from "https://deno.land/x/stream_observables@v1.2/transforms/for-each.ts"

export interface CompressionStats {
  rawSize: number;
  compressedSize: number;
  ratio: number;
  durationMillis: number;
}

export function gzipStream(readable: ReadableStream<Uint8Array>) {
  let rawSize = 0;
  let compressedSize = 0;
  const startTime = performance.now();

  let statsOk: (stats: CompressionStats) => void;
  const statsPromise = new Promise<CompressionStats>(ok => statsOk = ok);

  const compressedStream = readable
    .pipeThrough(forEach(x => rawSize += x.byteLength))
    .pipeThrough(new CompressionStream("gzip"))
    .pipeThrough(forEach(x => compressedSize += x.byteLength))
    .pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
      flush: () => statsOk({
        rawSize,
        compressedSize,
        ratio: (rawSize - compressedSize) / rawSize,
        durationMillis: performance.now() - startTime,
      }),
    }));

  statsPromise.then(stats => console.error('   ',
    'gzipped', Math.round(stats.rawSize/1024), 'KiB',
    'to', Math.round(stats.compressedSize/1024), 'KiB',
    `-`, Math.round(stats.ratio*10000)/100, '% smaller',
    `- in`, stats.durationMillis, 'ms'));

  return [compressedStream, statsPromise] as const;
}
