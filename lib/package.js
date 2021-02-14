"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const child_process_1 = require("child_process");
const node_fetch_1 = __importDefault(require("node-fetch"));
const npm_package_arg_1 = __importDefault(require("npm-package-arg"));
function removeSemanticsFromVersion(version) {
    if (version.startsWith("~") || version.startsWith("^")) {
        return version.slice(1);
    }
    return version;
}
function fullNameByNameAndVersion(name, version) {
    return `${name}@${version}`;
}
var Errors;
(function (Errors) {
    Errors["TOO_MANY_FAILURES"] = "too many failures";
})(Errors || (Errors = {}));
class Package {
    constructor(name, version) {
        this.dependencies = [];
        this.dependents = [];
        this.loading = false;
        this.resolved = false;
        this.name = name;
        this.version = version ?? "latest";
    }
    get fullName() {
        return fullNameByNameAndVersion(this.name, this.version);
    }
    addDependent(pkg) {
        if (!this.dependents.includes(pkg)) {
            this.dependents.push(pkg);
        }
    }
    async download() {
        console.log(`downloading ${this}...`);
        return new Promise((resolve, reject) => {
            child_process_1.exec(`npm pack ${this}`, (error, stdout, stderr) => {
                if (error) {
                    reject(); // TODO: return human-readable error
                }
                else {
                    resolve();
                }
            });
        });
    }
    async getDependencies(trialCount = 0) {
        this.loading = true;
        try {
            const response = await (await node_fetch_1.default(`https://registry.npmjs.org/${this.name}/${this.version}`)).json(); // `npm view` returns inconsistent format. so i made direct call to registry
            const result = [];
            if (response === undefined)
                return;
            if (response.dependencies == undefined)
                return result; // TODO: add log
            Object.entries(response.dependencies).forEach((pkg) => {
                const packageName = pkg[0];
                const packageVersion = pkg[1];
                const dependency = Package.fromNameAndVersion(packageName, removeSemanticsFromVersion(packageVersion));
                dependency.addDependent(this);
                result.push(dependency);
            });
            this.dependencies = result;
            return result;
        }
        catch (error) {
            const errno = error?.errno;
            console.log(errno);
            switch (errno) {
                case 'ENOTFOUND':
                    return;
                default:
                    if (trialCount > Package.MAX_TRIES) {
                        throw Errors.TOO_MANY_FAILURES;
                    }
                    return await this.getDependencies(trialCount + 1);
            }
        }
    }
    toString() {
        return this.fullName;
    }
    static fromNameAndVersion(name, version) {
        const fullName = fullNameByNameAndVersion(name, version);
        const cachedPkg = Package.cache.get(fullName);
        if (cachedPkg) {
            return cachedPkg;
        }
        else {
            const result = new Package(name, version);
            this.cache.set(result.fullName, result);
            return result;
        }
    }
    static fillCacheByFullNames(fullNames) {
        for (const fullName of fullNames) {
            const pkg = Package.fromString(fullName);
            if (pkg === undefined)
                continue;
            pkg.resolved = true;
            this.cache.set(fullName, pkg);
        }
    }
    static fromString(pacakgeNameInAnyFormat) {
        try {
            const pacakgeArgResult = npm_package_arg_1.default(pacakgeNameInAnyFormat);
            const packageName = pacakgeArgResult.name;
            const packageVersion = pacakgeArgResult.fetchSpec ?? "latest";
            return Package.fromNameAndVersion(packageName, packageVersion);
        }
        catch (ex) {
            return undefined;
        }
    }
}
exports.default = Package;
Package.cache = new Map();
Package.MAX_TRIES = 10;
//# sourceMappingURL=package.js.map