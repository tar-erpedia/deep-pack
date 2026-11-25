/// <reference path="../types/package.d.ts" />

import npa from "npm-package-arg";
import pacote, { type Manifest } from "pacote";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { type TriState, TriStates } from "./tristate.js";
import Program from "./program.js";

// Fix pacote types missing key - peerDependenciesMeta
declare module "pacote" {
    interface ManifestResult {
        peerDependenciesMeta: Record<string, { optional: boolean }> | null;
    }
}

const LATEST: PackageVersion = "latest";

const Errors = {
    NO_TARBALL: "no tarball",
    NOT_FOUND: "not found",
    PACKAGE_DOESNT_EXIST_IN_REGISTRY: "package doesn't exist in registry",
    TOO_MANY_FAILURES: "too many failures",
    UNKNOWN_ERROR: "unknown error",
    VERSION_DOESNT_EXIST_IN_REGISTRY: "version doesn't exist in registry",
} as const;

interface PackageLockPackage {
    name?: string;
    version?: string;
    link?: boolean;
    dev?: boolean;
}

interface PackageLockDependency {
    version?: string;
    dev?: boolean;
    dependencies?: Record<string, PackageLockDependency>;
}

interface PackageLock {
    name?: string;
    version?: string;
    packages?: Record<string, PackageLockPackage>;
    dependencies?: Record<string, PackageLockDependency>;
}

function fullNameByNameAndVersion(name: string, version: string): PackageFullName {
    return `${name}@${version}`;
}

export default class Package {
    static readonly MAX_TRIES: number = 3;

    private packageJson: string = "";
    private downloading?: Promise<void>;
    public dependencies: Package[] = [];
    public dependents: Package[] = [];
    public error: boolean = false;
    public existsInRegistry: TriState = TriStates.UNKNOWN;
    public loading: boolean = false;
    // True while the package is being downloaded/resolved, prevents resolving the same package twice concurrently.
    public resolving: boolean = false;
    public name: string;
    public resolved: boolean = false;
    public version: string;

    static cache = new Map<PackageFullName, Package>();
    private static readonly specCache = new Map<string, Promise<Package | undefined>>();

    public get isRoot(): boolean {
        return this.dependents.length === 0;
    }

    public get fullName(): PackageFullName {
        return fullNameByNameAndVersion(this.name, this.version);
    }
    public get normalizedNameForPath(): string {
        return this.name.replace("/", "_");
    }

    public get tarballPath(): string {
        return `./${this.normalizedNameForPath}-${this.version}.tgz`;
    }

    protected constructor(name: string, version?: string) {
        this.name = name;
        this.version = version ?? LATEST;
    }

    public addDependent(pkg: Package) {
        if (!this.dependents.includes(pkg)) {
            this.dependents.push(pkg);
        }
    }

    public dependentOrDependentsToString(): string {
        switch (this.dependents.length) {
            case 0:
                return "";
            case 1:
                return this.dependents[0]?.toString() ?? "";
            default:
                return `[${this.dependents.join(",")}]`;
        }
    }

    // Downloads this package tarball unless it is the root package in file-based mode
    // or the file already exists in the destination directory.
    public download(): Promise<void> {
        // Concurrent callers share one download instead of fetching the same tarball twice.
        this.downloading ??= this.downloadOnce().catch((err) => {
            this.downloading = undefined;
            throw err;
        });
        return this.downloading;
    }

    private async downloadOnce(): Promise<void> {
        if (!this.fullName) {
            throw "Not enough data to download tgz file - missing or invalid package name or version";
        }
        if ((Program.packageJsonMode || Program.packageLockMode) && this.isRoot) return;

        const downloadPath = this.tarballPath;
        try {
            // Only trust non-empty files. Partial downloads are written to a temp name, so they never match here.
            if ((await fsPromises.stat(downloadPath)).size > 0) {
                console.log(`${this} already exists, skipping download`);
                Program.downloadedPackagesPath.add(downloadPath);
                return;
            }
        } catch (_err) {
            // not downloaded yet
        }

        const tempPath = `${downloadPath}.part`;
        let lastError: unknown;
        for (let attempt = 1; attempt <= Package.MAX_TRIES; attempt++) {
            try {
                await pacote.tarball.file(this.fullName, tempPath);
                await fsPromises.rename(tempPath, downloadPath);
                Program.downloadedPackagesPath.add(downloadPath);
                return;
            } catch (err) {
                lastError = err;
                console.log(`Failed downloading ${this} - ${err}. Attempt ${attempt}/${Package.MAX_TRIES}`);
                await fsPromises.rm(tempPath, { force: true });
            }
        }
        throw new Error(`Downloading ${this} failed, Reached maximum retry attempts: ${lastError}`);
    }

