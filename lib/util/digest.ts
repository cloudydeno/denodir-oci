import { Sha256, readableStreamFromReader } from "../../deps.ts";

export async function sha256file(filePath: string) {
  // Until subtle crypto has streaming digesting, this will have to do
  const digest = new Sha256();

  const stream = await Deno.open(filePath, { read: true });
  for await (const chunk of readableStreamFromReader(stream)) {
    digest.update(chunk);
  }
  return digest.toString();
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
