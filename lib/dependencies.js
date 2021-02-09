"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const child_process_1 = require("child_process");
class Dependencies {
    constructor(rootPackage) {
        this.rootPackage = rootPackage;
        this.dependencies = new Map();
        this.addDependency(this.rootPackage);
    }
    addDependency(depPackage) {
        if (!this.dependencies.has(depPackage.fullName)) {
            this.dependencies.set(depPackage.fullName, depPackage);
            return true;
        }
        return false;
    }
    async loadRecursive(pkg, level, depth) {
        console.log(`requested ${pkg}, level: ${level}, depth: ${depth}`);
        const dependencies = await pkg?.getDependencies();
        if (dependencies === undefined)
            return;
        for (const depPkg of dependencies) {
            const added = this.addDependency(depPkg);
            if (added && level < depth) {
                await this.loadRecursive(depPkg, level + 1, depth);
            }
        }
    }
    async load(depth) {
        await this.loadRecursive(this.rootPackage, 0, depth);
    }
    async downloadAll() {
        this.dependencies.forEach((_, pkgName) => { child_process_1.exec(`npm pack ${pkgName}`); });
    }
}
exports.default = Dependencies;
//# sourceMappingURL=dependencies.js.map