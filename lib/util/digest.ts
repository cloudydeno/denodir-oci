import { readAll } from "../../deps.ts";

export async function sha256file(filePath: string) {
  const proc = Deno.run({
    cmd: ['sha256sum', '-z', filePath],
    stdin: 'null',
    stdout: 'piped',
  });

  const raw = await readAll(proc.stdout);

  const status = await proc.status();
  if (!status.success) throw new Error('sha256sum failed');

  return new TextDecoder().decode(raw.slice(0, 64));
}

export async function sha256string(message: string) {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(hash);
}

export async function sha256bytesToHex(message: Uint8Array) {
  const hash = await crypto.subtle.digest('SHA-256', message);
  return bytesToHex(hash);
}

async function bytesToHex(data: ArrayBuffer) {
  return [...new Uint8Array(data)]
    .map(x => x.toString(16).padStart(2, '0'))
    .join('');
}
