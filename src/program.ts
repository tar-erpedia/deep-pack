import chalk, { type ChalkInstance } from "chalk";
import { InvalidArgumentError, program } from "commander";
import figlet, { type FigletOptions } from "figlet";
import path from "node:path";
import Package, { PackageSpecError } from "./package.js";
import Dependencies, { Events as DependenciesEvents } from "./dependencies.js";
import os from "node:os";
import fsPromises from "node:fs/promises";
import type { Manifest } from "pacote";
import { errorMessage, moveFile, outputSize, sanitizePathComponent, timestampSuffix } from "./utils.js";

const ExitCodes = {
    SUCCESS: 0,
    GENERAL_ERROR: 1,
    NO_PACKAGE_NAME_SUPPLIED: 2,
    INVALID_PACKAGE_NAME_SUPPLIED: 3,
} as const;

const Files = {
    DEPS: "deep-pack-deps-log.txt",
} as const;

interface Options {
    maxDepth: number;
    devDeps: boolean;
    devRecursive: boolean;
    peerDeps: boolean;
    optionalDeps: boolean;
    outDeps: boolean;
    outputTgz: boolean;
}

const defaultOptions = {
    maxDepth: Infinity,
    devDeps: false,
    devRecursive: false,
    peerDeps: true,
    optionalDeps: false,
    outDeps: false,
    outputTgz: false,
} satisfies Options;

export default class Program {
    protected packageJSONData: Partial<Manifest> | undefined;
    protected options: Options = defaultOptions;
    public static tempDir: string = "";
    public static downloadedPackagesPath = new Map<string, number>();
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

    // Creates the output folder or an empty .tgz placeholder so a concurrent run cannot take the same name.
    private async chooseOutputPath(pkg: Package, outputTgz: boolean): Promise<string> {
        const extension = outputTgz ? ".tgz" : "";
        const basePath = path.resolve(
            `deep-pack-${sanitizePathComponent(pkg.normalizedNameForPath)}_${sanitizePathComponent(pkg.version)}`
        );
        const timestamp = timestampSuffix();

        for (let attempt = 0; ; attempt++) {
            const suffix = attempt === 0 ? "" : attempt === 1 ? `_${timestamp}` : `_${timestamp}-${attempt - 1}`;
            const outputPath = `${basePath}${suffix}${extension}`;
            try {
                if (outputTgz) await (await fsPromises.open(outputPath, "wx")).close();
                else await fsPromises.mkdir(outputPath);
                return outputPath;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
                if (attempt === 0) {
                    this.writeToShell(
                        `Warning: output destination exists (${outputPath}); using a timestamped output name instead.`,
                        undefined,
                        chalk.yellow
                    );
                }
            }
        }
    }

