// deprecated entrypoint
if (import.meta.main) {
  await import('./cli.ts');
}

export * from './actions.ts';
export * from './types.ts';
