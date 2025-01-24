import { path, writeAll } from "../deps.ts";

export async function readDockerConfig(): Promise<DockerConfig> {
  const filePath = path.join(Deno.env.get('HOME') ?? '.', '.docker', 'config.json');
  try {
    return JSON.parse(await Deno.readTextFile(filePath));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return {};
    throw err;
  }
}

interface DockerConfig {
  auths?: Record<string, {
    auth?: string; // base64
    email?: string;
  }>;
  credsStore?: string;
  credHelpers?: Record<string, string>;
}

export async function fetchDockerCredential(serverName: string): Promise<DockerCredential | null> {
  const dockerConfig = await readDockerConfig();

  const indexName = serverName.match(/(.+\.)?docker\.io$/)
    ? 'index.docker.io'
    : serverName;

  const credHelper = dockerConfig.credHelpers?.[indexName];
  if (credHelper) {
    return new DockerCredentialHelper(credHelper).get(indexName);
  }

  if (dockerConfig.credsStore) {
    return new DockerCredentialHelper(dockerConfig.credsStore).get(indexName);
  }

  for (const [server, {auth}] of Object.entries(dockerConfig.auths ?? {})) {
    const hostname = server.includes('://') ? new URL(server).hostname : server;
    if (hostname == indexName && auth) {
      const basicAuth = atob(auth).split(':');
      if (basicAuth.length !== 2) throw new Error(`Failed to parse basic auth for ${server}`);
      return {
        Username: basicAuth[0],
        Secret: basicAuth[1],
      };
    }
  }

  return null;
}

export interface DockerCredential {
  Username: string;
  Secret: string; // aka Password
}

// https://github.com/docker/docker-credential-helpers
class DockerCredentialHelper {
  constructor(
    public readonly name: string,
    opts: {
      log?: (message: string) => void,
    } = {},
  ) {
    this.log = opts.log ?? console.error;
  }
  log: (message: string) => void;

  private async exec<T=unknown>(subcommand: string, stdin: string): Promise<T | null> {
    const command = new Deno.Command(`docker-credential-${this.name}`, {
      args: [subcommand],
      stdin: 'piped',
      stdout: 'piped',
    });
    const proc = command.spawn();

    if (stdin) {
      const writer = proc.stdin.getWriter();
      await writer.write(new TextEncoder().encode(stdin));
      writer.releaseLock();
    }
    proc.stdin.close();

    const result = await proc.output();

    if (!result.success) throw new Error(
      `Docker credential helper "${this.name}" failed at "${subcommand}"!`);

    const stdout = new TextDecoder().decode(result.stdout);
    if (stdout.includes('credentials not found')) {
      return null;
    }

    return JSON.parse(stdout);
  }

  async get(serverName: string) {
    this.log(`Asking Docker credential helper "${this.name}" about "${serverName}" ...`);

    const cred = await this.exec<DockerCredential>('get', serverName);
    if (!cred) return null;

    if (!cred.Username || !cred.Secret) throw new Error(
      `Docker credential helper "${this.name}" didn't return credentials`);
    return cred;
  }
}
