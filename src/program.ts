import chalk, { type ChalkInstance } from "chalk";
import { program } from "commander";
import figlet, { type FigletOptions } from "figlet";
import path from "node:path";
import Package, { PackageSpecError } from "./package.js";
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
} as const;

interface Options {
    maxDepth: number;
    devDeps: boolean;
    devRecursive: boolean;
    lock?: string;
    peerDeps: boolean;
    optionalDeps: boolean;
    outDeps: boolean;
    outputTgz: boolean;
}

const defaultOptions = {
    maxDepth: Infinity,
    devDeps: false,
    devRecursive: false,
    lock: undefined,
    peerDeps: true,
    optionalDeps: false,
    outDeps: false,
    outputTgz: false,
} satisfies Options;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function sanitizePathComponent(value: string): string {
    let component = value.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_").replace(/[. ]+$/g, "");
    if (!component) component = "_";

    const deviceName = component.split(".")[0] ?? "";
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(deviceName)) {
        component = `_${component}`;
    }
    return component;
}

function outputSize(size: number): string {
    if (size < 1024) return `${size} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = size / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(1)} ${units[unit]}`;
}

function timestampSuffix(date: Date = new Date()): string {
    const pad = (value: number) => value.toString().padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function moveFile(source: string, destination: string): Promise<void> {
    try {
        await fsPromises.rename(source, destination);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        await fsPromises.copyFile(source, destination);
        await fsPromises.rm(source);
    }
}

export default class Program {
    protected packageJSONData: Partial<Manifest> | undefined;
    protected options: Options = defaultOptions;
    public static outputPath: string = "";
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

    private async chooseOutputPath(pkg: Package, outputTgz: boolean): Promise<string> {
        const cwd = path.resolve(process.cwd());
        const extension = outputTgz ? ".tgz" : "";
        let baseName = `deep-pack-${sanitizePathComponent(pkg.normalizedNameForPath)}_${sanitizePathComponent(pkg.version)}`;
        const resolveOutputName = (candidate: string) => {
            const resolved = path.resolve(cwd, candidate);
            return path.dirname(resolved) === cwd ? resolved : path.resolve(cwd, `deep-pack-package_0.0.0${extension}`);
        };
        let outputName = `${baseName}${extension}`;
        let outputPath = resolveOutputName(outputName);
        if (path.basename(outputPath) !== outputName) {
            baseName = "deep-pack-package_0.0.0";
            outputName = `${baseName}${extension}`;
            outputPath = resolveOutputName(outputName);
        }
        let warned = false;
        let timestamp = "";
        let timestampAttempt = 0;
        let reservedOutput = false;

        while (true) {
            if (fs.existsSync(outputPath)) {
                if (!warned) {
                    this.writeToShell(
                        `Warning: output destination exists (${outputPath}); using a timestamped output name instead.`,
                        undefined,
                        chalk.yellow
                    );
                    warned = true;
                }
                timestamp ||= timestampSuffix();
                const suffix = timestampAttempt === 0 ? timestamp : `${timestamp}-${timestampAttempt}`;
                timestampAttempt++;
                outputName = `${baseName}_${suffix}${extension}`;
                outputPath = resolveOutputName(outputName);
                if (path.basename(outputPath) !== outputName) {
                    baseName = "deep-pack-package_0.0.0";
                    outputName = `${baseName}_${suffix}${extension}`;
                    outputPath = resolveOutputName(outputName);
                }
                continue;
            }

            // Reserve the path now so a concurrent run cannot overwrite it later.
            let reservationHandle: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
            try {
                if (outputTgz) {
                    reservationHandle = await fsPromises.open(outputPath, "wx");
                    Program.outputPath = outputPath;
                    reservedOutput = true;
                    await reservationHandle.close();
                    reservationHandle = undefined;
                } else {
                    await fsPromises.mkdir(outputPath);
                    Program.outputPath = outputPath;
                    reservedOutput = true;
                }
                break;
            } catch (error) {
                if (reservedOutput) {
                    await reservationHandle?.close().catch(() => undefined);
                    await fsPromises.rm(outputPath, { recursive: true, force: true });
                    if (Program.outputPath === outputPath) Program.outputPath = "";
                    reservedOutput = false;
                }
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            }
        }
        Program.outputPath = outputPath;
        return outputPath;
    }

    protected async onAction(packageUserSuppliedName: string | undefined, options: Options) {
        this.options = { ...defaultOptions, ...options, maxDepth: options.maxDepth ?? Infinity };

        if (!this.options.lock && !packageUserSuppliedName) {
            this.writeToShell("No package name or --lock path was supplied. Run with --help for usage.", undefined, chalk.red);
            process.exitCode = ExitCodes.NO_PACKAGE_NAME_SUPPLIED;
            return;
        }

        let rootPackage: Package;
        try {
            rootPackage = this.options.lock
                ? await Package.fromPackageLock(
                      this.options.lock,
                      this.options.devDeps || this.options.devRecursive,
                      this.options.peerDeps,
                      this.options.optionalDeps
                  )
                : await Package.fromString(packageUserSuppliedName!);
        } catch (error) {
            if (error instanceof PackageSpecError) {
                if (error.kind === "invalid") {
                    this.writeToShell(error.message, undefined, chalk.red);
                    process.exitCode = ExitCodes.INVALID_PACKAGE_NAME_SUPPLIED;
                } else {
                    this.printSummary(undefined, 0, 0, [], [], undefined, [error.message]);
                    process.exitCode = ExitCodes.GENERAL_ERROR;
                }
                return;
            }
            throw error;
        }

        if (this.options.lock && options.maxDepth !== undefined) {
            this.writeToShell("--max-depth is ignored in lock mode", undefined, chalk.yellow);
        }

        if (Program.packageLockMode && this.options.devRecursive) {
            this.writeToShell("--dev-recursive is equivalent to --dev in lock mode.", undefined, chalk.yellow);
        }

        // Choose and reserve the output path before dependency traversal begins.
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
                await outputReservationPromise?.catch(() => undefined);
                await tempCreationPromise?.catch(() => undefined);
                await tarCreationPromise?.catch(() => undefined);
                if (tempDir) await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
                const reservedOutputPath = outputPath || Program.outputPath;
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
            Program.outputPath = "";
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
            dependencies.on(DependenciesEvents.PACKAGE_RESOLVE_ERROR, (pkg: Package) => {
                failures.set(pkg.fullName, pkg);
                this.writeToShell(
                    `${pkg} failed. requested by: ${pkg.dependentOrDependentsToString() || "you"}`,
                    undefined,
                    chalk.yellow
                );
            });
            dependencies.on(DependenciesEvents.PACKAGE_DOWNLOAD_ERROR, (pkg: Package) => {
                failures.set(pkg.fullName, pkg);
                this.writeToShell(
                    `${pkg} failed. requested by: ${pkg.dependentOrDependentsToString() || "you"}`,
                    undefined,
                    chalk.yellow
                );
            });

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

            const totalSize = [...Program.downloadedPackagesPath.values()].reduce((sum, size) => sum + size, 0);
            const warnings = [...failures.values()].filter((pkg) => pkg.warning || pkg.optionalEdge === true);
            const errors = [...failures.values()].filter((pkg) => !pkg.warning && pkg.optionalEdge !== true);
            let bundleSize: number | undefined;
            if (this.options.outputTgz) {
                const bundleStat = await fsPromises.stat(outputPath);
                bundleSize = bundleStat.size;
            }
            this.printSummary(outputPath, Program.downloadedPackagesPath.size, totalSize, warnings, errors, bundleSize);
            if (errors.length > 0) process.exitCode = ExitCodes.GENERAL_ERROR;
        } catch (error) {
            if (interrupted) return;
            this.writeToShell(`Failed to finish deep-pack: ${errorMessage(error)}`, undefined, chalk.red);
            const reservedOutputPath = outputPath || Program.outputPath;
            if (!outputCompleted && reservedOutputPath) {
                await fsPromises.rm(reservedOutputPath, { recursive: true, force: true }).catch(() => undefined);
            }
            const totalSize = [...Program.downloadedPackagesPath.values()].reduce((sum, size) => sum + size, 0);
            const warnings = [...failures.values()].filter((pkg) => pkg.warning || pkg.optionalEdge === true);
            const errors = [...failures.values()].filter((pkg) => !pkg.warning && pkg.optionalEdge !== true);
            this.printSummary(undefined, Program.downloadedPackagesPath.size, totalSize, warnings, errors, undefined, [errorMessage(error)]);
            process.exitCode = ExitCodes.GENERAL_ERROR;
        } finally {
            process.removeListener("SIGINT", cleanupOnInterrupt);
            if (interrupted) {
                await interruptCleanupPromise;
            } else {
                if (tempDir) await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
                const reservedOutputPath = outputPath || Program.outputPath;
                if (!outputCompleted && reservedOutputPath) {
                    await fsPromises.rm(reservedOutputPath, { recursive: true, force: true }).catch(() => undefined);
                }
                Program.tempDir = "";
            }
        }
    }

    private printSummary(
        outputPath: string | undefined,
        packageCount: number,
        totalSize: number,
        warnings: Package[],
        errors: Package[],
        bundleSize?: number,
        fatalErrors: string[] = []
    ) {
        this.writeToShell("==================== Summary ====================", undefined, chalk.white);
        if (outputPath) this.writeToShell(`Output: ${outputPath}`);
        this.writeToShell(`Downloaded: ${packageCount} packages, ${outputSize(totalSize)}`);
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
    }

    protected setArgs() {
        program.argument(
            "[spec]",
            "Package name (and optionally version) or path to a package manifest file (any name). For example, next[@15] or ./package.json"
        );
    }

    protected setOptions() {
        program.option(
            `-d, --max-depth <depth>`,
            "maximum dependency depth (positive integer; default: unlimited)",
            (value: string) => {
                const parsed = Number.parseInt(value, 10);
                if (!/^\d+$/.test(value) || !Number.isInteger(parsed) || parsed <= 0) {
                    throw new Error("max-depth must be a positive integer");
                }
                return parsed;
            }
        );
        program.option(`--dev, --dev-deps`, "Resolve root devDependencies", false);
        program.option(`--dev-deps-recursive, --dev-recursive`, "Resolve devDependencies at every level", false);
        program.option(`-l, --lock <path>`, "Path to a package-lock.json file with exact package versions");
        program.option(`--no-peer, --no-peer-deps`, "Don't resolve peerDependencies");
        program.option(`--optional, --optional-deps`, "Resolve optionalDependencies (and the root's optional peers)", false);
        program.option(`--out-deps`, "Write the discovered dependencies list into the output", false);
        program.option(`--tgz, --output-tgz`, "Bundle output to tgz", false);
    }

    protected setActions() {
        program.action(this.onAction.bind(this));
    }

    public clearShell() {
        process.stdout.write("\x1B[2J\x1B[H");
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
        program.exitOverride();

        try {
            await program.parseAsync(process.argv);
        } catch (error) {
            const commanderCode = (error as { code?: string }).code;
            if (commanderCode === "commander.helpDisplayed" || commanderCode === "commander.version") return;
            this.writeToShell(`Failed to finish deep-pack: ${errorMessage(error)}`, undefined, chalk.red);
            if (Program.tempDir) {
                await fsPromises.rm(Program.tempDir, { recursive: true, force: true }).catch(() => undefined);
            }
            if (Program.outputPath) {
                await fsPromises.rm(Program.outputPath, { recursive: true, force: true }).catch(() => undefined);
            }
            const totalSize = [...Program.downloadedPackagesPath.values()].reduce((sum, size) => sum + size, 0);
            this.printSummary(undefined, Program.downloadedPackagesPath.size, totalSize, [], [], undefined, [errorMessage(error)]);
            Program.tempDir = "";
            process.exitCode = ExitCodes.GENERAL_ERROR;
        }
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
