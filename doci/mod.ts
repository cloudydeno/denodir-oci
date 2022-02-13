import { komando } from "../deps.ts";

import { buildCommand } from "./cmd/build.ts";
import { pullCommand } from "./cmd/pull.ts";
import { pushCommand } from "./cmd/push.ts";
import { runCommand } from "./cmd/run.ts";
import { exportCommand } from "./cmd/export.ts";
import { pipelineCommand } from "./cmd/pipeline.ts";

// https://github.com/ydcjeff/komando/commit/fea0bd01ccf934d982eea96d2728b3651ef62df9
(Deno as any).consoleSize ??= () => ({columns: 80, rows: 24});

komando({
  name: 'doci',
  version: '0.1.0',
  commands: [
    buildCommand,
    pushCommand,
    pullCommand,
    runCommand,
    exportCommand,
    pipelineCommand,
  ],
});
