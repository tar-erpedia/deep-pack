/// <reference path="../types/package.d.ts" />

import npa from "npm-package-arg";
import pacote from "pacote";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import Program from "./program.js";
import { errorMessage } from "./utils.js";

// Fix pacote types missing key - peerDependenciesMeta
declare module "pacote" {
    interface ManifestResult {
        peerDependenciesMeta: Record<string, { optional: boolean }> | null;
    }
}

const LATEST: PackageVersion = "latest";
type RegistryManifest = Awaited<ReturnType<typeof pacote.manifest>>;

interface PackageLockPackage {
    name?: string;
    version?: string;
    resolved?: string;
    link?: boolean;
    dev?: boolean;
    devOptional?: boolean;
    optional?: boolean;
    peer?: boolean;
}

interface PackageLockDependency extends PackageLockPackage {
    dependencies?: Record<string, PackageLockDependency>;
}

interface PackageLock {
    name?: string;
    version?: string;
    lockfileVersion?: number;
    packages?: Record<string, PackageLockPackage>;
    dependencies?: Record<string, PackageLockDependency>;
}

type RegistrySpec = npa.Result & { name: string; fetchSpec: string };

interface SelectedDependency {
    name: string;
    spec: string;
    kind: "dependency" | "peer" | "dev" | "optional";
    optional: boolean;
}

export class PackageSpecError extends Error {
    constructor(message: string, public readonly kind: "invalid" | "resolve") {
        super(message);
        this.name = "PackageSpecError";
    }
}

function fullNameByNameAndVersion(name: string, version: string): PackageFullName {
    return `${name}@${version}`;
}

export default class Package {
    static readonly MAX_TRIES: number = 3;
    private static readonly pendingManifests = new Map<string, Promise<RegistryManifest>>();
    private static readonly failedSpecs = new Map<string, Package>();
    private static readonly downloadsByPath = new Map<string, { fullName: string; promise: Promise<number> }>();

    public dependencies: Package[] = [];
    public dependents: Package[] = [];
    public error: boolean = false;
    public failureReason: string | undefined;
    public isRootPackage: boolean = false;
    public lockOptional: boolean = false;
    public packageLock: PackageLock | undefined;
    public manifest: RegistryManifest | undefined;
    public name: string;
    public optionalEdge: boolean | undefined;
    public version: string;
    public warning: boolean = false;

    static cache = new Map<PackageFullName, Package>();

    public get fullName(): PackageFullName {
        return fullNameByNameAndVersion(this.name, this.version);
    }
    public get normalizedNameForPath(): string {
        return this.name.replace("/", "_");
    }

    protected constructor(name: string, version?: string) {
        this.name = name;
        this.version = version ?? LATEST;
    }

    public addDependent(pkg: Package, optionalEdge: boolean = false) {
        if (!this.dependents.includes(pkg)) {
            this.dependents.push(pkg);
        }
        this.optionalEdge = this.optionalEdge === undefined ? optionalEdge : this.optionalEdge && optionalEdge;
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

    // No concurrency cap here: pacote's HTTP agent already limits connections (maxSockets, default 15).
    private static async withNetworkRetries<T>(operation: () => Promise<T>, context: string): Promise<T> {
        let lastError: unknown;
        for (let attempt = 1; attempt <= Package.MAX_TRIES; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;
                // Missing packages/versions won't appear on retry
                const code = (error as { code?: string }).code;
                if (code === "E404" || code === "ETARGET") break;
                if (attempt < Package.MAX_TRIES) {
                    console.log(`${context} failed - ${errorMessage(error)}. Retrying...`);
                }
            }
        }
        throw lastError;
    }

    private static registrySpec(name: string, spec: string): RegistrySpec | undefined {
        try {
            const parsed = name ? npa.resolve(name, spec) : npa(spec);
            const target = parsed.type === "alias" ? (parsed as npa.AliasResult).subSpec : parsed;
            return target.registry && target.name && target.fetchSpec ? (target as RegistrySpec) : undefined;
        } catch (_error) {
            return undefined;
        }
    }

    private static async fetchManifest(spec: string): Promise<RegistryManifest> {
        const pending = Package.pendingManifests.get(spec);
        if (pending) return pending;

        const request = Package.withNetworkRetries(() => pacote.manifest(spec), `Resolving ${spec}`).finally(() => {
            Package.pendingManifests.delete(spec);
        });
        Package.pendingManifests.set(spec, request);
        return request;
    }

