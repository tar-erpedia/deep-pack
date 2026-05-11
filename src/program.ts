import chalk, { type ChalkInstance } from "chalk";
import { program, type OptionValues } from "commander";
import figlet, { type Options as FigletOptions } from "figlet";
import path from "node:path";
import Package from "./package.js";
import Dependencies, { Events as DependenciesEvents } from "./dependencies.js";
import os from "node:os";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import type { Manifest } from "pacote";

const ExitCodes = {
    SUCCESS: 0,
    GENERAL_ERROR: 1,
    NO_PACKAGE_NAME_SUPPLIED: 2,
    INVALID_PACKAGE_NAME_SUPPLIED: 3,
} as const;

const Files = {
    DEPS: "deep-pack-deps-log.txt",
    RESOLVED_DEPS: "deep-pack-resolved-deps-log.txt",
} as const;

interface Options {
    maxDepth: number;
    devDeps: boolean;
    lock?: string;
    peerDeps: boolean;
    optionalDeps: boolean;
    outDeps: boolean;
    outResolvedDeps: boolean;
    resumeLastRun: boolean;
    outputTgz: boolean;
}

const defaultOptions = {
    maxDepth: Infinity,
    devDeps: false,
    lock: undefined,
    peerDeps: true,
    optionalDeps: false,
    outDeps: false,
    outResolvedDeps: true,
    resumeLastRun: true,
    outputTgz: false,
} satisfies Options;

export default class Program {
    protected depsWriteStream: fs.WriteStream = fs.createWriteStream(os.devNull);
    protected depsResolvedWriteStream: fs.WriteStream = fs.createWriteStream(os.devNull);
    protected packageJSONData: Partial<Manifest> | undefined;
    protected optionArgs: OptionValues | undefined;
    protected options: Options = defaultOptions;
    public static outputTgzPath: string = "";
    public static downloadedPackagesPath = new Set<string>();
    public static packageJsonMode: boolean = false;
    public static packageLockMode: boolean = false;

    public get description(): string {
        return this.packageJSONData?.description ?? "";
    }
    public get version(): string {
        return this.packageJSONData?.version ?? "";
    }

    protected async loadSelfPackageJSON() {
        this.packageJSONData = (await import("../package.json", { with: { type: "json" } })).default;
    }

    protected async onAction(packageUserSuppliedName: string | undefined, options: Options) {
        this.options = options;
        if (this.options.resumeLastRun) {
            this.resumeLastRun();
        }
        const rootPackage: Package | undefined = this.options.lock
            ? await Package.fromPackageLock(this.options.lock, this.options.devDeps)
            : packageUserSuppliedName
              ? await Package.fromString(packageUserSuppliedName)
              : undefined;
        if (!rootPackage) {
            const invalidSpec = this.options.lock ?? packageUserSuppliedName ?? "";
            return this.exit(
                ExitCodes.INVALID_PACKAGE_NAME_SUPPLIED,
                `"${invalidSpec}" is not a valid package name or package-lock.json path`
            );
        }

        // Avoid polluting non-empty cwd unrelated to deep-pack
        const cwdFiles = await fsPromises.readdir(process.cwd());
        if (cwdFiles.length > 0 && !cwdFiles.some((path) => path === Files.RESOLVED_DEPS) && !options.outputTgz) {
            console.log("Detected non-empty directory, Creating dedicated directory for npm-deep-pack");
            const deepPackDirName = `deep-pack-${rootPackage.normalizedNameForPath}_${rootPackage.version}`;
            if (!fs.existsSync(deepPackDirName)) await fsPromises.mkdir(deepPackDirName);
            process.chdir(deepPackDirName);
        }

        if (this.options.outDeps && !options.outputTgz) {
            this.depsWriteStream = fs.createWriteStream(path.resolve(process.cwd(), Files.DEPS));
        }
        if (this.options.outResolvedDeps && !options.outputTgz) {
            this.depsResolvedWriteStream = fs.createWriteStream(path.resolve(process.cwd(), Files.RESOLVED_DEPS), {
                flags: "a",
            });
        }

        const dependencies: Dependencies = new Dependencies(rootPackage);
        dependencies.on(DependenciesEvents.PACKAGE_DISCOVERED, async (pkg: Package) => {
            if (this.depsWriteStream) {
                this.depsWriteStream.write(`${pkg.fullName}${os.EOL}`);
            }
        });
        dependencies.on(DependenciesEvents.PACKAGE_RESOLVED, async (pkg: Package) => {
            try {
                this.depsResolvedWriteStream.write(`${pkg.fullName}${os.EOL}`);
                this.writeToShell(`${pkg} resolved`, undefined, chalk.green);
            } catch (err) {
                console.warn(err);
            }
        });
        dependencies.on(DependenciesEvents.PACKAGE_RESOLVE_ERROR, async (pkg: Package) => {
            // ------------------- UI -------------------
            const dependentOrDependentsStr = pkg.dependentOrDependentsToString();
            this.writeToShell(
                `${pkg} resolve error. requested by: ${dependentOrDependentsStr || "you"}`,
                undefined,
                chalk.red
            );
            // ------------------- UI -------------------
        });
        dependencies.on(DependenciesEvents.PACKAGE_DOWNLOAD_ERROR, async (pkg: Package) => {
            // ------------------- UI -------------------
            const dependentOrDependentsStr = pkg.dependentOrDependentsToString();
            this.writeToShell(
                `${pkg} download error. requested by: ${dependentOrDependentsStr || "you"}`,
                undefined,
                chalk.red
            );
            // ------------------- UI -------------------
        });

        await dependencies.load(
            this.options.maxDepth,
            this.options.devDeps,
            this.options.peerDeps,
            this.options.optionalDeps
        );
        if (!rootPackage?.resolved) {
            this.writeToShell("=========================================================", undefined, chalk.yellow);
            this.writeToShell("please run again. there are more dependencies to resolve.", undefined, chalk.yellow);
            this.writeToShell("=========================================================", undefined, chalk.yellow);
        }

        if (options.outputTgz) {
            const t = await import("tar");

            Program.outputTgzPath = `deep-pack-${rootPackage.normalizedNameForPath}_${rootPackage.version}.tgz`;
            if (fs.existsSync(Program.outputTgzPath))
                return console.log(`Tgz destination exists(${Program.outputTgzPath}), Skipping tgz creation...`);

            t.create({ gzip: true, file: Program.outputTgzPath }, [...Program.downloadedPackagesPath]).then(
                async () =>
                    await Promise.all(
                        [...Program.downloadedPackagesPath].map(async (pkgPath) => await fsPromises.rm(pkgPath))
                    )
            );
        }

        console.log(`Resolved ${Program.downloadedPackagesPath.size} packages`);
    }

