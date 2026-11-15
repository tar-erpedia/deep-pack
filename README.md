# NPM Deep Pack

📦 Resolve and download a package and its dependencies 🗃️

## Installation

```bash
npm i @tar-erpedia/deep-pack -g
```

## CLI

---

By default, dependencies and required (non-optional) peer dependencies are resolved at every level of the dependency tree. Optional dependencies and optional peers are excluded unless `--optional` is specified.

### Usage

After the global installation above:

```bash
deep-pack <spec> [options]
```
**Aliases**: `npm-deep-pack`, `deep-pack-cli`
<br>

#### \<spec\>

1. ##### Single package with dependencies

    **Package name**: `[@<pkg_org>/]<package_name>`
    Package name with version range `[@<pkg_org>/]<package_name>[@<pkg_version>]`

    Valid examples: `next`, `@vue/cli`, `react@19.0.1`, `vite@latest`

2. ##### All dependencies in a package.json file

    **Path**: a path to a package manifest file (the file can have any name, not just `package.json`)

    Root-level `dependencies`, `devDependencies`, `optionalDependencies` and required peers are included automatically. Deeper levels follow the normal dependency selection rules. An adjacent `package-lock.json` is not used automatically; pass the lock file itself to use exact versions.

    Valid examples: `/absolute/path/to/package.json`, `relative/path/to/manifest.json`

3. ##### Exact dependencies from a package-lock.json file

    **Path**: a path to a lock file (detected by its `lockfileVersion` field, so any file name works).
    Lock mode resolves a flat list of exact versions. Like a package.json, dev entries are always included. Optional entries are included only with `--optional`, because a lock file can't tell the root's optional dependencies from deeper ones. Lockfile v1 has no peer information, so `--no-peer` cannot filter peers from v1 lockfiles.
    `--max-depth` does not apply in lock mode. Non-registry lock entries (git, file, link, and URL) are skipped with a warning.

    Valid examples: `package-lock.json`, `../path/to/package-lock.json`

#### Options

```
-V, --version                   output the version number
-d, --max-depth <depth>         max depth (positive integer, default: unlimited)
--dev, --dev-deps               Include only the root package's devDependencies (their regular dependencies are still walked). Always on for package.json and lock files
--dev-recursive, --dev-deps-recursive  Include devDependencies at every level of the tree (implies --dev)
--no-peer, --no-peer-deps       Don't resolve peerDependencies
--optional, --optional-deps     Resolve optionalDependencies at every level and the root's optional peerDependencies
--out-deps                      Write the discovered dependency list (deep-pack-deps-log.txt) into the output
--tgz, --output-tgz             Bundle output to a single tgz
-h, --help
```

Dependency selection by default includes regular dependencies and required (non-optional) peers at every level. `--dev` adds only the root package's devDependencies; their regular dependencies are still walked. `--dev-recursive` includes devDependencies throughout the tree and can produce a very large result. `--optional` adds optionalDependencies at every level, plus the root package's optional peers (optional peers deeper in the tree are skipped, like npm does). `--no-peer` disables peer dependency resolution.

#### Output and failures

Tarballs are downloaded to a temporary directory, so the current working directory is not polluted during resolution. By default the completed output is moved to `deep-pack-<name>_<version>/` in the current directory. With `--tgz`, only `deep-pack-<name>_<version>.tgz` is written. Output names are sanitized: path separators and characters invalid on Windows are replaced with `_`. If the destination name already exists, a warning is printed at startup and a timestamp suffix is appended, for example `deep-pack-scripty_0.1.0_20261109-104233.tgz`; existing output is never overwritten.

A package failure does not block its parents. Network operations retry three times and concurrency is capped. Failures reached through optional dependency edges are warnings; other failures are errors. The end-of-run summary reports the output path, package count, total size, warnings and errors. Exit codes: `0` for success, `1` for errors (including registry or network failure while resolving the root package), `2` when no spec was supplied, and `3` for an invalid spec or path.

#### Examples

###### Basic

```bash
deep-pack vite
```

###### With optional dependencies and output dependencies in tgz bundle

```bash
deep-pack --optional --tgz next
```


###### Unrecommended: No peer, only direct

```bash
deep-pack --no-peer react-router
```

###### From a package manifest

```bash
deep-pack ../path/to/package.json
```

###### From a package manifest: tgz output

```bash
deep-pack --tgz ../path/to/package.json
```

###### Include dev dependencies at every level

This can produce a very large output because devDependencies are included throughout the dependency tree.

```bash
deep-pack --dev-recursive vite
```

###### From package-lock.json: exact locked versions

```bash
deep-pack ../path/to/package-lock.json
```
