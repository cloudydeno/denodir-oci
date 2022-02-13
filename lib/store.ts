import type { OciStoreApi } from "./store/_api.ts";
import { getOciRegistry } from "./store/registry.ts";
import { OciStoreInmem } from "./store/in-memory.ts";
import { OciStoreLocal } from "./store/local.ts";
import { StackedStore } from "./store/stacked.ts";

export type Api = OciStoreApi;

export async function local(identifier?: string) {
  const store = new OciStoreLocal(identifier);
  await store.init();
  return store;
}

export function stack(opts: {
  writable?: OciStoreApi;
  readable: Array<OciStoreApi>;
}) {
  return new StackedStore(opts.readable, opts.writable ?? null);
}

export function inMemory() {
  return new OciStoreInmem();
}

export const registry = getOciRegistry;
