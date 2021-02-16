import { exec } from "child_process";
import fetch from "node-fetch";
import npmPackageArg from "npm-package-arg";
import PackageJsonLoader from "npm-package-json-loader";
import semver from "semver";
interface APIResponse {
    dependencies: Map<string, string>;
}
function extractVersionFromSemanticVersion(semanticVersion: string): string | undefined {
    return semver.coerce(semanticVersion, { rtl: true })?.version;
}
function fullNameByNameAndVersion(name: string, version: string): PackageFullName {
    return `${name}@${version}`;
}
export type PackageFullName = string;
enum Errors {
    TOO_MANY_FAILURES = "too many failures"
}
export default class Package {
    public dependencies: Package[] = [];
    public dependents: Package[] = [];
    public loading: boolean = false;
    public name: string;
    public resolved: boolean = false;
    public version: string;

    static cache: Map<PackageFullName, Package> = new Map();
    static MAX_TRIES: number = 10;
    public get fullName(): PackageFullName {
        return fullNameByNameAndVersion(this.name,  this.version);
    }
    protected constructor(name: string, version?: string) {
        this.name = name;
        this.version = version ?? "latest";
    }
    addDependent(pkg: Package) {
        if(!this.dependents.includes(pkg)) {
            this.dependents.push(pkg);
        }
    }
    public async download() {
        console.log(`downloading ${this}...`)
        return new Promise<void>((resolve, reject) => {
            exec(`npm pack ${this}`,(error, stdout, stderr) => {
                if(error)
                {
                    reject(); // TODO: return human-readable error
                } else {
                    resolve();
                }
            });
        });
    }
    async getDependencies(trialCount: number = 0): Promise<Package[] | undefined> {
        this.loading = true;
        try {
            const response: APIResponse = <APIResponse><unknown>await (await fetch(`https://registry.npmjs.org/${this.name}/${this.version}`)).json(); // `npm view` returns inconsistent format. so i made direct call to registry
            const result: Package[] = [];
            if(response === undefined) return;
            if (response.dependencies == undefined) return result; // TODO: add log
            Object.entries(response.dependencies).forEach((pkg: [string, string]) => {
                const packageName = pkg[0];
                const packageSemanticVersion = pkg[1];
                var packageVersion = extractVersionFromSemanticVersion(packageSemanticVersion);
                if(packageVersion === undefined) {
                    packageVersion = "latest"; 
                    // TODO: write log.
                }
                const dependency = Package.fromNameAndVersion(packageName, packageVersion);
                dependency.addDependent(this);
                result.push(dependency);
            });
            this.dependencies = result;
            return result;
        } catch (error) {
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
    public toString(): string {
        return this.fullName;
    }
    public static fromNameAndVersion(name: string, version: string): Package {
        const fullName = fullNameByNameAndVersion(name, version);
        const cachedPkg = Package.cache.get(fullName);
        if(cachedPkg) {
            return cachedPkg;
        }
        else {
            const result = new Package(name, version);
            this.cache.set(result.fullName, result);
            return result;
        }
    }
    static fillCacheByFullNames(fullNames : PackageFullName[]){
        for (const fullName of fullNames) {
            const pkg = Package.fromString(fullName);
            if(pkg === undefined) continue;
            pkg!.resolved = true;
            this.cache.set(fullName, pkg);
        }
    }
    static fromString(pacakgeNameInAnyFormat: string): Package | undefined {
        try {
            const pacakgeArgResult = npmPackageArg(pacakgeNameInAnyFormat);
            const packageName: string = pacakgeArgResult.name!;
            const packageVersion: string | undefined = pacakgeArgResult.fetchSpec ?? "latest";
            return Package.fromNameAndVersion(packageName, packageVersion);
        } catch (ex) { return undefined; }
    }
}