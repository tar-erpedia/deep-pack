"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fetch_1 = __importDefault(require("node-fetch"));
const npm_package_arg_1 = __importDefault(require("npm-package-arg"));
function removeSemanticsFromVersion(version) {
    if (version.startsWith("~") || version.startsWith("^")) {
        return version.slice(1);
    }
    return version;
}
class Package {
    constructor(name, version) {
        this.name = name;
        this.version = version ?? "latest";
    }
    get fullName() {
        return `${this.name}@${this.version}`;
    }
    toString() {
        return this.fullName;
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
    async getDependencies() {
        const response = await (await node_fetch_1.default(`https://registry.npmjs.org/${this.name}/${this.version}`)).json(); // `npm view` returns inconsistent format. so i made direct call to registry
        const result = [];
        if (response.dependencies === undefined)
            return; // TODO: add log
        Object.entries(response.dependencies).forEach((pkg) => {
            const packageName = pkg[0];
            const packageVersion = pkg[1];
            result.push(new Package(packageName, removeSemanticsFromVersion(packageVersion)));
        });
        return result;
    }
}
exports.default = Package;
//# sourceMappingURL=package.js.map