/// <reference path="../types/package.d.ts" />

import npa from "npm-package-arg";
import pacote from "pacote";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import Program from "./program.js";

// Fix pacote types missing key - peerDependenciesMeta
declare module "pacote" {
    interface ManifestResult {
        peerDependenciesMeta: Record<string, { optional: boolean }> | null;
    }
}

const LATEST: PackageVersion = "latest";
const REGISTRY_SPEC_TYPES = new Set(["range", "version", "tag"]);
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
    packages?: Record<string, PackageLockPackage>;
    dependencies?: Record<string, PackageLockDependency>;
}

interface RegistrySpec {
    name: string;
    spec: string;
    version: string;
    type: string;
}

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

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

class Semaphore {
    private active = 0;
    private waiters: Array<() => void> = [];

    constructor(private readonly limit: number) {}

    async run<T>(operation: () => Promise<T>): Promise<T> {
        if (this.active >= this.limit) {
            await new Promise<void>((resolve) => this.waiters.push(resolve));
        } else {
            this.active++;
        }

        try {
            return await operation();
        } finally {
            const next = this.waiters.shift();
            if (next) {
                next();
            } else {
                this.active--;
            }
        }
    }
}

export default class Package {
    static readonly MAX_TRIES: number = 3;
    static readonly MAX_CONCURRENT_NETWORK_OPERATIONS: number = 16;
    private static readonly networkLimiter = new Semaphore(Package.MAX_CONCURRENT_NETWORK_OPERATIONS);
    private static readonly pendingManifests = new Map<string, Promise<RegistryManifest>>();
    private static readonly failedSpecs = new Map<string, Package>();
    private static readonly downloadsByPath = new Map<string, { fullName: string; promise: Promise<number> }>();

    public dependencies: Package[] = [];
    public dependents: Package[] = [];
    public error: boolean = false;
    public failureReason: string | undefined;
    public isRootPackage: boolean = false;
    public lockOptional: boolean = false;
    public manifest: RegistryManifest | undefined;
    public name: string;
    public optionalEdge: boolean | undefined;
    public version: string;
    public warning: boolean = false;

    static cache = new Map<PackageFullName, Package>();

    public get isRoot(): boolean {
        return this.isRootPackage;
    }

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

