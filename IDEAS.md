* inject file imports as if rooted under https://denodir/
  * https://denodir/dns-sync/mod.ts
* dynamic import module
* fetch module from ???
* docker launch image for denodir-oci
  * option A: initcontainer to extract the denodir into an EmptyDir
  * option B:
* tenancy field: standalone, plug-in

doci push . gcr.io/doci/

# for dynamic imports?

```ts
export function PullImport(url)
```

# future commands

## clean

Delete blobs which aren't referenced by any local manifests.
Probably also delete local manifests first. (Which ones?)

## eject

make a normal runnable OCI image by combining an external Deno runtime image with a denodir artifact

there are two main possibilities for where the image should go:

1. drop a full .tar on disk, to be ingested by `docker load`
   and then handled/pushed like a normal image using the user's Docker config.
   https://github.com/opencontainers/image-spec/blob/main/image-layout.md
2. push the image to a registry ourselves.
   The benefit of this would be "mounting" the Deno runtime layer registry-to-registry
   instead of _always_ having it ready to write into the tarball.
   But we'd need to be up to the task of finding and authenticating to the user's registry.

## import

ingest layers from a tarball into the local storage
https://github.com/opencontainers/image-spec/blob/main/image-layout.md

## info

run `deno info` on an artifact?

## load

Take an artifact and add its contents to your normal DENODIR,
so you can import specifiers from it into regular Deno programs.

I'm not sure what the usecase for this would be exactly.