    protected async onAction(packageUserSuppliedName: string | undefined, options: Options) {
        this.options = { ...defaultOptions, ...options, maxDepth: options.maxDepth ?? Infinity };

        if (!packageUserSuppliedName) {
            this.writeToShell("No package spec was supplied. Run with --help for usage.", undefined, chalk.red);
            process.exitCode = ExitCodes.NO_PACKAGE_NAME_SUPPLIED;
            return;
        }

        let rootPackage: Package;
        try {
            rootPackage = await Package.fromString(packageUserSuppliedName);
        } catch (error) {
            if (error instanceof PackageSpecError) {
                if (error.kind === "invalid") {
                    this.writeToShell(error.message, undefined, chalk.red);
                    process.exitCode = ExitCodes.INVALID_PACKAGE_NAME_SUPPLIED;
                } else {
                    this.printSummary([], { fatalErrors: [error.message] });
                    process.exitCode = ExitCodes.GENERAL_ERROR;
                }
                return;
            }
            throw error;
        }

        if (Program.packageLockMode && options.maxDepth !== undefined) {
            this.writeToShell("--max-depth is ignored for a lock file", undefined, chalk.yellow);
        }

        if (Program.packageLockMode && this.options.devRecursive) {
            this.writeToShell("--dev-recursive has no effect on a lock file; dev entries are always included.", undefined, chalk.yellow);
        }

        Program.downloadedPackagesPath.clear();

        const discoveredDependencies = new Set<string>();
        const failures = new Map<string, Package>();
        let outputPath = "";
        let tempDir = "";
        let outputCompleted = false;
        let interrupted = false;
        let outputReservationPromise: Promise<string> | undefined;
        let tempCreationPromise: Promise<string> | undefined;
        let tarCreationPromise: Promise<void> | undefined;
        let interruptCleanupPromise: Promise<void> | undefined;

        const cleanupOnInterrupt = (): Promise<void> => {
            interrupted = true;
            if (interruptCleanupPromise) return interruptCleanupPromise;
            interruptCleanupPromise = (async () => {
                const reservedOutputPath = await outputReservationPromise?.catch(() => undefined);
                await tempCreationPromise?.catch(() => undefined);
                await tarCreationPromise?.catch(() => undefined);
                if (tempDir) await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
                if (reservedOutputPath) {
                    await fsPromises.rm(reservedOutputPath, { recursive: true, force: true }).catch(() => undefined);
                }
                Program.tempDir = "";
                await Promise.all([
                    new Promise<void>((resolve) => process.stdout.write("", () => resolve())),
                    new Promise<void>((resolve) => process.stderr.write("", () => resolve())),
                ]);
                process.exit(130);
            })();
            return interruptCleanupPromise;
        };

        // Install the handler before creating the output reservation placeholder.
        process.once("SIGINT", cleanupOnInterrupt);
        try {
            outputReservationPromise = this.chooseOutputPath(rootPackage, this.options.outputTgz);
            outputPath = await outputReservationPromise;
            tempCreationPromise = fsPromises.mkdtemp(path.join(os.tmpdir(), "deep-pack-"));
            tempDir = await tempCreationPromise;
            Program.tempDir = tempDir;

            const dependencies: Dependencies = new Dependencies(rootPackage);
            dependencies.on(DependenciesEvents.PACKAGE_DISCOVERED, (pkg: Package) => {
                discoveredDependencies.add(pkg.fullName);
            });
            dependencies.on(DependenciesEvents.PACKAGE_RESOLVED, (pkg: Package) => {
                this.writeToShell(`${pkg} resolved`, undefined, chalk.green);
            });
            const onFailure = (pkg: Package) => {
                failures.set(pkg.fullName, pkg);
                this.writeToShell(
                    `${pkg} failed. requested by: ${pkg.dependentOrDependentsToString() || "you"}`,
                    undefined,
                    chalk.yellow
                );
            };
            dependencies.on(DependenciesEvents.PACKAGE_RESOLVE_ERROR, onFailure);
            dependencies.on(DependenciesEvents.PACKAGE_DOWNLOAD_ERROR, onFailure);

            await dependencies.load(
                this.options.maxDepth,
                this.options.devDeps,
                this.options.devRecursive,
                this.options.peerDeps,
                this.options.optionalDeps
            );

            if (this.options.outDeps) {
                const dependenciesLog = [...discoveredDependencies].join(os.EOL);
                await fsPromises.writeFile(
                    path.join(tempDir, Files.DEPS),
                    dependenciesLog ? `${dependenciesLog}${os.EOL}` : ""
                );
            }

            if (this.options.outputTgz) {
                const tar = await import("tar");
                const entries = await fsPromises.readdir(tempDir);
                // tar treats an entry beginning with "@" as a list-file argument.
                // Prefix entries with "./" so scoped-package tarballs are added as files.
                tarCreationPromise = tar.create(
                    { gzip: true, file: outputPath, cwd: tempDir },
                    entries.map((entry) => `./${entry}`)
                ).then(() => undefined);
                await tarCreationPromise;
            } else {
                const entries = await fsPromises.readdir(tempDir);
                for (const entry of entries) {
                    await moveFile(path.join(tempDir, entry), path.join(outputPath, entry));
                }
            }
            outputCompleted = true;

            let bundleSize: number | undefined;
            if (this.options.outputTgz) {
                bundleSize = (await fsPromises.stat(outputPath)).size;
            }
            const { errors } = this.printSummary([...failures.values()], { outputPath, bundleSize });
            if (errors.length > 0) process.exitCode = ExitCodes.GENERAL_ERROR;
        } catch (error) {
            if (interrupted) return;
            this.writeToShell(`Failed to finish deep-pack: ${errorMessage(error)}`, undefined, chalk.red);
            this.printSummary([...failures.values()], { fatalErrors: [errorMessage(error)] });
            process.exitCode = ExitCodes.GENERAL_ERROR;
        } finally {
            process.removeListener("SIGINT", cleanupOnInterrupt);
            if (interrupted) {
                await interruptCleanupPromise;
            } else {
                if (tempDir) await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
                if (!outputCompleted && outputPath) {
                    await fsPromises.rm(outputPath, { recursive: true, force: true }).catch(() => undefined);
                }
                Program.tempDir = "";
            }
        }
    }