    private static async withNetworkRetries<T>(operation: () => Promise<T>, context: string): Promise<T> {
        let lastError: unknown;
        for (let attempt = 1; attempt <= Package.MAX_TRIES; attempt++) {
            try {
                return await Package.networkLimiter.run(operation);
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
            if (parsed.type === "alias") {
                const subSpec = (parsed as typeof parsed & { subSpec?: { type: string; name?: string; raw: string; fetchSpec?: string | null } }).subSpec;
                if (!subSpec || !subSpec.name || !REGISTRY_SPEC_TYPES.has(subSpec.type)) return undefined;
                return {
                    name: subSpec.name,
                    spec: subSpec.raw,
                    version: subSpec.fetchSpec ?? spec,
                    type: subSpec.type,
                };
            }
            const packageName = parsed.name ?? name;
            if (!packageName || !REGISTRY_SPEC_TYPES.has(parsed.type)) return undefined;
            return {
                name: packageName,
                spec: parsed.raw,
                version: parsed.fetchSpec ?? spec,
                type: parsed.type,
            };
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
        if ((Program.packageJsonMode || Program.packageLockMode) && this.isRoot) return;

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
            const dependencies = this.isRoot ? this.dependencies : [];
            dependencies.forEach((dependency) => onDependency?.(dependency));
            return dependencies;
        }

        let responseBodyAsJSON = this.manifest;
        if (!responseBodyAsJSON) {
            try {
                responseBodyAsJSON = await Package.fetchManifest(this.fullName);
                this.manifest = responseBodyAsJSON;
            } catch (error) {
                this.error = true;
                this.failureReason = errorMessage(error);
                throw error;
            }
        }

        const isPackageJsonRoot = Program.packageJsonMode && this.isRoot;
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

        for (const [name, spec] of Object.entries(responseBodyAsJSON.dependencies ?? {})) {
            select(name, spec, "dependency", false);
        }

        if (includePeerDependencies) {
            const peerMeta = responseBodyAsJSON.peerDependenciesMeta as
                | Record<string, { optional?: boolean }>
                | null
                | undefined;
            for (const [name, spec] of Object.entries(responseBodyAsJSON.peerDependencies ?? {})) {
                if (!peerMeta?.[name]?.optional) {
                    select(name, spec, "peer", false);
                } else if (includeOptionalDependencies && this.isRoot) {
                    select(name, spec, "peer", true);
                }
            }
        }

        if (includeDev) {
            for (const [name, spec] of Object.entries(responseBodyAsJSON.devDependencies ?? {})) {
                select(name, spec, "dev", false);
            }
        }

        if (includeOptional) {
            for (const [name, spec] of Object.entries(responseBodyAsJSON.optionalDependencies ?? {})) {
                select(name, spec, "optional", true);
            }
        }

        const result = await Promise.all(
            [...selectedDependencies.values()].map(async ({ name, spec, optional }) => {
                const registrySpec = Package.registrySpec(name, spec);
                let dependency: Package;
                if (!registrySpec) {
                    dependency = Package.failedSpec(name, spec, spec, false);
                    dependency.addDependent(this, optional);
                    if (!dependency.error) {
                        dependency.error = true;
                        dependency.warning = true;
                        dependency.failureReason = `Non-registry dependency spec "${spec}" was skipped`;
                    }
                } else {
                    const failedSpec = Package.failedSpecs.get(Package.failedSpecKey(registrySpec.name, registrySpec.spec));
                    const cachedExactVersion = registrySpec.type === "version"
                        ? Package.cache.get(fullNameByNameAndVersion(registrySpec.name, registrySpec.version))
                        : undefined;
                    if (failedSpec) {
                        dependency = failedSpec;
                        dependency.addDependent(this, optional);
                    } else if (cachedExactVersion?.manifest || cachedExactVersion?.error) {
                        dependency = cachedExactVersion;
                        dependency.addDependent(this, optional);
                    } else {
                        try {
                            const manifest = await Package.fetchManifest(registrySpec.spec);
                            dependency = Package.fromNameAndVersion(manifest.name, manifest.version);
                            dependency.manifest = manifest;
                            dependency.addDependent(this, optional);
                        } catch (error) {
                            dependency = Package.failedSpec(registrySpec.name, registrySpec.spec, registrySpec.version);
                            dependency.addDependent(this, optional);
                            dependency.error = true;
                            dependency.failureReason = errorMessage(error);
                        }
                    }
                }

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
        includeDevDependencies: boolean,
        includePeerDependencies: boolean,
        includeOptionalDependencies: boolean
    ): boolean {
        if (lockPackage.link) return false;
        if (lockPackage.peer && !includePeerDependencies) return false;
        if (lockPackage.optional && !includeOptionalDependencies) return false;
        if (lockPackage.dev && !includeDevDependencies) return false;
        if (lockPackage.devOptional && (!includeDevDependencies || !includeOptionalDependencies)) return false;
        return true;
    }

    // Converts package-lock entries into Package objects, optionally including dev/optional packages.
    private static collectLockPackages(
        packageLock: PackageLock,
        rootPackage: Package,
        includeDevDependencies: boolean,
        includePeerDependencies: boolean,
        includeOptionalDependencies: boolean
    ): Package[] {
        const packages = new Map<PackageFullName, Package>();
        const addLockPackage = (name: string, version: string | undefined, optional: boolean, nonRegistrySpec?: string) => {
            if (nonRegistrySpec === undefined && !version) return;

            const pkg = nonRegistrySpec !== undefined
                ? Package.failedSpec(name, nonRegistrySpec, nonRegistrySpec, false)
                : Package.fromNameAndVersion(name, version!);
            if (pkg.fullName === rootPackage.fullName) return;
            if (nonRegistrySpec !== undefined) {
                pkg.error = true;
                pkg.warning = true;
                pkg.failureReason = `Non-registry dependency spec "${nonRegistrySpec}" was skipped`;
            }
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
                if (
                    !Package.lockPackageIncluded(
                        lockPackage,
                        includeDevDependencies,
                        includePeerDependencies,
                        includeOptionalDependencies
                    )
                ) {
                    continue;
                }

                const packageName = lockPackage.name ?? Package.packageNameFromLockPath(packagePath);
                if (!packageName) continue;

                const nonRegistrySpec = Package.lockNonRegistrySpec(packageName, lockPackage);
                addLockPackage(
                    packageName,
                    lockPackage.version,
                    Boolean(lockPackage.optional || lockPackage.devOptional),
                    nonRegistrySpec
                );
            }
        } else if (packageLock.dependencies) {
            const collectVersion1Dependencies = (dependencies: Record<string, PackageLockDependency>) => {
                for (const [packageName, dependency] of Object.entries(dependencies)) {
                    if (
                        !Package.lockPackageIncluded(
                            dependency,
                            includeDevDependencies,
                            includePeerDependencies,
                            includeOptionalDependencies
                        )
                    ) {
                        continue;
                    }

                    const nonRegistrySpec = Package.lockNonRegistrySpec(packageName, dependency);
                    addLockPackage(
                        packageName,
                        dependency.version,
                        Boolean(dependency.optional || dependency.devOptional),
                        nonRegistrySpec
                    );

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
        includeDevDependencies: boolean = false,
        includePeerDependencies: boolean = true,
        includeOptionalDependencies: boolean = false
    ): Promise<Package> {
        let packageLock: PackageLock;
        try {
            const packageLockFile = (await fsPromises.readFile(packageLockPath)).toString();
            const parsed: unknown = JSON.parse(packageLockFile);
            if (!isObjectRecord(parsed)) {
                throw new Error("package-lock.json must contain a JSON object");
            }
            if (parsed.name !== undefined && typeof parsed.name !== "string") {
                throw new Error("package-lock.json has an invalid package name");
            }
            if (parsed.version !== undefined && typeof parsed.version !== "string") {
                throw new Error("package-lock.json has an invalid package version");
            }
            if (parsed.packages !== undefined && !isObjectRecord(parsed.packages)) {
                throw new Error("package-lock.json has an invalid packages map");
            }
            if (parsed.dependencies !== undefined && !isObjectRecord(parsed.dependencies)) {
                throw new Error("package-lock.json has an invalid dependencies map");
            }

            const validateLockPackage = (entry: unknown, includeDependencies: boolean): void => {
                if (!isObjectRecord(entry)) {
                    throw new Error("package-lock.json contains an invalid package entry");
                }
                for (const field of ["name", "version", "resolved"] as const) {
                    if (entry[field] !== undefined && typeof entry[field] !== "string") {
                        throw new Error(`package-lock.json contains an invalid ${field}`);
                    }
                }
                for (const field of ["link", "dev", "devOptional", "optional", "peer"] as const) {
                    if (entry[field] !== undefined && typeof entry[field] !== "boolean") {
                        throw new Error(`package-lock.json contains an invalid ${field} flag`);
                    }
                }
                if (includeDependencies && entry.dependencies !== undefined) {
                    if (!isObjectRecord(entry.dependencies)) {
                        throw new Error("package-lock.json contains an invalid dependencies map");
                    }
                    for (const dependency of Object.values(entry.dependencies)) {
                        validateLockPackage(dependency, true);
                    }
                }
            };

            for (const lockPackage of Object.values((parsed.packages ?? {}) as Record<string, unknown>)) {
                validateLockPackage(lockPackage, false);
            }
            for (const lockPackage of Object.values((parsed.dependencies ?? {}) as Record<string, unknown>)) {
                validateLockPackage(lockPackage, true);
            }

            packageLock = parsed as PackageLock;
        } catch (ex) {
            throw new PackageSpecError(
                `Failed to read package-lock.json from "${packageLockPath}": ${errorMessage(ex)}`,
                "invalid"
            );
        }

        try {
            const rootName = packageLock.name ?? "package-lock-root";
            const rootVersion = packageLock.version ?? "0.0.0";
            const rootPackage = Package.fromNameAndVersion(rootName, rootVersion);
            rootPackage.isRootPackage = true;
            rootPackage.dependencies = Package.collectLockPackages(
                packageLock,
                rootPackage,
                includeDevDependencies,
                includePeerDependencies,
                includeOptionalDependencies
            );

            for (const dependency of rootPackage.dependencies) {
                dependency.addDependent(rootPackage, dependency.lockOptional);
            }

            Program.packageLockMode = true;
            return rootPackage;
        } catch (error) {
            throw new PackageSpecError(`Invalid package-lock.json: ${errorMessage(error)}`, "invalid");
        }
    }

    // Creates a package from a package.json path or an npm package spec.
    static async fromString(packageNameInAnyFormat: string): Promise<Package> {
        try {
            if (fs.existsSync(packageNameInAnyFormat)) {
                const packageJsonPath = path.resolve(packageNameInAnyFormat);
                if (!(await fsPromises.stat(packageJsonPath)).isFile()) {
                    throw new PackageSpecError(
                        "A package.json file path is required; directories are not registry specs",
                        "invalid"
                    );
                }

                console.log(`${packageNameInAnyFormat} is a file, using as package.json`);
                const packageJsonFile = (await fsPromises.readFile(packageJsonPath)).toString();
                const parsed: unknown = JSON.parse(packageJsonFile);
                if (!isObjectRecord(parsed)) {
                    throw new PackageSpecError("Invalid package.json format", "invalid");
                }

                const packageJson = parsed as unknown as RegistryManifest;
                if (packageJson.name !== undefined && (typeof packageJson.name !== "string" || !packageJson.name)) {
                    throw new PackageSpecError("Invalid package.json format, invalid name", "invalid");
                }
                packageJson.name ??= path.basename(path.dirname(packageJsonPath));
                if (packageJson.version !== undefined && typeof packageJson.version !== "string") {
                    throw new PackageSpecError("Invalid package.json format, invalid version", "invalid");
                }
                for (const dependencyField of [
                    "dependencies",
                    "devDependencies",
                    "peerDependencies",
                    "optionalDependencies",
                ] as const) {
                    const dependencies = parsed[dependencyField];
                    if (dependencies === undefined) continue;
                    if (!isObjectRecord(dependencies) || Object.values(dependencies).some((spec) => typeof spec !== "string")) {
                        throw new PackageSpecError(`Invalid package.json format, invalid ${dependencyField}`, "invalid");
                    }
                }

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
                const manifest = await Package.fetchManifest(registrySpec.spec);
                const pkg = Package.fromNameAndVersion(manifest.name, manifest.version);
                pkg.manifest = manifest;
                pkg.isRootPackage = true;
                return pkg;
            } catch (error) {
                throw new PackageSpecError(errorMessage(error), "resolve");
            }
        } catch (ex) {
            if (ex instanceof PackageSpecError) throw ex;
            throw new PackageSpecError(errorMessage(ex), "invalid");
        }
    }
}
