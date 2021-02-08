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
    get packageFullName() {
        return `${this.name}@${this.version}`;
    }
    toString() {
        return this.packageFullName;
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
        Object.entries(response.dependencies).forEach((pkg) => {
            result.push(new Package(pkg[0], removeSemanticsFromVersion(pkg[1])));
        });
        return result;
        // Object.keys(response.dependencies).forEach(name => {
        //     result.push(new Package(name, response.dependencies[key]))
        // });
        // console.log();
    }
}
exports.default = Package;
//# sourceMappingURL=package.js.map