    // Resolves this package dependencies from npm metadata or from preloaded lockfile data.
    async getDependencies(
        includeDevDependencies: boolean,
        includePeerDependencies: boolean,
        includeOptionalDependencies: boolean
    ): Promise<Package[]> {
        this.loading = true;

        if (Program.packageLockMode) {
            return this.isRoot ? this.dependencies : [];
        }

        const responseBodyAsJSON = await pacote
            .manifest(Program.packageJsonMode && this.isRoot ? path.dirname(this.packageJson) : this.fullName, {
                // The abbreviated registry metadata may omit devDependencies. Only the root needs them.
                fullMetadata: includeDevDependencies && this.isRoot,
            })
            .catch((err: Error & { code: string }) => {
                console.log(err);
                switch (err.code) {
                    case "E404":
                        this.existsInRegistry = false;
                        console.log(`package ${this} doesn't exist`);
                        return null;
                    case "ETARGET":
                        this.existsInRegistry = false;
                        console.log(`version ${this.version} of package ${this.name} doesn't exist`);
                        return null;
                    default:
                        this.error = true;
                        this.loading = false;
                        throw err;
                }
            });

        if (!responseBodyAsJSON) {
            // just in case. shouldn't happen.
            this.error = true;
            this.loading = false;
            throw Errors.UNKNOWN_ERROR;
        }

        // Map keeps one entry per name. Earlier kinds win (dependencies > peer > optional > dev).
        const selected = new Map<string, string>();
        const add = (entries: Record<string, string> | null | undefined, filter?: (name: string) => boolean) => {
            for (const [name, range] of Object.entries(entries ?? {})) {
                if (!selected.has(name) && (!filter || filter(name))) selected.set(name, range);
            }
        };
        const peerMeta = responseBodyAsJSON.peerDependenciesMeta;
        const isOptionalPeer = (peer: string) => !!peerMeta?.[peer]?.optional;

        add(responseBodyAsJSON.dependencies);
        // Peer dependencies marked as optional are ignored unless optional dependencies were requested
        if (includePeerDependencies) {
            add(responseBodyAsJSON.peerDependencies, (peer) => includeOptionalDependencies || !isOptionalPeer(peer));
        }
        if (includeOptionalDependencies) add(responseBodyAsJSON.optionalDependencies);
        if (includeDevDependencies) add(responseBodyAsJSON.devDependencies);

        const resolvedDeps = await Promise.all(
            [...selected.entries()].map(async ([depName, depVersion]) => {
                try {
                    const { raw: packageString } = npa.resolve(depName, depVersion);
                    return packageString ? await Package.fromString(packageString) : undefined;
                } catch (err) {
                    console.error(`Invalid dependency ${depName}@${depVersion} of ${this}: ${err}`);
                    return undefined;
                }
            })
        );

        const result: Package[] = [];
        for (const dependency of resolvedDeps) {
            if (!dependency || result.includes(dependency)) continue;
            // check for cyclic dependency (I.E. https://registry.npmjs.org/@types/koa-compose/latest)
            if (this.isAncestorEqual(dependency)) continue;

            dependency.addDependent(this);
            result.push(dependency);
        }

        this.dependencies = result;
        return result;
    }

    public isAncestorEqual(pkg: Package, visited: Set<Package> = new Set()): boolean {
        if (pkg.isEqual(this)) {
            return true;
        }
        // Without the visited set every path through the dependents graph is walked, which is exponential.
        if (visited.has(this)) return false;
        visited.add(this);
        return this.dependents.some((dependent) => dependent.isAncestorEqual(pkg, visited));
    }

    public isEqual(pkg: Package): boolean {
        return pkg.fullName === this.fullName;
    }

    public toString(): string {
        return this.fullName;
    }

    // Restores previously resolved packages into cache so reruns can skip finished work.
    static fillCacheByFullNames(fullNames: PackageFullName[]) {
        for (const fullName of fullNames) {
            const trimmed = fullName.trim();
            if (!trimmed) continue;
            try {
                const { name, rawSpec } = npa(trimmed);
                if (!name || !rawSpec) continue;
                Package.fromNameAndVersion(name, rawSpec).resolved = true;
            } catch (_err) {
                // ignore malformed lines
            }
        }
    }

    // Returns the cached package instance for a name/version pair or creates it.
    public static fromNameAndVersion(name: string, version: string): Package {
        const fullName = fullNameByNameAndVersion(name, version);
        const cachedPkg = Package.cache.get(fullName);
        if (cachedPkg) {
            return cachedPkg;
        } else {
            const result = new Package(name, version);
            Package.cache.set(result.fullName, result);
            return result;
        }
    }

    // Extracts the package name from a package-lock packages path.
    private static packageNameFromLockPath(packagePath: string): string | undefined {
        const nodeModulesSegment = "node_modules/";
        const nodeModulesIndex = packagePath.lastIndexOf(nodeModulesSegment);
        if (nodeModulesIndex === -1) return undefined;

        const packageName = packagePath.slice(nodeModulesIndex + nodeModulesSegment.length);
        return packageName || undefined;
    }

