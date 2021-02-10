import { exec } from "child_process";
import fetch from "node-fetch";
import npmPackageArg from "npm-package-arg";
interface APIResponse {
    dependencies: Map<string, string>;
}
function removeSemanticsFromVersion(version: string): string {
    if (version.startsWith("~") || version.startsWith("^")) {
        return version.slice(1);
    }
    return version;
}
export type PackageFullName = string;
enum Errors {
    TOO_MANY_FAILURES = "too many failures"
}
export default class Package {
    public dependencies: Package[] = [];
    public name: string;
    public dependent: Package | undefined;
    public version: string;
    public resolved: boolean = false;
    
    public get siblings() : Package[] {
        return this.dependent?.dependencies ?? [];
    }
    
    static MAX_TRIES: number = 10;

    public get fullName(): PackageFullName {
        return `${this.name}@${this.version}`;
    }
    static fromString(pacakgeNameInAnyFormat: string): Package | undefined {
        try {
            const pacakgeArgResult = npmPackageArg(pacakgeNameInAnyFormat);
            const packageName: string = pacakgeArgResult.name!;
            const packageVersion: string | undefined = pacakgeArgResult.fetchSpec ?? undefined;
            return new Package(packageName, packageVersion);
        } catch (ex) { return undefined; }
    }
    constructor(name: string, version?: string, dependent?: Package) {
        this.dependent = dependent;
        this.name = name;
        this.version = version ?? "latest";
    }
    
    public async download() {
        console.log(`downloading ${this}...`)
        exec(`npm pack ${this}`)
    }
    async getDependencies(trialCount: number = 0): Promise<Package[] | undefined> {
        try {
            const response: APIResponse = <APIResponse><unknown>await (await fetch(`https://registry.npmjs.org/${this.name}/${this.version}`)).json(); // `npm view` returns inconsistent format. so i made direct call to registry
            const result: Package[] = [];
            if (response.dependencies === undefined) return; // TODO: add log
            Object.entries(response.dependencies).forEach((pkg: [string, string]) => {
                const packageName = pkg[0];
                const packageVersion = pkg[1];
                result.push(new Package(packageName, removeSemanticsFromVersion(packageVersion), this));
            });
            this.dependencies = result;
            return result;
        } catch (error) {
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
    public toString(): string {
        return this.fullName;
    }
}