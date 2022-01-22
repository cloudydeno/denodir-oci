# denodir-oci
Upload Deno cache directories to OCI registries. Download and run on another machine, or repackage with a Deno runtime layer to make a regular Docker image.

```
deno install -f --allow-{read,write}=$HOME,${TMPDIR:-/tmp} --allow-run --allow-net --allow-env --reload=https://raw.githubusercontent.com https://raw.githubusercontent.com/cloudydeno/denodir-oci/main/doci/mod.ts
```

## Examples

A reference of some modules that I've been building as test material.

### Tiny examples

```sh
doci build https://deno.land/std@0.122.0/examples/welcome.ts # A single file
doci build https://deno.land/std@0.122.0/examples/colors.ts # Two files
doci build https://deno.land/std@0.122.0/examples/flags.ts # Three files
```

### Large images

```sh
doci build https://raw.githubusercontent.com/cloudydeno/kubernetes-dns-sync/main/src/controller/mod.ts
```

### Multiple layers

Examples where larger slow-moving libraries are put in a separate base layer
for better storage utilization after successive builds.

```sh
# One big static module and one smaller module which changes often
doci build --ref publish-firebase-blog \
  https://raw.githubusercontent.com/cloudydeno/notion-toolbox/main/object-model/mod.ts \
  https://raw.githubusercontent.com/cloudydeno/notion-toolbox/main/publish-firebase-blog/mod.ts

# or, condensed:
doci build --ref publish-firebase-blog https://raw.githubusercontent.com/cloudydeno/notion-toolbox/main/{object-model,publish-firebase-blog}/mod.ts


# A deps.ts for dependencies, followed by the actual entrypoint
doci build --ref kubernetes-dns-sync \
  https://raw.githubusercontent.com/cloudydeno/kubernetes-dns-sync/main/src/deps.ts
  https://raw.githubusercontent.com/cloudydeno/kubernetes-dns-sync/main/src/controller/mod.ts

# or, condensed:
doci build --ref kubernetes-dns-sync https://raw.githubusercontent.com/cloudydeno/kubernetes-dns-sync/main/src/{deps,controller/mod}.ts
```
