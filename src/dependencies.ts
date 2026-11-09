import EventEmitter from "node:events";
import type Package from "./package.js";
import Program from "./program.js";

export const Events = {
    PACKAGE_DISCOVERED: "package_discovered",
    PACKAGE_RESOLVED: "package_resolved",
    PACKAGE_DOWNLOAD_ERROR: "package_download_error",
    PACKAGE_RESOLVE_ERROR: "package_resolve_error",
} as const;

export default class Dependencies extends EventEmitter {
    rootPackage: Package;
    private readonly visited = new Map<string, number>();

    private reportUnexpectedFailure(pkg: Package, error: unknown) {
        pkg.error = true;
        pkg.failureReason ??= error instanceof Error ? error.message : String(error);
        try {
            this.emit(Events.PACKAGE_RESOLVE_ERROR, pkg);
        } catch (reportError) {
            console.error(`Failed to report ${pkg}: ${reportError instanceof Error ? reportError.message : String(reportError)}`);
        }
    }

    async loadRecursive(
        pkg: Package,
        level: number,
        depth: number,
        loadDevDependencies: boolean,
        loadDevDependenciesRecursively: boolean,
        loadPeerDependencies: boolean,
        loadOptionalDependencies: boolean
    ) {
        const shallowestLevel = this.visited.get(pkg.fullName);
        if (shallowestLevel !== undefined && level >= shallowestLevel) return;
        this.visited.set(pkg.fullName, level);

        const dependentOrDependentsStr = pkg.dependentOrDependentsToString();
        console.log(`requested ${pkg} by ${dependentOrDependentsStr || "you"}`);

        if (pkg.error) {
            this.emit(Events.PACKAGE_RESOLVE_ERROR, pkg);
            return;
        }

        try {
            await pkg.download();
            this.emit(Events.PACKAGE_RESOLVED, pkg);
        } catch (error) {
            pkg.error = true;
            pkg.failureReason = error instanceof Error ? error.message : String(error);
            this.emit(Events.PACKAGE_DOWNLOAD_ERROR, pkg);
        }

        const childLoads: Promise<void>[] = [];
        const canDescend = Program.packageLockMode || level < depth;
        if (!canDescend) return;

        try {
            const includeDevDependencies = loadDevDependenciesRecursively ||
                (pkg === this.rootPackage && loadDevDependencies);
            await pkg.getDependencies(
                includeDevDependencies,
                loadPeerDependencies,
                loadOptionalDependencies,
                (dependency) => {
                    if (!this.visited.has(dependency.fullName)) {
                        this.emit(Events.PACKAGE_DISCOVERED, dependency);
                    }
                    const childLoad = this.loadRecursive(
                            dependency,
                            level + 1,
                            depth,
                            loadDevDependencies,
                            loadDevDependenciesRecursively,
                            loadPeerDependencies,
                            loadOptionalDependencies
                        ).catch((error: unknown) => {
                            this.reportUnexpectedFailure(dependency, error);
                        });
                    childLoads.push(childLoad);
                }
            );
        } catch (error) {
            await Promise.all(childLoads);
            pkg.error = true;
            pkg.failureReason ??= error instanceof Error ? error.message : String(error);
            this.emit(Events.PACKAGE_RESOLVE_ERROR, pkg);
            return;
        }

        // A depth of 1 includes direct dependencies of the root (level 1), but not their children.
        await Promise.all(childLoads);
    }

    async load(
        depth: number,
        loadDevDependencies: boolean,
        loadDevDependenciesRecursively: boolean,
        loadPeerDependencies: boolean,
        loadOptionalDependencies: boolean
    ) {
        await this.loadRecursive(
            this.rootPackage,
            0,
            depth,
            loadDevDependencies,
            loadDevDependenciesRecursively,
            loadPeerDependencies,
            loadOptionalDependencies
        );
    }

    constructor(rootPackage: Package) {
        super();
        this.rootPackage = rootPackage;
        this.rootPackage.isRootPackage = true;
    }
}
