import { exec, ExecException } from "child_process";
import Package, { PackageFullName } from "./package";

export default class Dependencies {
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
        console.log(`requested ${pkg}, level: ${level}, depth: ${depth}`);
        const dependencies = await pkg?.getDependencies();
        if(dependencies === undefined) return;
        for (const depPkg of dependencies) {
            const added = this.addDependency(depPkg);
            if(added && level < depth) {
                await this.loadRecursive(depPkg, level + 1, depth)
            }
        }
    }
    async load(depth: number) {
        await this.loadRecursive(this.rootPackage ,0, depth);
    }
    
    async downloadAll() {
        this.dependencies.forEach((_, pkgName) => { exec(`npm pack ${pkgName}`) });
    }

    constructor(rootPackage: Package) {
        this.rootPackage = rootPackage;
        this.dependencies = new Map();
        this.addDependency(this.rootPackage);
    }

}