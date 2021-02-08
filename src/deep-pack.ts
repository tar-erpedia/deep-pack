
import chalk from "chalk";
import clear from "clear";
import { program, command, ParseOptions, parseOptions } from "commander";
import figlet from "figlet";
import path from "path";
import PackageJsonLoader from "npm-package-json-loader";
import validatePackageName from "validate-npm-package-name";
import Package from "./package";
import { exec } from "child_process";
(async () => {
  clear();
  console.log(
    chalk.white(
      figlet.textSync('deep-pack-cli', { horizontalLayout: 'controlled smushing' })
    )
  );
  const pkgJsonPath = path.resolve(__dirname, "..", "package.json");
  let packageJSON = new PackageJsonLoader(pkgJsonPath);
  program.version(packageJSON.data.version!).description(packageJSON.data.description!).option("--recursive", "pack also dependencies").parse(process.argv);
  const argsWhichAreNotNodeAndProcess = parseOptions(process.argv).operands.filter((arg) => !arg.includes("node") && !arg.includes(packageJSON.data.name!) && !arg.includes(Object.keys(packageJSON.data.bin!)[0]));
  if (!argsWhichAreNotNodeAndProcess.length) {
    console.log("please provide a package name");
    process.exit(1);
  }
  const packageFullName = argsWhichAreNotNodeAndProcess[0];
  const currPkg: Package | undefined = Package.fromString(packageFullName);
  if (currPkg === undefined) {
    process.exit;
  }
  let dependencies: Package[] = [];
  dependencies.push(currPkg!);
  await (await currPkg?.getDependencies())?.forEach((depPkg) => dependencies.push(depPkg));
  dependencies?.forEach((pkg) => { exec(`npm pack ${pkg}`) });
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