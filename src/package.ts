import { exec, ExecException } from "child_process";
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
export default class Package {
    name: string;
    version: string;

    public get packageFullName(): string {
        return `${this.name}@${this.version}`;
    }
    public toString(): string {
        return this.packageFullName;
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
        Object.entries(response.dependencies).forEach((pkg: [string, string]) => {
            result.push(new Package(pkg[0], removeSemanticsFromVersion(pkg[1])));
        });
        return result;
        // Object.keys(response.dependencies).forEach(name => {
        //     result.push(new Package(name, response.dependencies[key]))
        // });
        // console.log();
    }
}