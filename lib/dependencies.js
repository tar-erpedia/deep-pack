"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Events = void 0;
const events_1 = __importDefault(require("events"));
var Events;
(function (Events) {
    Events["PACKAGE_DISCOVERED"] = "package_discovered";
    Events["PACKAGE_RESOLVED"] = "package_resolved";
})(Events = exports.Events || (exports.Events = {}));
class Dependencies extends events_1.default {
    // async downloadAll() {
    //     this.dependencies.forEach((_, pkgName) => { exec(`npm pack ${pkgName}`) });
    // }
    constructor(rootPackage) {
        super();
        this.rootPackage = rootPackage;
    }
    async loadRecursive(pkg, level, depth) {
        console.log(`requested ${pkg}, level: ${level}, depth: ${depth}`);
        try {
            const dependencies = await pkg?.getDependencies();
            if (dependencies === undefined) {
                return; // TODO: log.
            }
            if (dependencies.length == 0 || level === depth) {
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
        }
        catch (err) {
            throw err;
        }
    }
    resolveRecursive(pkg) {
        // console.log(`${pkg} resolved`);
        this.emit(Events.PACKAGE_RESOLVED, pkg);
        pkg.resolved = true;
        pkg.loading = false;
        for (const dependent of pkg.dependents) {
            if (dependent.dependencies.every((dependency) => dependency.resolved)) {
                this.resolveRecursive(dependent);
            }
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