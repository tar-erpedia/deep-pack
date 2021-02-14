"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const chalk_1 = __importDefault(require("chalk"));
const clear_1 = __importDefault(require("clear"));
const commander_1 = require("commander");
const figlet_1 = __importDefault(require("figlet"));
const path_1 = __importDefault(require("path"));
const npm_package_json_loader_1 = __importDefault(require("npm-package-json-loader"));
const package_1 = __importDefault(require("./package"));
const dependencies_1 = __importStar(require("./dependencies"));
const fs_1 = __importDefault(require("fs"));
const os_1 = require("os");
var ExitCodes;
(function (ExitCodes) {
    ExitCodes[ExitCodes["SUCCESS"] = 0] = "SUCCESS";
    ExitCodes[ExitCodes["GENERAL_ERROR"] = 1] = "GENERAL_ERROR";
    ExitCodes[ExitCodes["NO_PACKAGE_NAME_SUPPLIED"] = 2] = "NO_PACKAGE_NAME_SUPPLIED";
    ExitCodes[ExitCodes["INVALID_PACKAGE_NAME_SUPPLIED"] = 3] = "INVALID_PACKAGE_NAME_SUPPLIED";
})(ExitCodes || (ExitCodes = {}));
var Files;
(function (Files) {
    Files["DEPS"] = "deep-pack-deps-log.txt";
    Files["RESOLVED_DEPS"] = "deep-pack-resolved-deps-log.txt";
})(Files || (Files = {}));
var OptionNames;
(function (OptionNames) {
    OptionNames["MAX_DEPTH"] = "max_depth";
    OptionNames["OUT_DEPS"] = "out_deps";
    OptionNames["OUT_RESOLVED_DEPS"] = "out_resolved_deps";
    OptionNames["RESUME_LAST_RUN"] = "resume_last_run";
})(OptionNames || (OptionNames = {}));
const defaultOptions = {
    max_depth: Infinity,
    out_deps: false,
    out_resolved_deps: true,
    resume_last_run: true
};
class Program {
    constructor() {
        this.options = defaultOptions;
    }
    get bin() {
        return Object.keys(this.packageJSONData?.bin)[0];
    }
    get description() {
        return this.packageJSONData?.description;
    }
    get name() {
        return this.packageJSONData?.name;
    }
    get version() {
        return this.packageJSONData?.version;
    }
    loadSelfPacakgeJSON() {
        const pkgJsonPath = path_1.default.resolve(__dirname, "..", "package.json");
        const packageJSON = new npm_package_json_loader_1.default(pkgJsonPath);
        this.packageJSONData = packageJSON.data;
        if (this.packageJSONData === undefined) {
            throw new Error(`couldn't load self package.json`);
        }
    }
    async onAction(packageUserSuppliedName) {
        this.parseOptions();
        if (this.options.resume_last_run) {
            this.resumeLastRun();
        }
        const rootPackage = package_1.default.fromString(packageUserSuppliedName);
        if (rootPackage === undefined) {
            this.exit(ExitCodes.INVALID_PACKAGE_NAME_SUPPLIED, `"${packageUserSuppliedName}" is not a valid package name`);
        }
        if (this.options.out_deps) {
            this.depsWriteStream = fs_1.default.createWriteStream(path_1.default.resolve(process.cwd(), Files.DEPS));
        }
        if (this.options.out_resolved_deps) {
            this.depsResolvedWriteStream = fs_1.default.createWriteStream(path_1.default.resolve(process.cwd(), Files.RESOLVED_DEPS), { flags: "a" });
        }
        const dependencies = new dependencies_1.default(rootPackage);
        dependencies.on(dependencies_1.Events.PACKAGE_DISCOVERED, async (pkg) => {
            if (this.depsWriteStream) {
                this.depsWriteStream.write(`${pkg.fullName}${os_1.EOL}`);
            }
        });
        dependencies.on(dependencies_1.Events.PACKAGE_RESOLVED, async (pkg) => {
            try {
                await pkg.download();
                this.depsResolvedWriteStream.write(`${pkg.fullName}${os_1.EOL}`);
            }
            catch (error) {
                // TODO: return human-readable error
            }
        });
        await dependencies.load(this.options.max_depth);
    }
    resumeLastRun() {
        try {
            const resolvedPkgsSeparatedByNewLine = fs_1.default.readFileSync(path_1.default.resolve(process.cwd(), Files.RESOLVED_DEPS)).toString();
            const resolvedPkgs = resolvedPkgsSeparatedByNewLine.split(os_1.EOL);
            package_1.default.fillCacheByFullNames(resolvedPkgs);
        }
        catch (error) {
        }
    }
    parseOptions() {
        Object.entries(commander_1.program.opts()).forEach((optionArg) => {
            const optionArgName = optionArg[0];
            const optionArgVal = optionArg[1];
            switch (optionArgName) {
                case OptionNames.MAX_DEPTH:
                    this.options.max_depth = optionArgVal === Infinity.toString() ? Infinity : parseInt(optionArgVal);
                    break;
                default:
                    this.options[optionArgName] = optionArgVal;
            }
        });
    }
    setArgs() {
        commander_1.program.arguments("<pacakge_name>");
    }
    setOptions() {
        commander_1.program.option(`-d, --${OptionNames.MAX_DEPTH} <depth>`, "max depth. | integer bigger than 1", this.options.max_depth.toString());
        commander_1.program.option(`--${OptionNames.OUT_DEPS} <out>`, "export dependencies list?", this.options.out_deps);
        commander_1.program.option(`--${OptionNames.OUT_RESOLVED_DEPS} <out>`, "export resolved dependencies list?", this.options.out_resolved_deps);
        commander_1.program.option(`-re, --${OptionNames.RESUME_LAST_RUN} <resume>`, "resume last run?", this.options.resume_last_run);
    }
    setActions() {
        commander_1.program.action(this.onAction.bind(this));
    }
    clearShell() {
        clear_1.default();
    }
    async exec() {
        this.clearShell();
        this.writeToShell('deep-pack-cli', { horizontalLayout: 'controlled smushing' });
        try {
            this.loadSelfPacakgeJSON();
        }
        catch (error) {
            this.exit(ExitCodes.GENERAL_ERROR, error);
        }
        this.showIntro();
        this.setArgs();
        this.setOptions();
        this.setActions();
        commander_1.program.parse(process.argv);
    }
    writeToShell(text, options, chalkFunc) {
        if (chalkFunc === undefined) {
            chalkFunc = chalk_1.default.white;
        }
        if (options !== undefined || options === {}) {
            text = figlet_1.default.textSync(text, options);
        }
        console.log(chalkFunc(text));
    }
    showIntro() {
        commander_1.program.version(this.version)
            .description(this.description);
    }
    exit(code, error) {
        this.writeToShell(error, {}, chalk_1.default.red);
        process.exit(code);
    }
}
exports.default = Program;
//# sourceMappingURL=program.js.map