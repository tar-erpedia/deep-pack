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
var Errors;
(function (Errors) {
    Errors["TOO_MANY_FAILURES"] = "too many failures";
})(Errors || (Errors = {}));
class Package {
    constructor(name, version, dependent) {
        this.dependencies = [];
        this.resolved = false;
        this.dependent = dependent;
        this.name = name;
        this.version = version ?? "latest";
    }
    get siblings() {
        return this.dependent?.dependencies ?? [];
    }
    get fullName() {
        return `${this.name}@${this.version}`;
    }
    static fromString(pacakgeNameInAnyFormat) {
        try {
            const pacakgeArgResult = npm_package_arg_1.default(pacakgeNameInAnyFormat);
            const packageName = pacakgeArgResult.name;
            const packageVersion = pacakgeArgResult.fetchSpec ?? undefined;
            return new Package(packageName, packageVersion);
        }
        catch (ex) {
            return undefined;
        }
    }
    async download() {
        console.log(`downloading ${this}...`);
        child_process_1.exec(`npm pack ${this}`);
    }
    async getDependencies(trialCount = 0) {
        try {
            const response = await (await node_fetch_1.default(`https://registry.npmjs.org/${this.name}/${this.version}`)).json(); // `npm view` returns inconsistent format. so i made direct call to registry
            const result = [];
            if (response.dependencies === undefined)
                return; // TODO: add log
            Object.entries(response.dependencies).forEach((pkg) => {
                const packageName = pkg[0];
                const packageVersion = pkg[1];
                result.push(new Package(packageName, removeSemanticsFromVersion(packageVersion), this));
            });
            this.dependencies = result;
            return result;
        }
        catch (error) {
            const errno = error?.errno;
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
}
exports.default = Package;
Package.MAX_TRIES = 10;
//# sourceMappingURL=package.js.map