    private static async downloadToPath(fullName: string, downloadPath: string): Promise<number> {
        try {
            return (await fsPromises.stat(downloadPath)).size;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }

        try {
            return await Package.withNetworkRetries(
                async () => {
                    await fsPromises.rm(downloadPath, { force: true });
                    await pacote.tarball.file(fullName, downloadPath);
                    return (await fsPromises.stat(downloadPath)).size;
                },
                `Downloading ${fullName}`
            );
        } catch (error) {
            await fsPromises.rm(downloadPath, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    // Downloads this package tarball unless it is the root package in file-based mode.
    public async download(): Promise<void> {
        if (!this.fullName) {
            throw new Error("Not enough data to download tgz file - missing or invalid package name or version");
        }
        if ((Program.packageJsonMode || Program.packageLockMode) && this.isRootPackage) return;

        const downloadDirectory = Program.tempDir || process.cwd();
        const downloadPath = path.resolve(downloadDirectory, `${this.normalizedNameForPath}-${this.version}.tgz`);
        let download = Package.downloadsByPath.get(downloadPath);
        if (download && download.fullName !== this.fullName) {
            throw new Error(
                `Tarball path collision between ${download.fullName} and ${this.fullName} at ${downloadPath}`
            );
        }

        if (!download) {
            const promise = Package.downloadToPath(this.fullName, downloadPath);
            download = { fullName: this.fullName, promise };
            Package.downloadsByPath.set(downloadPath, download);
            void promise.catch(() => {
                if (Package.downloadsByPath.get(downloadPath) === download) {
                    Package.downloadsByPath.delete(downloadPath);
                }
            });
        }

        const size = await download.promise;
        Program.downloadedPackagesPath.set(downloadPath, size);
    }

    // Resolves this package dependencies from npm metadata or from preloaded lockfile data.
    async getDependencies(
        includeDevDependencies: boolean,
        includePeerDependencies: boolean,
        includeOptionalDependencies: boolean,
        onDependency?: (dependency: Package) => void
    ): Promise<Package[]> {
        if (Program.packageLockMode) {
            if (!this.isRootPackage || !this.packageLock) return [];
            this.dependencies = Package.collectLockPackages(
                this.packageLock,
                this,
                includePeerDependencies,
                includeOptionalDependencies
            );
            for (const dependency of this.dependencies) {
                dependency.addDependent(this, dependency.lockOptional);
                onDependency?.(dependency);
            }
            return this.dependencies;
        }

        let ownManifest = this.manifest;
        if (!ownManifest) {
            try {
                ownManifest = await Package.fetchManifest(this.fullName);
                this.manifest = ownManifest;
            } catch (error) {
                this.error = true;
                this.failureReason = errorMessage(error);
                throw error;
            }
        }

        const isPackageJsonRoot = Program.packageJsonMode && this.isRootPackage;
        const includeDev = includeDevDependencies || isPackageJsonRoot;
        const includeOptional = includeOptionalDependencies || isPackageJsonRoot;
        const selectedDependencies = new Map<string, SelectedDependency>();
        const precedence = { dependency: 4, peer: 3, dev: 2, optional: 1 };
        const select = (name: string, spec: string, kind: SelectedDependency["kind"], optional: boolean) => {
            const existing = selectedDependencies.get(name);
            if (!existing) {
                selectedDependencies.set(name, { name, spec, kind, optional });
                return;
            }

            const combinedOptional = existing.optional && optional;
            if (precedence[kind] > precedence[existing.kind]) {
                selectedDependencies.set(name, { name, spec, kind, optional: combinedOptional });
            } else {
                existing.optional = combinedOptional;
            }
        };

        for (const [name, spec] of Object.entries(ownManifest.dependencies ?? {})) {
            select(name, spec, "dependency", false);
        }

        if (includePeerDependencies) {
            const peerMeta = ownManifest.peerDependenciesMeta as
                | Record<string, { optional?: boolean }>
                | null
                | undefined;
            for (const [name, spec] of Object.entries(ownManifest.peerDependencies ?? {})) {
                if (!peerMeta?.[name]?.optional) {
                    select(name, spec, "peer", false);
                } else if (includeOptionalDependencies && this.isRootPackage) {
                    select(name, spec, "peer", true);
                }
            }
        }

        if (includeDev) {
            for (const [name, spec] of Object.entries(ownManifest.devDependencies ?? {})) {
                select(name, spec, "dev", false);
            }
        }

        if (includeOptional) {
            for (const [name, spec] of Object.entries(ownManifest.optionalDependencies ?? {})) {
                select(name, spec, "optional", true);
            }
        }

        const result = await Promise.all(
            [...selectedDependencies.values()].map(async ({ name, spec, optional }) => {
                const registrySpec = Package.registrySpec(name, spec);
                let dependency: Package;
                if (!registrySpec) {
                    dependency = Package.skippedSpec(name, spec);
                } else {
                    const failedSpec = Package.failedSpecs.get(Package.failedSpecKey(registrySpec.name, registrySpec.raw));
                    const cachedExactVersion = registrySpec.type === "version"
                        ? Package.cache.get(fullNameByNameAndVersion(registrySpec.name, registrySpec.fetchSpec))
                        : undefined;
                    if (failedSpec) {
                        dependency = failedSpec;
                    } else if (cachedExactVersion?.manifest || cachedExactVersion?.error) {
                        dependency = cachedExactVersion;
                    } else {
                        try {
                            const manifest = await Package.fetchManifest(registrySpec.raw);
                            dependency = Package.fromNameAndVersion(manifest.name, manifest.version);
                            dependency.manifest = manifest;
                        } catch (error) {
                            dependency = Package.failedSpec(registrySpec.name, registrySpec.raw, registrySpec.fetchSpec);
                            dependency.error = true;
                            dependency.failureReason = errorMessage(error);
                        }
                    }
                }

                dependency.addDependent(this, optional);
                onDependency?.(dependency);
                return dependency;
            })
        );

        this.dependencies = result;
        return result;
    }

    public toString(): string {
        return this.fullName;
    }

    private static failedSpecKey(name: string, spec: string): string {
        return `${name}\0${spec}`;
    }

    private static failedSpec(
        name: string,
        spec: string,
        version: string = spec,
        cacheInPackageCache: boolean = true
    ): Package {
        const key = Package.failedSpecKey(name, spec);
        let pkg = Package.failedSpecs.get(key);
        if (!pkg) {
            pkg = cacheInPackageCache ? Package.fromNameAndVersion(name, version) : new Package(name, version);
            Package.failedSpecs.set(key, pkg);
        }
        return pkg;
    }

    // A git/file/url/etc. spec: reported as a warning and never downloaded.
    private static skippedSpec(name: string, spec: string): Package {
        const pkg = Package.failedSpec(name, spec, spec, false);
        pkg.error = true;
        pkg.warning = true;
        pkg.failureReason = `Non-registry dependency spec "${spec}" was skipped`;
        return pkg;
    }

    // Returns the cached package instance for a name/version pair or creates it.
    public static fromNameAndVersion(name: string, version: string): Package {
        const fullName = fullNameByNameAndVersion(name, version);
        const cachedPkg = Package.cache.get(fullName);
        if (cachedPkg) {
            return cachedPkg;
        }

        const result = new Package(name, version);
        Package.cache.set(result.fullName, result);
        return result;
    }

    // Extracts the package name from a package-lock packages path.
    private static packageNameFromLockPath(packagePath: string): string | undefined {
        const nodeModulesSegment = "node_modules/";
        const nodeModulesIndex = packagePath.lastIndexOf(nodeModulesSegment);
        if (nodeModulesIndex === -1) return undefined;

        const packageName = packagePath.slice(nodeModulesIndex + nodeModulesSegment.length);
        return packageName || undefined;
    }

    private static isRegistryTarball(resolved: string): boolean {
        try {
            const url = new URL(resolved);
            return (url.protocol === "http:" || url.protocol === "https:") && url.pathname.toLowerCase().endsWith(".tgz");
        } catch (_error) {
            return false;
        }
    }

    private static lockNonRegistrySpec(name: string, lockPackage: PackageLockPackage): string | undefined {
        if (lockPackage.resolved !== undefined && !Package.isRegistryTarball(lockPackage.resolved)) {
            return lockPackage.resolved;
        }
        if (lockPackage.version !== undefined && !Package.registrySpec(name, lockPackage.version)) {
            return lockPackage.version;
        }
        return undefined;
    }

    private static lockPackageIncluded(
        lockPackage: PackageLockPackage,
        includePeerDependencies: boolean,
        includeOptionalDependencies: boolean
    ): boolean {
        if (lockPackage.link) return false;
        if (lockPackage.peer && !includePeerDependencies) return false;
        // shortcut: a flat lock can't tell the root's optionalDependencies from transitive ones, so all need --optional; walk the lock graph if root optionals must be on by default.
        if (lockPackage.optional && !includeOptionalDependencies) return false;
        return true;
    }

    // Converts package-lock entries into Package objects. Dev entries are always included, like a package.json root.
    private static collectLockPackages(
        packageLock: PackageLock,
        rootPackage: Package,
        includePeerDependencies: boolean,
        includeOptionalDependencies: boolean
    ): Package[] {
        const packages = new Map<PackageFullName, Package>();
        const addLockPackage = (name: string, version: string | undefined, optional: boolean, nonRegistrySpec?: string) => {
            if (nonRegistrySpec === undefined && !version) return;

            const pkg = nonRegistrySpec !== undefined
                ? Package.skippedSpec(name, nonRegistrySpec)
                : Package.fromNameAndVersion(name, version!);
            if (pkg.fullName === rootPackage.fullName) return;
            const existing = packages.get(pkg.fullName);
            if (existing) {
                existing.lockOptional = existing.lockOptional && optional;
                return;
            }
            pkg.lockOptional = optional;
            packages.set(pkg.fullName, pkg);
        };

        if (packageLock.packages) {
            for (const [packagePath, lockPackage] of Object.entries(packageLock.packages)) {
                if (packagePath === "") continue;
                if (!Package.lockPackageIncluded(lockPackage, includePeerDependencies, includeOptionalDependencies)) {
                    continue;
                }

                const packageName = lockPackage.name ?? Package.packageNameFromLockPath(packagePath);
                if (!packageName) continue;

                const nonRegistrySpec = Package.lockNonRegistrySpec(packageName, lockPackage);
                addLockPackage(packageName, lockPackage.version, Boolean(lockPackage.optional), nonRegistrySpec);
            }
        } else if (packageLock.dependencies) {
            const collectVersion1Dependencies = (dependencies: Record<string, PackageLockDependency>) => {
                for (const [packageName, dependency] of Object.entries(dependencies)) {
                    if (!Package.lockPackageIncluded(dependency, includePeerDependencies, includeOptionalDependencies)) {
                        continue;
                    }

                    const nonRegistrySpec = Package.lockNonRegistrySpec(packageName, dependency);
                    addLockPackage(packageName, dependency.version, Boolean(dependency.optional), nonRegistrySpec);

                    if (dependency.dependencies) {
                        collectVersion1Dependencies(dependency.dependencies);
                    }
                }
            };

            collectVersion1Dependencies(packageLock.dependencies);
        }

        return [...packages.values()];
    }

    // Creates a root package from parsed package-lock.json data; its entries are collected in getDependencies.
    private static fromPackageLock(packageLock: PackageLock): Package {
        const rootPackage = Package.fromNameAndVersion(packageLock.name ?? "package-lock-root", packageLock.version ?? "0.0.0");
        rootPackage.isRootPackage = true;
        rootPackage.packageLock = packageLock;
        Program.packageLockMode = true;
        return rootPackage;
    }

    // Creates a package from a package.json / package-lock.json path or an npm package spec.
    static async fromString(packageNameInAnyFormat: string): Promise<Package> {
        try {
            if (fs.existsSync(packageNameInAnyFormat)) {
                const filePath = path.resolve(packageNameInAnyFormat);
                if (!(await fsPromises.stat(filePath)).isFile()) {
                    throw new PackageSpecError(
                        "A package.json or package-lock.json file path is required; directories are not registry specs",
                        "invalid"
                    );
                }

                const parsed = JSON.parse(await fsPromises.readFile(filePath, "utf8"));
                if (typeof parsed?.lockfileVersion === "number") {
                    console.log(`${packageNameInAnyFormat} is a lock file, using exact locked versions`);
                    return Package.fromPackageLock(parsed as PackageLock);
                }

                console.log(`${packageNameInAnyFormat} is a file, using as package.json`);
                const packageJson = parsed as RegistryManifest;
                packageJson.name ||= path.basename(path.dirname(filePath));
                Program.packageJsonMode = true;
                const pkg = Package.fromNameAndVersion(packageJson.name, packageJson.version ?? "0.0.0");
                pkg.manifest = packageJson;
                pkg.isRootPackage = true;
                return pkg;
            }

            const registrySpec = Package.registrySpec("", packageNameInAnyFormat);
            if (!registrySpec) {
                throw new PackageSpecError(
                    `Invalid or non-registry package spec "${packageNameInAnyFormat}"`,
                    "invalid"
                );
            }

            try {
                const manifest = await Package.fetchManifest(registrySpec.raw);
                const pkg = Package.fromNameAndVersion(manifest.name, manifest.version);
                pkg.manifest = manifest;
                pkg.isRootPackage = true;
                return pkg;
            } catch (error) {
                throw new PackageSpecError(errorMessage(error), "resolve");
            }
        } catch (ex) {
            if (ex instanceof PackageSpecError) throw ex;
            throw new PackageSpecError(`Failed to read "${packageNameInAnyFormat}": ${errorMessage(ex)}`, "invalid");
        }
    }
}
