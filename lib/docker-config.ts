import { assertEquals, path, readAll, writeAll } from "../deps.ts";

export async function readDockerConfig(): Promise<DockerConfig> {
  const filePath = path.join(Deno.env.get('HOME') ?? '.', '.docker', 'config.json');
  try {
    return await import(filePath, { assert: { type: "json" }}).then(x => x.default);
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
      assertEquals(basicAuth.length, 2);
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
  ) {}

  private async exec<T=unknown>(subcommand: string, stdin: string): Promise<T | null> {
    const proc = Deno.run({
      cmd: [`docker-credential-${this.name}`, subcommand],
      stdin: 'piped',
      stdout: 'piped',
    });

    if (stdin) {
      await writeAll(proc.stdin, new TextEncoder().encode(stdin));
    }
    proc.stdin.close();

    const stdout = new TextDecoder().decode(await readAll(proc.stdout));
    if (stdout.includes('credentials not found')) {
      return null;
    }

    const status = await proc.status();
    if (!status.success) throw new Error(
      `Docker credential helper "${this.name}" failed at "${subcommand}"!`);

    return JSON.parse(stdout);
  }

  async get(serverName: string) {
    console.error(`   `, `Asking Docker credential helper "${this.name}" about "${serverName}" ...`);

    const cred = await this.exec<DockerCredential>('get', serverName);
    if (!cred) return null;

    if (!cred.Username || !cred.Secret) throw new Error(
      `Docker credential helper "${this.name}" didn't return credentials`);
    return cred;
  }
}
