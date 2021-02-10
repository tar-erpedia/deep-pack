"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Events = void 0;
const events_1 = __importDefault(require("events"));
var Events;
(function (Events) {
    Events["PACKAGE_RESOLVED"] = "package_resolved";
})(Events = exports.Events || (exports.Events = {}));
class Dependencies extends events_1.default {
    // async downloadAll() {
    //     this.dependencies.forEach((_, pkgName) => { exec(`npm pack ${pkgName}`) });
    // }
    constructor(rootPackage) {
        super();
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
        // console.log(`requested ${pkg}, level: ${level}, depth: ${depth}`);
        try {
            const dependencies = await pkg?.getDependencies();
            if (dependencies === undefined) {
                return; // TODO: log.
            }
            if (dependencies.length == 1) {
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
        }
        catch (err) {
            throw err;
        }
    }
    resolveRecursive(pkg) {
        // console.log(`${pkg} resolved`);
        this.emit("package_resolved", pkg);
        pkg.resolved = true;
        if (pkg !== this.rootPackage && pkg.siblings.every((sibling) => sibling.resolved)) {
            this.resolveRecursive(pkg.dependent);
        }
    }
    outputResolved(depPkg) {
    }
    async load(depth) {
        await this.loadRecursive(this.rootPackage, 0, depth);
    }
}
exports.default = Dependencies;
//# sourceMappingURL=dependencies.js.map