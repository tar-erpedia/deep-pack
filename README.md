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

```bash
npx -p @tar-erpedia/deep-pack npm-deep-pack <spec> [options]
```
After the global installation above, use `npm-deep-pack <spec> [options]` instead.
**Aliases**: `deep-pack`, `deep-pack-cli`
<br>

#### \<spec\>

1. ##### Single package with dependencies

    **Package name**: `[@<pkg_org>/]<package_name>`
    Package name with version range `[@<pkg_org>/]<package_name>[@<pkg_version>]`

    Valid examples: `next`, `@vue/cli`, `react@19.0.1`, `vite@latest`

2. ##### All dependencies in a package.json file

    **Path**: a path to a package manifest file (the file can have any name, not just `package.json`)

    Root-level `dependencies`, `devDependencies`, `optionalDependencies` and required peers are included automatically. Deeper levels follow the normal dependency selection rules. An adjacent `package-lock.json` is not used automatically; use `-l` to select exact versions from a lockfile.

    Valid examples: `/absolute/path/to/package.json`, `relative/path/to/manifest.json`

3. ##### Exact dependencies from a package-lock.json file

    Use `-l` or `--lock` with a package-lock path.
    Lock mode resolves a flat list of exact versions. Dev entries are included only with `--dev` (`--dev-recursive` behaves like `--dev` in this mode); optional entries are included only with `--optional`. `devOptional` entries require both `--dev` and `--optional`. Lockfile v1 has no peer information, so `--no-peer` cannot filter peers from v1 lockfiles.
    `--max-depth` does not apply in lock mode. Non-registry lock entries (git, file, link, and URL) are skipped with a warning.

    Valid examples: `-l package-lock.json`, `--lock ../path/to/package-lock.json`

#### Options

```
-V, --version                   output the version number
-d, --max-depth <depth>         max depth (positive integer, default: unlimited)
--dev, --dev-deps               Include only the root package's devDependencies (their regular dependencies are still walked)
--dev-recursive, --dev-deps-recursive  Include devDependencies at every level of the tree (implies --dev)
-l, --lock <path>               Path to a package-lock.json file with exact package versions
--no-peer, --no-peer-deps       Don't resolve peerDependencies
--optional, --optional-deps     Resolve optionalDependencies at every level and the root's optional peerDependencies
--out-deps                      Write the discovered dependency list (deep-pack-deps-log.txt) into the output
--tgz, --output-tgz             Bundle output to a single tgz
-h, --help
```

Dependency selection by default includes regular dependencies and required (non-optional) peers at every level. `--dev` adds only the root package's devDependencies; their regular dependencies are still walked. `--dev-recursive` includes devDependencies throughout the tree and can produce a very large result. `--optional` adds optionalDependencies at every level, plus the root package's optional peers (optional peers deeper in the tree are skipped, like npm does). `--no-peer` disables peer dependency resolution.

#### Output and failures

Tarballs are downloaded to a temporary directory, so the current working directory is not polluted during resolution. By default the completed output is moved to `deep-pack-<name>_<version>/` in the current directory. With `--tgz`, only `deep-pack-<name>_<version>.tgz` is written. Output names are sanitized: path separators and characters invalid on Windows are replaced with `_`. If the destination name already exists, a warning is printed at startup and a timestamp suffix is appended, for example `deep-pack-scripty_0.1.0_20261109-104233.tgz`; existing output is never overwritten.

A package failure does not block its parents. Network operations retry three times and concurrency is capped. Failures reached through optional dependency edges are warnings; other failures are errors. The end-of-run summary reports the output path, package count, total size, warnings and errors. Exit codes: `0` for success, `1` for errors (including registry or network failure while resolving the root package), `2` when neither a package spec nor `--lock` was supplied, and `3` for an invalid spec or path.

#### Examples

###### Basic

```bash
npx -p @tar-erpedia/deep-pack npm-deep-pack vite
```

###### With optional dependencies and output dependencies in tgz bundle

```bash
npx -p @tar-erpedia/deep-pack npm-deep-pack --optional --tgz next
```


###### Unrecommended: No peer, only direct

```bash
npx -p @tar-erpedia/deep-pack npm-deep-pack --no-peer react-router
```

###### From a package manifest

```bash
npx -p @tar-erpedia/deep-pack npm-deep-pack ../path/to/package.json
```

###### From a package manifest: tgz output

```bash
npx -p @tar-erpedia/deep-pack npm-deep-pack --tgz ../path/to/package.json
```

###### Include dev dependencies at every level

This can produce a very large output because devDependencies are included throughout the dependency tree.

```bash
npx -p @tar-erpedia/deep-pack npm-deep-pack --dev-recursive vite
```

###### From package-lock.json: exact locked versions

```bash
npx -p @tar-erpedia/deep-pack npm-deep-pack -l ../path/to/package-lock.json
```

###### From package-lock.json: include dev dependencies too

```bash
npx -p @tar-erpedia/deep-pack npm-deep-pack -l ../path/to/package-lock.json --dev
```
