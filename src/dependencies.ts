import EventEmitter from "events";
import Package from "./package";
import { TriStates } from "./tristate";
export enum Events {
    PACKAGE_DISCOVERED = "package_discovered",
    PACKAGE_RESOLVED = "package_resolved",
    PACKAGE_DOWNLOAD_ERROR = "package_download_error",
    PACKAGE_RESOLVE_ERROR = "package_resolve_error"
}
export type ResolveAction = (pkg: Package) => Promise<boolean>;
export default class Dependencies extends EventEmitter {
    rootPackage: Package;
    async loadRecursive(pkg: Package, level: number, depth: number) {
        console.log(`requested ${pkg}, level: ${level}, depth: ${depth}`);
        let dependencies: Package[] = [];
        try {
            dependencies = await pkg?.getDependencies();
        }
        catch (err) {
            pkg.error = true;
            this.emit(Events.PACKAGE_RESOLVE_ERROR, pkg);
            return;
        }
        if (dependencies.every(dep => dep.resolved) || dependencies!.length == 0 || level === depth) {
            await this.resolveRecursive(pkg);
            return;
        }
        const loadPromises = [];
        for (const depPkg of dependencies) {
            if (!depPkg.loading && !depPkg.resolved) {
                this.emit(Events.PACKAGE_DISCOVERED, depPkg);
                const loadPromise = this.loadRecursive(depPkg, level + 1, depth);
                loadPromises.push(loadPromise);
            }
        }
        await Promise.all(loadPromises);
    }
    async resolveRecursive(pkg: Package) {
        if(pkg.error) return;
        if(pkg.existsInRegistry || pkg.existsInRegistry === TriStates.UNKNOWN) { // TODO: make sure existance determined before reaching this line
            try {
                await pkg.download();
            } catch (ex) {
                this.emit(Events.PACKAGE_DOWNLOAD_ERROR, pkg);
                return;
            }
        }
        this.emit(Events.PACKAGE_RESOLVED, pkg);

        pkg.resolved = true;
        pkg.loading = false;
        for (const dependent of pkg.dependents) {
            if (dependent.dependencies.every((dependency) => dependency.resolved)) {
                await this.resolveRecursive(dependent);
            }
        }
    }
    async load(depth: number) {
        await this.loadRecursive(this.rootPackage, 0, depth);
    }

    constructor(rootPackage: Package) {
        super();
        this.rootPackage = rootPackage;
    }

}