    async resumeLastRun() {
        try {
            const resolvedPkgsSeparatedByNewLine = (
                await fsPromises.readFile(path.resolve(process.cwd(), Files.RESOLVED_DEPS))
            ).toString();
            const resolvedPkgs: PackageFullName[] = resolvedPkgsSeparatedByNewLine.split(os.EOL);
            await Package.fillCacheByFullNames(resolvedPkgs);
        } catch (_error) {}
    }

    protected setArgs() {
        program.argument(
            "[spec]",
            "Package name(and optionally version) or path to a valid package.json. For example, next[@15] or ./package.json"
        );
    }

    protected setOptions() {
        program.option(
            `-d, --max-depth <depth>`,
            "max depth. | integer bigger than 1",
            parseFloat,
            this.options.maxDepth
        );
        program.option(`--dev, --dev-deps`, "Resolve devDependencies");
        program.option(`-l, --lock <path>`, "Path to a package-lock.json file with exact package versions");
        program.option(`--no-peer, --no-peer-deps`, "Don't resolve peerDependencies");
        program.option(`--optional, --optional-deps`, "Resolve optionalDependencies");
        program.option(`--out-deps <out>`, "Export dependencies list?", this.options.outDeps);
        program.option(`--out-resolved-deps <out>`, "Export resolved dependencies list?", this.options.outResolvedDeps);
        program.option(`-r, --resume-last-run <resume>`, "Resume last run?");
        program.option(`--tgz, --output-tgz`, "Bundle output to tgz", this.options.outputTgz);
    }

    protected setActions() {
        program.action(this.onAction.bind(this));
    }

    public clearShell() {
        process.stdout.write("\x1Bc");
    }

    public async exec() {
        this.clearShell();
        this.writeToShell("npm-deep-pack", { horizontalLayout: "controlled smushing" });
        try {
            await this.loadSelfPackageJSON();
        } catch (error: unknown) {
            if (error instanceof Error) this.exit(ExitCodes.GENERAL_ERROR, error.message);
            else this.exit(ExitCodes.GENERAL_ERROR, "Unknown cause");
        }
        this.showIntro();
        this.setArgs();
        this.setOptions();
        this.setActions();

        await program.parseAsync(process.argv);
    }

    public writeToShell(text: string, options?: FigletOptions, chalkFunc?: ChalkInstance) {
        if (chalkFunc === undefined) {
            chalkFunc = chalk.white;
        }

        if (options && Object.keys(options).length > 0) {
            text = figlet.textSync(text, options);
        }
        console.log(chalkFunc?.(text));
    }

    protected showIntro() {
        program.version(this.version).description(this.description);
    }

    public exit(code: number, error: string) {
        this.writeToShell(error, undefined, chalk.red);
        process.exit(code);
    }
}
