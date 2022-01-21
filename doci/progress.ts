import { forEach } from "https://deno.land/x/stream_observables@v1.2/transforms/for-each.ts";
import ProgressBar from "https://deno.land/x/progress@v1.2.4/mod.ts";

export function showStreamProgress(totalSize: number) {

  const progressBar = new ProgressBar({
    total: totalSize,
  });

  let bytesSoFar = 0;
  return forEach<Uint8Array>(buffer => {
    bytesSoFar += buffer.byteLength;
    progressBar.render(bytesSoFar);
  });

  // return new TransformStream<Uint8Array, Uint8Array>(
  //   {
  //     async transform(chunk, controller) {
  //       controller.enqueue(chunk);
  //       bytesSoFar += chunk.byteLength;
  //       try {
  //         await f(chunk);
  //       } catch (e) {}
  //     },
  //     flush(controller) {
  //       progressBar.end();
  //     }
  //   },
  //   { highWaterMark: 1 },
  //   { highWaterMark: 0 }
  // );
}
