import chalk, { ChalkFunction } from "chalk";
import clear from "clear";
import { program, parseOptions, OptionValues, ParseOptionsResult } from "commander";
import figlet, { Options as FigletOptions } from "figlet";
import path from "path";
import PackageJsonLoader, { IPackageJson } from "npm-package-json-loader";
import Package from "./package";
import Dependencies, { Events as DependenciesEvents } from "./dependencies";
import fs from "fs";
import { EOL } from "os";

enum ExitCodes {
    SUCCESS = 0,
    GENERAL_ERROR = 1,
    NO_PACKAGE_NAME_SUPPLIED = 2,
    INVALID_PACKAGE_NAME_SUPPLIED = 3
}
enum Files {
    DEPS = "deep-pack-deps-log.txt",
    RESOLVED_DEPS = "deep-pack-resolved-deps-log.txt",
}
enum OptionNames {
    MAX_DEPTH = "max_depth",
    OUT_DEPS = "out_deps",
    OUT_RESOLVED_DEPS = "out_resolved_deps",
    RESUME_LAST_RUN = "resume_last_run",
}
interface Options {
    max_depth: number;
    out_deps: boolean;
    out_resolved_deps: boolean;
    resume_last_run: boolean;
}
const defaultOptions: Options = {
    max_depth: Infinity,
    out_deps: false,
    out_resolved_deps: true,
    resume_last_run: true
}
export default class Program {
    protected depsWriteStream: fs.WriteStream | unknown;
    protected depsResolvedWriteStream: fs.WriteStream | unknown;
    protected packageJSONData: IPackageJson<any> | undefined;
    protected optionArgs: OptionValues | undefined;
    protected options: Options = defaultOptions;
    public get bin(): string | undefined {
        return Object.keys(this.packageJSONData?.bin as {
            [k: string]: string;
        })[0];
    }
    public get description(): string | undefined {
        return this.packageJSONData?.description;
    }
    public get name(): string | undefined {
        return this.packageJSONData?.name;
    }
    public get version(): string | undefined {
        return this.packageJSONData?.version;
    }
    constructor() {
    }
    protected loadSelfPacakgeJSON() {
        const pkgJsonPath = path.resolve(__dirname, "..", "package.json");
        const packageJSON = new PackageJsonLoader(pkgJsonPath);
        this.packageJSONData = packageJSON.data;
        if (this.packageJSONData === undefined) {
            throw new Error(`couldn't load self package.json`);
        }
    }
    protected async onAction(packageUserSuppliedName: string) {
        this.parseOptions();
        if (this.options.resume_last_run) {
            this.resumeLastRun();
        }
        const rootPackage: Package | undefined = Package.fromString(packageUserSuppliedName);
        if (rootPackage === undefined) {
            this.exit(ExitCodes.INVALID_PACKAGE_NAME_SUPPLIED, `"${packageUserSuppliedName}" is not a valid package name`);
        }
        if (this.options.out_deps) {
            this.depsWriteStream = fs.createWriteStream(path.resolve(process.cwd(), Files.DEPS));
        }
        if (this.options.out_resolved_deps) {
            this.depsResolvedWriteStream = fs.createWriteStream(path.resolve(process.cwd(), Files.RESOLVED_DEPS), { flags: "a" });
        }

        const dependencies: Dependencies = new Dependencies(rootPackage!);
        dependencies.on(DependenciesEvents.PACKAGE_DISCOVERED, async (pkg: Package) => {
            if (this.depsWriteStream) {
                (<fs.WriteStream>this.depsWriteStream!).write(`${pkg.fullName}${EOL}`);
            }
        });
        dependencies.on(DependenciesEvents.PACKAGE_RESOLVED, async (pkg: Package) => {
            try {
                (<fs.WriteStream>this.depsResolvedWriteStream!).write(`${pkg.fullName}${EOL}`);
                this.writeToShell(`${pkg} resolved`, undefined, chalk.green);
            }
            catch (error) {
                // TODO: return human-readable error
            }
        });
        dependencies.on(DependenciesEvents.PACKAGE_RESOLVE_ERROR, async (pkg: Package) => {
            this.writeToShell(`${pkg} resolve error`, undefined, chalk.red);
        });
        dependencies.on(DependenciesEvents.PACKAGE_DOWNLOAD_ERROR, async (pkg: Package) => {
            this.writeToShell(`${pkg} download error`, undefined, chalk.red);
        });

        await dependencies.load(this.options.max_depth);
        if (!rootPackage!.resolved) {
            this.writeToShell("=========================================================", undefined, chalk.yellow);  // TODO: support === printing
            this.writeToShell("please run again. there are more dependencies to resolve.", undefined, chalk.yellow);  // TODO: support run until finished
            this.writeToShell("=========================================================", undefined, chalk.yellow);  // TODO: support === printing
        } 
    }
    resumeLastRun() {
        try {
            const resolvedPkgsSeparatedByNewLine = fs.readFileSync(path.resolve(process.cwd(), Files.RESOLVED_DEPS)).toString();
            const resolvedPkgs: PackageFullName[] = resolvedPkgsSeparatedByNewLine.split(EOL);
            Package.fillCacheByFullNames(resolvedPkgs);
        }
        catch (error) {

        }
    }
    protected parseOptions() {
        Object.entries(program.opts()).forEach((optionArg: [string, any]) => {
            const optionArgName = optionArg[0];
            const optionArgVal = optionArg[1];
            switch (optionArgName) {
                case OptionNames.MAX_DEPTH:
                    this.options.max_depth = optionArgVal === Infinity.toString() ? Infinity : parseInt(optionArgVal);
                    break;
                default:
                    (<any>this.options)[optionArgName] = optionArgVal;
            }
        });
    }
    protected setArgs() {
        program.arguments("<pacakge_name>");
    }
    protected setOptions() {
        program.option(`-d, --${OptionNames.MAX_DEPTH} <depth>`, "max depth. | integer bigger than 1", this.options.max_depth.toString())
        program.option(`--${OptionNames.OUT_DEPS} <out>`, "export dependencies list?", this.options.out_deps)
        program.option(`--${OptionNames.OUT_RESOLVED_DEPS} <out>`, "export resolved dependencies list?", this.options.out_resolved_deps)
        program.option(`-re, --${OptionNames.RESUME_LAST_RUN} <resume>`, "resume last run?", this.options.resume_last_run)
    }
    protected setActions() {
        program.action(this.onAction.bind(this));
    }
    public clearShell() {
        clear();
    }
    public async exec() {
        this.clearShell();
        this.writeToShell('deep-pack-cli', { horizontalLayout: 'controlled smushing' });
        try {
            this.loadSelfPacakgeJSON();
        } catch (error) {
            this.exit(ExitCodes.GENERAL_ERROR, error);
        }
        this.showIntro();
        this.setArgs();
        this.setOptions();
        this.setActions();

        program.parse(process.argv);
    }
    public writeToShell(text: string, options?: FigletOptions, chalkFunc?: ChalkFunction) {
        if (chalkFunc === undefined) {
            chalkFunc = chalk.white;
        }

        if (options !== undefined || options === {}) {
            text = figlet.textSync(text, options!);
        }
        console.log(chalkFunc!(text));
    }
    protected showIntro() {
        program.version(this.version!)
            .description(this.description!);
    }
    public exit(code: ExitCodes, error: string) {
        this.writeToShell(error, undefined, chalk.red);
        process.exit(code);
    }
}