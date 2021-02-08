"use strict";
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
const child_process_1 = require("child_process");
(async () => {
    clear_1.default();
    console.log(chalk_1.default.white(figlet_1.default.textSync('deep-pack-cli', { horizontalLayout: 'controlled smushing' })));
    const pkgJsonPath = path_1.default.resolve(__dirname, "..", "package.json");
    let packageJSON = new npm_package_json_loader_1.default(pkgJsonPath);
    commander_1.program.version(packageJSON.data.version).description(packageJSON.data.description).option("--recursive", "pack also dependencies").parse(process.argv);
    const argsWhichAreNotNodeAndProcess = commander_1.parseOptions(process.argv).operands.filter((arg) => !arg.includes("node") && !arg.includes(packageJSON.data.name) && !arg.includes(Object.keys(packageJSON.data.bin)[0]));
    if (!argsWhichAreNotNodeAndProcess.length) {
        console.log("please provide a package name");
        process.exit(1);
    }
    const packageFullName = argsWhichAreNotNodeAndProcess[0];
    const currPkg = package_1.default.fromString(packageFullName);
    if (currPkg === undefined) {
        process.exit;
    }
    let dependencies = [];
    dependencies.push(currPkg);
    await (await currPkg?.getDependencies())?.forEach((depPkg) => dependencies.push(depPkg));
    dependencies?.forEach((pkg) => { child_process_1.exec(`npm pack ${pkg}`); });
})();
// let packageName: string;
// let packageVersion: string | null;
// try {
//   // if (!validatePackageName(packageFullName).validForOldPackages) {
//   //   console.log("please provide a valid package name");
//   //   process.exit(1);
//   // }
// } catch (ex) {
//   console.log("please provide a valid package name");
//   process.exit(1);
// }
//   // const response = await fetch(`https://registry.npmjs.org/${packageName}`);
//   //
//   // fetch()
//   // npmInstallAsync([packageName], process.cwd()).then(console.log);
//   // console.log(process.cwd());
//# sourceMappingURL=deep-pack.js.map