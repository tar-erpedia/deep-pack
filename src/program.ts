import chalk, { ChalkFunction } from "chalk";
import clear from "clear";
import { program, parseOptions, OptionValues, ParseOptionsResult } from "commander";
import figlet, { Options as FigletOptions } from "figlet";
import path from "path";
import PackageJsonLoader, { IPackageJson } from "npm-package-json-loader";
import Package, { PackageFullName } from "./package";
import { exec } from "child_process";
import Dependencies, {Events as DependenciesEvents} from "./dependencies";
import fs from "fs";

enum ExitCodes {
    SUCCESS = 0,
    GENERAL_ERROR = 1,
    NO_PACKAGE_NAME_SUPPLIED = 2,
    INVALID_PACKAGE_NAME_SUPPLIED = 3
}
enum OptionNames {
    MAX_DEPTH = "max_depth",
}
interface Options {
    max_depth: number;
}
export default class Program {
    protected packageJSONData: IPackageJson<any> | undefined;
    protected optionArgs: OptionValues | undefined;
    protected options: Options = Program.defaultOptions;
    protected static defaultOptions: Options = { max_depth: Infinity };
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
        const rootPackage: Package | undefined = Package.fromString(packageUserSuppliedName);
        if (rootPackage === undefined) {
            this.exit(ExitCodes.INVALID_PACKAGE_NAME_SUPPLIED, `"${packageUserSuppliedName}" is not a valid package name`);
        }
        this.parseOptions()
        const dependencies: Dependencies = new Dependencies(rootPackage!);
        dependencies.on(DependenciesEvents.PACKAGE_RESOLVED, async (pkg: Package) => {
            await pkg.download();
        });
        await dependencies.load(this.options.max_depth);
        // await dependencies.downloadAll();
    }
    protected parseOptions() {
        Object.entries(program.opts()).forEach((optionArg: [string, any]) => {
            const optionArgName = optionArg[0];
            const optionArgVal = optionArg[1];
            switch (optionArgName) { 
                case OptionNames.MAX_DEPTH:
                    this.options.max_depth = optionArgVal === Infinity.toString() ? Infinity : parseInt(optionArgVal);
                    break;
            }
        });
    }
    protected setArgs() {
        program.arguments("<pacakge_name>");
    }
    protected setOptions() {
        program.option(`-d, --${OptionNames.MAX_DEPTH} <depth>`, "max depth. | integer bigger than 1", this.options.max_depth.toString())
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
        this.writeToShell(error, {}, chalk.red);
        process.exit(code);
    }
}