import { exec } from "child_process";
import { X_OK } from "constants";
import fetch, { Response } from "node-fetch";
import npmPackageArg from "npm-package-arg";
import PackageJsonLoader from "npm-package-json-loader";
import { versions } from "process";
import semver from "semver";

interface APIResponse {
  dependencies: Map<string, string>;
  versions: { [version: string]: any };
}
function extractVersionFromSemanticVersion(
  semanticVersion: string
): string | undefined {
  if (semanticVersion === "*") {
    return "latest";
  }

  // TODO: support: ">=1.2.3 <1.2.7"
  let lastPhrase = semanticVersion.split(" ").pop();
  if (lastPhrase != undefined && lastPhrase.substr(0, 1) === "<") {
  }

  // TODO: support "1.3.0-rc0" => if contains anything after x.y.z like x.y.z-anything then keep it x.y.z-anything
  return semver.coerce(semanticVersion, { rtl: true })?.version;
}
function fullNameByNameAndVersion(
  name: string,
  version: string
): PackageFullName {
  return `${name}@${version}`;
}
export type PackageFullName = string;
enum Errors {
  TOO_MANY_FAILURES = "too many failures",
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
  public get isRoot(): boolean {
    return this.dependents.length === 0;
  }
  public get fullName(): PackageFullName {
    return fullNameByNameAndVersion(this.name, this.version);
  }
  protected constructor(name: string, version?: string) {
    this.name = name;
    this.version = version ?? "latest";
  }
  addDependent(pkg: Package) {
    if (!this.dependents.includes(pkg)) {
      this.dependents.push(pkg);
    }
  }
  public async download() {
    console.log(`downloading ${this}...`);
    return new Promise<void>((resolve, reject) => {
      exec(`npm pack ${this}`, (error, stdout, stderr) => {
        if (error) {
          reject(); // TODO: return human-readable error
        } else {
          resolve();
        }
      });
    });
  }
  async getDependencies(
    trialCount: number = 0
  ): Promise<Package[] | undefined> {
    this.loading = true;
    try {
      const response: APIResponse = <APIResponse>(
        (<unknown>(
          await (
            await fetch(
              `https://registry.npmjs.org/${this.name}/${this.version}`
            )
          ).json()
        ))
      ); // `npm view` returns inconsistent format. so i made direct call to registry
      const result: Package[] = [];
      if (response === undefined) return;
      if (response.dependencies == undefined) return result; // TODO: add log
      const semverPromises = Object.entries(response.dependencies).map(
        async (pkg: [string, string]) => {
          const packageName = pkg[0];
          const packageSemanticVersion = pkg[1];

          const dependency = await Package.fromSemanticVersion(packageName, packageSemanticVersion);
          // check for cyclic dependency (I.E. https://registry.npmjs.org/@types/koa-compose/latest)
          if (this.isAncestorEqual(dependency)) {
            return;
          }
          dependency.addDependent(this);
          result.push(dependency);
        }
      );
      await Promise.all(semverPromises);
      this.dependencies = result;
      return result;
    } catch (error) {
      const errno = error?.errno;
      console.log(errno);
      switch (errno) {
        case "ENOTFOUND":
          return;
        default:
          if (trialCount > Package.MAX_TRIES) {
            throw Errors.TOO_MANY_FAILURES;
          }
          return await this.getDependencies(trialCount + 1);
      }
    }
  }
  public isAncestorEqual(pkg: Package): boolean {
    if (pkg.isEqual(this)) {
      return true;
    }
    if (this.isRoot) {
      return false;
    }
    return this.dependents.some((dependent) => dependent.isAncestorEqual(pkg));
  }
  public isEqual(pkg: Package): boolean {
    return pkg.fullName === this.fullName;
  }
  public toString(): string {
    return this.fullName;
  }
  public static fromNameAndVersion(name: string, version: string): Package {
    const fullName = fullNameByNameAndVersion(name, version);
    const cachedPkg = Package.cache.get(fullName);
    if (cachedPkg) {
      return cachedPkg;
    } else {
      const result = new Package(name, version);
      this.cache.set(result.fullName, result);
      return result;
    }
  }
  static fillCacheByFullNames(fullNames: PackageFullName[]) {
    for (const fullName of fullNames) {
      const pkg = Package.fromString(fullName);
      if (pkg === undefined) continue;
      pkg!.resolved = true;
      this.cache.set(fullName, pkg);
    }
  }
  static fromString(pacakgeNameInAnyFormat: string): Package | undefined {
    try {
      const pacakgeArgResult = npmPackageArg(pacakgeNameInAnyFormat);
      const packageName: string = pacakgeArgResult.name!;
      const packageVersion: string | undefined =
        pacakgeArgResult.fetchSpec ?? "latest";
      return Package.fromNameAndVersion(packageName, packageVersion);
    } catch (ex) {
      return undefined;
    }
  }
  static async fromSemanticVersion(
    name: string,
    semanticVersion: string
  ): Promise<Package> {
    let version: string = semanticVersion;

    if (semanticVersion === "*") {
      version = "latest";
    } else if (semanticVersion.includes("<") || semanticVersion.includes("-")) {
      const response: APIResponse = <APIResponse>((<unknown>(await (await fetch(`https://registry.npmjs.org/${name}`)).json()))); // `npm view` returns inconsistent format. so i made direct call to registry

      version =
        semver.maxSatisfying(Object.keys(response.versions), semanticVersion) ??
        "latest";
      console.log(`${name}@${version}=${semanticVersion}`);
    } else {
      version =
        semver.coerce(semanticVersion)?.version ?? "latest";
    }

    // return
    return Promise.resolve(this.fromNameAndVersion(name, version));
  }
}