    // Converts package-lock entries into Package objects, optionally including dev-only packages.
    private static collectLockPackages(packageLock: PackageLock, includeDevDependencies: boolean): Package[] {
        const packages = new Map<PackageFullName, Package>();

        if (packageLock.packages) {
            for (const [packagePath, lockPackage] of Object.entries(packageLock.packages)) {
                if (packagePath === "" || lockPackage.link || !lockPackage.version) continue;
                if (!includeDevDependencies && lockPackage.dev) continue;

                const packageName = lockPackage.name ?? Package.packageNameFromLockPath(packagePath);
                if (!packageName) continue;

                const pkg = Package.fromNameAndVersion(packageName, lockPackage.version);
                packages.set(pkg.fullName, pkg);
            }
        } else if (packageLock.dependencies) {
            const collectVersion1Dependencies = (dependencies: Record<string, PackageLockDependency>) => {
                for (const [packageName, dependency] of Object.entries(dependencies)) {
                    if (!includeDevDependencies && dependency.dev) continue;

                    if (dependency.version) {
                        const pkg = Package.fromNameAndVersion(packageName, dependency.version);
                        packages.set(pkg.fullName, pkg);
                    }

                    if (dependency.dependencies) {
                        collectVersion1Dependencies(dependency.dependencies);
                    }
                }
            };

            collectVersion1Dependencies(packageLock.dependencies);
        }

        return [...packages.values()];
    }

    // Creates a root package from a package-lock.json file and attaches its locked dependencies.
    static async fromPackageLock(
        packageLockPath: string,
        includeDevDependencies: boolean = false
    ): Promise<Package | undefined> {
        try {
            const packageLockFile = (await fsPromises.readFile(packageLockPath)).toString();
            const packageLock = JSON.parse(packageLockFile) as PackageLock;
            const rootName = packageLock.name ?? "package-lock-root";
            const rootVersion = packageLock.version ?? LATEST;
            const rootPackage = Package.fromNameAndVersion(rootName, rootVersion);
            rootPackage.dependencies = Package.collectLockPackages(packageLock, includeDevDependencies);

            for (const dependency of rootPackage.dependencies) {
                dependency.addDependent(rootPackage);
            }

            Program.packageLockMode = true;
            return rootPackage;
        } catch (ex) {
            const reason = ex instanceof Error ? ex.message : String(ex);
            console.error(`Failed to read package-lock.json from "${packageLockPath}": ${reason}`);
            return undefined;
        }
    }

    private static isFile(candidate: string): boolean {
        try {
            return fs.statSync(candidate).isFile();
        } catch (_err) {
            return false;
        }
    }

    // Creates a package from a package.json path or an npm package spec.
    static fromString(packageNameInAnyFormat: string): Promise<Package | undefined> {
        // Treat as path to package.json. Directories and unrelated files must not hijack package specs.
        if (Package.isFile(packageNameInAnyFormat)) return Package.fromPackageJsonFile(packageNameInAnyFormat);

        // The same spec is requested by many dependents, resolve each spec over the network only once.
        let result = Package.specCache.get(packageNameInAnyFormat);
        if (!result) {
            result = Package.fromSpec(packageNameInAnyFormat);
            Package.specCache.set(packageNameInAnyFormat, result);
        }
        return result;
    }

    private static async fromPackageJsonFile(packageJsonPath: string): Promise<Package | undefined> {
        try {
            console.log(`${packageJsonPath} is a file, using as package.json`);
            Program.packageJsonMode = true;

            // pacote reads the manifest from the directory, so the file has to be called package.json
            if (path.basename(packageJsonPath).toLowerCase() !== "package.json")
                throw new Error(
                    `the file must be named "package.json" (got "${path.basename(packageJsonPath)}"), put it in its own folder`
                );

            const packageJsonFile = (await fsPromises.readFile(packageJsonPath)).toString();
            const packageJson = JSON.parse(packageJsonFile) as Manifest;
            if (!packageJson.name) throw new Error("Invalid package.json format, missing or invalid name");

            const pkg = Package.fromNameAndVersion(packageJson.name, packageJson.version ?? LATEST);
            pkg.packageJson = path.resolve(packageJsonPath);
            return pkg;
        } catch (ex) {
            const reason = ex instanceof Error ? ex.message : String(ex);
            console.error(`Failed to read package.json "${packageJsonPath}": ${reason}`);
            return undefined;
        }
    }

    private static async fromSpec(spec: string): Promise<Package | undefined> {
        try {
            // Validate package name and version
            npa(spec);

            const { name, version } = await pacote.manifest(spec);
            return Package.fromNameAndVersion(name, version);
        } catch (ex) {
            const reason = ex instanceof Error ? ex.message : String(ex);
            console.error(`Failed to resolve package spec "${spec}": ${reason}`);
            return undefined;
        }
    }
}
