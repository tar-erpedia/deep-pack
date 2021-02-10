import { exec, ExecException } from "child_process";
import EventEmitter from "events";
import Package, { PackageFullName } from "./package";
export enum Events {
    PACKAGE_RESOLVED = "package_resolved"
}
export default class Dependencies extends EventEmitter {
    dependencies: Map<PackageFullName, Package>;
    rootPackage: Package;

    addDependency(depPackage: Package): boolean {
        if (!this.dependencies.has(depPackage.fullName)) {
            this.dependencies.set(depPackage.fullName, depPackage);
            return true;
        }
        return false;
    }
    async loadRecursive(pkg: Package, level: number, depth: number) {
        // console.log(`requested ${pkg}, level: ${level}, depth: ${depth}`);
        try {
            const dependencies = await pkg?.getDependencies();
            if (dependencies === undefined) {
                return; // TODO: log.
            }
            if(dependencies!.length == 1) {
                this.resolveRecursive(pkg);
            }
            const loadPromises = [];
            for (const depPkg of dependencies) {
                const added = this.addDependency(depPkg);
                if (added && level < depth) {
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
        this.emit("package_resolved", pkg);
        pkg.resolved = true;
        if(pkg !== this.rootPackage && pkg.siblings.every((sibling) => sibling.resolved)) {
            this.resolveRecursive(pkg.dependent!);
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
        this.dependencies = new Map();
        this.addDependency(this.rootPackage);
    }

}