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
    public dependencies: Package[] = [];
    public dependents: Package[] = [];
    public error: boolean = false;
    public existsInRegistry: TriState = TriStates.UNKNOWN;
    public loading: boolean = false;
    public name: string;
    public resolved: boolean = false;
    public version: string;

    static cache = new Map<PackageFullName, Package>();

    public get isRoot(): boolean {
        return this.dependents.length === 0;
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

    // Downloads this package tarball unless it is the root package in file-based mode.
    public async download(): Promise<void> {
        if (!this.fullName) {
            throw "Not enough data to download tgz file - missing or invalid package name or version";
        }
        if ((Program.packageJsonMode || Program.packageLockMode) && this.isRoot) return;

        let triesCount = 0;
        do {
            try {
                const downloadPath = `./${this.normalizedNameForPath}-${this.version}.tgz`;
                if (fs.existsSync(downloadPath)) return;
                await pacote.tarball.file(this.fullName, downloadPath);

                Program.downloadedPackagesPath.add(downloadPath);
                break;
            } catch (err) {
                console.log(`Failed downloading - ${err}. Retrying...`);
            }
        } while (++triesCount < Package.MAX_TRIES);
        if (triesCount === Package.MAX_TRIES)
            throw new Error(`Downloading ${this} failed, Reached maximum retry attempts`);
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
            .manifest(Program.packageJsonMode && this.isRoot ? path.dirname(this.packageJson) : this.fullName)
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

        if (
            !responseBodyAsJSON.dependencies &&
            !responseBodyAsJSON.devDependencies &&
            !responseBodyAsJSON.peerDependencies &&
            !responseBodyAsJSON.optionalDependencies
        ) {
            // special case: dependencies node doesn't exist, but tarball exists.
            return [];
        }

        const selectedDependencies = Object.entries(responseBodyAsJSON.dependencies ?? {});

        if (includeDevDependencies && responseBodyAsJSON.devDependencies) {
            selectedDependencies.push(...Object.entries(responseBodyAsJSON.devDependencies));
        }

        if (includePeerDependencies && responseBodyAsJSON.peerDependencies) {
            selectedDependencies.push(
                ...Object.entries(responseBodyAsJSON.peerDependencies).filter(
                    // Ignore peer dependencies marked as optional, just as npm does
                    ([peer, _ver]) => !responseBodyAsJSON.peerDependenciesMeta?.[peer]?.optional
                )
            );
        }

        if (includeOptionalDependencies && responseBodyAsJSON.optionalDependencies) {
            selectedDependencies.push(
                ...Object.entries(responseBodyAsJSON.optionalDependencies),
                // Include "optional" peer dependencies
                ...Object.entries(responseBodyAsJSON.peerDependencies ?? {})
            );
        }

        const result: Package[] = [];
        for (const [depName, depVersion] of selectedDependencies) {
            const { raw: packageString } = npa.resolve(depName, depVersion);
            if (!packageString) continue;

            const dependency = await Package.fromString(packageString);
            if (!dependency) continue;
            // check for cyclic dependency (I.E. https://registry.npmjs.org/@types/koa-compose/latest)
            if (this.isAncestorEqual(dependency)) continue;

            dependency.addDependent(this);
            result.push(dependency);
        }

        this.dependencies = result;
        return result;
    }

    public isAncestorEqual(pkg: Package): boolean {
        if (pkg.isEqual(this)) {
            return true;
        }
        if (this.isRoot) {
            return false;
        }
        return this.dependents.some((dependent) => dependent.isAncestorEqual(pkg));
    }

    public isEqual(pkg: Package): boolean {
        return pkg.fullName === this.fullName;
    }

    public toString(): string {
        return this.fullName;
    }

    // Restores previously resolved packages into cache so reruns can skip finished work.
    static async fillCacheByFullNames(fullNames: PackageFullName[]) {
        for (const fullName of fullNames) {
            const pkg = await Package.fromString(fullName);
            if (pkg === undefined) continue;
            pkg.resolved = true;
            Package.cache.set(fullName, pkg);
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

    // Creates a package from a package.json path or an npm package spec.
    static async fromString(packageNameInAnyFormat: string): Promise<Package | undefined> {
        try {
            // Treat as path to package.json
            if (fs.existsSync(packageNameInAnyFormat)) {
                console.log(`${packageNameInAnyFormat} is a file, using as package.json`);
                Program.packageJsonMode = true;

                const packageJsonFile = (await fsPromises.readFile(packageNameInAnyFormat)).toString();
                const packageJson = JSON.parse(packageJsonFile) as Manifest;
                if (!packageJson.name) throw new Error("Invalid package.json format, missing or invalid name");

                const pkg = Package.fromNameAndVersion(packageJson.name, packageJson.version ?? LATEST);
                pkg.packageJson = path.resolve(packageNameInAnyFormat);
                return pkg;
            }
            // Validate package name and version
            npa(packageNameInAnyFormat);

            const { name, version } = await pacote.manifest(packageNameInAnyFormat);
            return Package.fromNameAndVersion(name, version);
        } catch (ex) {
            const reason = ex instanceof Error ? ex.message : String(ex);
            console.error(`Failed to resolve package spec or package.json "${packageNameInAnyFormat}": ${reason}`);
            return undefined;
        }
    }
}