    private printSummary(
        failures: Package[],
        { outputPath, bundleSize, fatalErrors = [] }: { outputPath?: string; bundleSize?: number; fatalErrors?: string[] } = {}
    ) {
        const isWarning = (pkg: Package) => pkg.warning || pkg.optionalEdge === true;
        const warnings = failures.filter(isWarning);
        const errors = failures.filter((pkg) => !isWarning(pkg));
        const totalSize = [...Program.downloadedPackagesPath.values()].reduce((sum, size) => sum + size, 0);

        this.writeToShell("==================== Summary ====================", undefined, chalk.white);
        if (outputPath) this.writeToShell(`Output: ${outputPath}`);
        this.writeToShell(`Downloaded: ${Program.downloadedPackagesPath.size} packages, ${outputSize(totalSize)}`);
        if (bundleSize !== undefined) this.writeToShell(`Bundle size: ${outputSize(bundleSize)}`);

        const printFailures = (label: string, packages: Package[], color: ChalkInstance, count = packages.length) => {
            this.writeToShell(`${label} (${count})`, undefined, color);
            for (const pkg of packages) {
                this.writeToShell(
                    `- ${pkg.fullName}, requested by ${pkg.dependentOrDependentsToString() || "you"}: ${pkg.failureReason ?? "unknown error"}`,
                    undefined,
                    color
                );
            }
        };

        printFailures("Warnings", warnings, chalk.yellow);
        printFailures("Errors", errors, chalk.red, errors.length + fatalErrors.length);
        for (const error of fatalErrors) {
            this.writeToShell(`- deep-pack: ${error}`, undefined, chalk.red);
        }
        this.writeToShell("==================================================", undefined, chalk.white);
        return { warnings, errors };
    }

    protected setArgs() {
        program.argument(
            "[spec]",
            "Package name (and optionally version), or path to a package.json or package-lock.json file. For example, next[@15], ./package.json or ./package-lock.json"
        );
    }

    protected setOptions() {
        program.option(
            `-d, --max-depth <depth>`,
            "maximum dependency depth (positive integer; default: unlimited)",
            (value: string) => {
                const parsed = Number.parseInt(value, 10);
                if (!/^\d+$/.test(value) || parsed <= 0) {
                    throw new InvalidArgumentError("max-depth must be a positive integer");
                }
                return parsed;
            }
        );
        program.option(`--dev, --dev-deps`, "Resolve root devDependencies (always on for package.json and lock files)", false);
        program.option(`--dev-deps-recursive, --dev-recursive`, "Resolve devDependencies at every level", false);
        program.option(`--no-peer, --no-peer-deps`, "Don't resolve peerDependencies");
        program.option(`--optional, --optional-deps`, "Resolve optionalDependencies (and the root's optional peers)", false);
        program.option(`--out-deps`, "Write the discovered dependencies list into the output", false);
        program.option(`--tgz, --output-tgz`, "Bundle output to tgz", false);
    }

    protected setActions() {
        program.action(this.onAction.bind(this));
    }

    // Like `clear` in modern terminals: scroll the current screen into the scrollback (nothing is erased
    // or cut) and put the cursor at the top. Skipped when output isn't a terminal.
    public clearShell() {
        if (!process.stdout.isTTY) return;
        process.stdout.write("\n".repeat(process.stdout.rows) + "\x1B[H");
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
