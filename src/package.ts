import fetch from "node-fetch";
import npmPackageArg from "npm-package-arg";
interface APIResponse {
    dependencies: Map<string, string>;
}
function removeSemanticsFromVersion(version: string) : string {
    if(version.startsWith("~") || version.startsWith("^") ) {
        return version.slice(1);
    }
    return version;
}
export type PackageFullName = string;
export default class Package {
    name: string;
    version: string;

    public get fullName(): PackageFullName {
        return `${this.name}@${this.version}`;
    }
    public toString(): string {
        return this.fullName;
    }
    static fromString(pacakgeNameInAnyFormat: string): Package | undefined {
        try {
            const pacakgeArgResult = npmPackageArg(pacakgeNameInAnyFormat);
            const packageName: string = pacakgeArgResult.name!;
            const packageVersion: string | undefined = pacakgeArgResult.fetchSpec ?? undefined;
            return new Package(packageName, packageVersion);
        } catch (ex) { return undefined; }
    }
    constructor(name: string, version?: string) {
        this.name = name;
        this.version = version ?? "latest";
    }
    async getDependencies() : Promise<Package[]> {
        const response: APIResponse = <APIResponse><unknown>await (await fetch(`https://registry.npmjs.org/${this.name}/${this.version}`)).json(); // `npm view` returns inconsistent format. so i made direct call to registry
        const result: Package[] = [];
        if(response.dependencies === undefined) return; // TODO: add log
        Object.entries(response.dependencies).forEach((pkg: [string, string]) => {
            const packageName = pkg[0];
            const packageVersion = pkg[1];
            result.push(new Package(packageName, removeSemanticsFromVersion(packageVersion)));
        });
        return result;
    }
}