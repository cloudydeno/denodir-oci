import { OciImageConfig } from "../types.ts";

export class ImageConfigWriter {
  constructor(
    baseConfig: OciImageConfig,
    public readonly comment: string,
  ) {
    this.creationDate = new Date().toISOString();
    // Clone the relevant bits so we can modify what we want
    this.data = { ...baseConfig,
      history: [ ...baseConfig.history ?? [] ],
      config: { ...baseConfig.config },
      rootfs: { ...baseConfig.rootfs,
        diff_ids: [ ...baseConfig.rootfs.diff_ids ],
      },
      created: this.creationDate,
    };
  }
  readonly creationDate: string;
  readonly data: OciImageConfig;

  getEnv(key: string) {
    const prefix = `${key}=`;
    return this.data.config.Env
      .find(x => x.startsWith(prefix))
      ?.slice(prefix.length);
  }
  setEnv(key: string, value: string) {
    const prefix = `${key}=`;
    const env = `${key}=${value}`;
    this.data.config.Env = this.data.config.Env.filter(x => !x.startsWith(prefix));
    this.data.config.Env.push(env);
    this.recordEmptyLayer(`ENV ${env}`);
  }

  setEntrypoint(args: string[]) {
    this.data.config.Entrypoint = args;
    this.recordEmptyLayer(`ENTRYPOINT [${args.map(x => JSON.stringify(x)).join(' ')}]`);
  }

  setCommand(args: string[]) {
    this.data.config.Cmd = args;
    this.recordEmptyLayer(`CMD [${args.map(x => JSON.stringify(x)).join(' ')}]`);
  }

  recordEmptyLayer(created_by: string) {
    this.data.history?.push({
      empty_layer: true,
      created: this.creationDate,
      created_by,
      comment: this.comment,
    });
  }

  recordDiffLayer(layer: {
    command: string;
    diffDigest: string;
  }) {
    this.data.history?.push({
      created: this.creationDate,
      created_by: layer.command,
      comment: this.comment,
    });
    this.data.rootfs.diff_ids.push(layer.diffDigest);
  }
}
