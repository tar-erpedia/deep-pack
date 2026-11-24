import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizePathComponent, timestampSuffix } from "./utils.js";

export interface Workspace {
    outputPath: string;
    tempDir: string;
}

// Cleanup must never throw over the real result; maxRetries rides out Windows EBUSY/EPERM from open handles.
function remove(target: string) {
    try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
    } catch (_error) {}
}

// Creates the output folder, or an empty .tgz placeholder, so a concurrent run cannot take the same name.
function reserveOutputPath(name: string, version: string, outputTgz: boolean, onOutputExists: (existingPath: string) => void) {
    const extension = outputTgz ? ".tgz" : "";
    const basePath = path.resolve(`deep-pack-${sanitizePathComponent(name)}_${sanitizePathComponent(version)}`);
    const timestamp = timestampSuffix();

    for (let attempt = 0; ; attempt++) {
        const suffix = attempt === 0 ? "" : attempt === 1 ? `_${timestamp}` : `_${timestamp}-${attempt - 1}`;
        const outputPath = `${basePath}${suffix}${extension}`;
        try {
            if (outputTgz) fs.closeSync(fs.openSync(outputPath, "wx"));
            else fs.mkdirSync(outputPath);
            return outputPath;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (attempt === 0) onOutputExists(outputPath);
        }
    }
}

// Runs work with a reserved output path and a temp dir. The temp dir is always removed; the output is removed if
// work fails or the user presses Ctrl+C. Setup is synchronous so no signal can arrive between creating a path and
// knowing about it, and the Ctrl+C cleanup is synchronous because it must finish before process.exit.
export async function withWorkspace<T>(
    name: string,
    version: string,
    outputTgz: boolean,
    onOutputExists: (existingPath: string) => void,
    work: (workspace: Workspace) => Promise<T>
): Promise<T> {
    const outputPath = reserveOutputPath(name, version, outputTgz, onOutputExists);
    let tempDir: string;
    try {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-pack-"));
    } catch (error) {
        remove(outputPath);
        throw error;
    }

    const abort = () => {
        remove(tempDir);
        remove(outputPath);
        // Exit at once: waiting (e.g. to flush stdout) lets in-flight downloads recreate files we just removed.
        process.exit(130);
    };
    process.once("SIGINT", abort);
    try {
        return await work({ outputPath, tempDir });
    } catch (error) {
        remove(outputPath);
        throw error;
    } finally {
        process.off("SIGINT", abort);
        remove(tempDir);
    }
}
