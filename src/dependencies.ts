import EventEmitter from "node:events";
import type Package from "./package.js";
import { TriStates } from "./tristate.js";

export const Events = {
    PACKAGE_DISCOVERED: "package_discovered",
    PACKAGE_RESOLVED: "package_resolved",
    PACKAGE_DOWNLOAD_ERROR: "package_download_error",
    PACKAGE_RESOLVE_ERROR: "package_resolve_error",
} as const;

export default class Dependencies extends EventEmitter {
    rootPackage: Package;

    async loadRecursive(
        pkg: Package,
        level: number,
        depth: number,
        loadDevDependencies: boolean,
        loadPeerDependencies: boolean,
        loadOptionalDependencies: boolean
    ) {
        // ------------------- UI -------------------
        const dependentOrDependentsStr = pkg.dependentOrDependentsToString();
        console.log(`requested ${pkg} by ${dependentOrDependentsStr || "you"}`);
        // ------------------------------------------
        let dependencies: Package[] = [];
        try {
            dependencies = await pkg.getDependencies(
                loadDevDependencies,
                loadPeerDependencies,
                loadOptionalDependencies
            );
        } catch (_err) {
            pkg.error = true;
            this.emit(Events.PACKAGE_RESOLVE_ERROR, pkg);
            return;
        }
        if (dependencies.every((dep) => dep.resolved) || dependencies?.length === 0 || level === depth) {
            await this.resolveRecursive(pkg);
            return;
        }
        const loadPromises = [];
        for (const depPkg of dependencies) {
            if (!depPkg.loading && !depPkg.resolved) {
                this.emit(Events.PACKAGE_DISCOVERED, depPkg);
                const loadPromise = this.loadRecursive(
                    depPkg,
                    level + 1,
                    depth,
                    false,
                    loadPeerDependencies,
                    loadOptionalDependencies
                );
                loadPromises.push(loadPromise);
            }
        }
        await Promise.all(loadPromises);
    }

    async resolveRecursive(pkg: Package) {
        // `resolving` is set before the first await. Otherwise two dependents finishing at the same time
        // both pass the `resolved` check and the package is downloaded and reported twice.
        if (pkg.error || pkg.resolved || pkg.resolving) return;
        pkg.resolving = true;
        if (pkg.existsInRegistry || pkg.existsInRegistry === TriStates.UNKNOWN) {
            try {
                await pkg.download();
            } catch (_ex) {
                pkg.resolving = false;
                this.emit(Events.PACKAGE_DOWNLOAD_ERROR, pkg);
                return;
            }
        }
        this.emit(Events.PACKAGE_RESOLVED, pkg);

        pkg.resolved = true;
        pkg.resolving = false;
        pkg.loading = false;
        for (const dependent of pkg.dependents) {
            if (dependent.dependencies.every((dependency) => dependency.resolved)) {
                await this.resolveRecursive(dependent);
            }
        }
    }

    async load(
        depth: number,
        loadDevDependencies: boolean,
        loadPeerDependencies: boolean,
        loadOptionalDependencies: boolean
    ) {
        await this.loadRecursive(
            this.rootPackage,
            0,
            depth,
            loadDevDependencies,
            loadPeerDependencies,
            loadOptionalDependencies
        );
    }

    constructor(rootPackage: Package) {
        super();
        this.rootPackage = rootPackage;
    }
}
