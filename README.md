# denodir-oci
Upload Deno cache directories to OCI registries. Download and run on another machine, or repackage with a Deno runtime layer to make a regular Docker image.

```
deno install -f --allow-{read,write}=$HOME,/tmp --allow-run=deno,gzip,gunzip,sha256sum,oras --allow-net --allow-env=HOME doci/mod.ts
```

## Examples

A reference of some modules that I've been building as test material.

### Basic images

```sh
doci build https://deno.land/std@0.122.0/examples/welcome.ts # A single file
doci build https://deno.land/std@0.122.0/examples/colors.ts # Two files
doci build https://deno.land/std@0.122.0/examples/flags.ts # Three files
```

### Multiple layers

Examples where large slow-moving libraries are put in a separate base layer
for better storage utilization after successive builds.

```sh
# One big static module and one smaller module which changes often
doci build --ref publish-firebase-blog https://raw.githubusercontent.com/cloudydeno/notion-toolbox/main/{object-model,publish-firebase-blog}/mod.ts

# or, with multiple lines:
doci build --ref publish-firebase-blog \
  https://raw.githubusercontent.com/cloudydeno/notion-toolbox/main/object-model/mod.ts \
  https://raw.githubusercontent.com/cloudydeno/notion-toolbox/main/publish-firebase-blog/mod.ts


# A deps.ts for dependencies, followed by the actual entrypoint
doci build --ref kubernetes-dns-sync https://raw.githubusercontent.com/cloudydeno/kubernetes-dns-sync/main/src/{deps,controller/mod}.ts

# or, with multiple lines:
doci build --ref kubernetes-dns-sync \
  https://raw.githubusercontent.com/cloudydeno/kubernetes-dns-sync/main/src/deps.ts
  https://raw.githubusercontent.com/cloudydeno/kubernetes-dns-sync/main/src/controller/mod.ts
```
