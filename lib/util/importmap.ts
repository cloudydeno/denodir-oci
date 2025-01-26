export function renderImportmapFlag(imports: Record<string,string>) {
  const importmap = {
    imports: Object.fromEntries(Object.entries(imports).map(([key, value]) => {
      if (value.startsWith('./')) {
        return [key, 'file://' + Deno.cwd() + value.slice(1)];
      }
      return [key, value];
    })),
  };
  return `--importmap=data:application/importmap+json;base64,${btoa(JSON.stringify(importmap))}`;
}
