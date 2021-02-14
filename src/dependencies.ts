import { exec, ExecException } from "child_process";
import EventEmitter from "events";
import Package, { PackageFullName } from "./package";
export enum Events {
    PACKAGE_DISCOVERED = "package_discovered",
    PACKAGE_RESOLVED = "package_resolved",
}
export default class Dependencies extends EventEmitter {

    rootPackage: Package;

    async loadRecursive(pkg: Package, level: number, depth: number) {
        console.log(`requested ${pkg}, level: ${level}, depth: ${depth}`);
        try {
            const dependencies = await pkg?.getDependencies();
            if (dependencies === undefined) {
                return; // TODO: log.
            }
            if (dependencies!.length == 0 || level === depth) {
                this.resolveRecursive(pkg);
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
        } catch (err) {
            throw err;

        }
    }
    resolveRecursive(pkg: Package) {
        // console.log(`${pkg} resolved`);
        this.emit(Events.PACKAGE_RESOLVED, pkg);
        pkg.resolved = true;
        pkg.loading = false;
        for (const dependent of pkg.dependents) {
            if(dependent.dependencies.every((dependency) => dependency.resolved)) {
                this.resolveRecursive(dependent);
            }
        }
    }
    outputResolved(depPkg: Package) {

    }
    async load(depth: number) {
        await this.loadRecursive(this.rootPackage, 0, depth);
    }

    // async downloadAll() {
    //     this.dependencies.forEach((_, pkgName) => { exec(`npm pack ${pkgName}`) });
    // }

    constructor(rootPackage: Package) {
        super();
        this.rootPackage = rootPackage;
    }

}