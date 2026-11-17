import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizePathComponent, timestampSuffix } from "./utils.js";

export interface Workspace {
    outputPath: string;
    tempDir: string;
    discardOutput(): void;
    dispose(): void;
}

const remove = (target: string) => fs.rmSync(target, { recursive: true, force: true });

// Creates the output folder (or an empty .tgz placeholder, so a concurrent run cannot take the same name) and a
// temp dir for downloads. Both are created synchronously: no signal can arrive between creating them and knowing
// about them, so Ctrl+C cleanup can be synchronous too (it must finish before process.exit).
export function createWorkspace(
    name: string,
    version: string,
    outputTgz: boolean,
    onOutputExists: (existingPath: string) => void
): Workspace {
    const extension = outputTgz ? ".tgz" : "";
    const basePath = path.resolve(`deep-pack-${sanitizePathComponent(name)}_${sanitizePathComponent(version)}`);
    const timestamp = timestampSuffix();

    let outputPath: string;
    for (let attempt = 0; ; attempt++) {
        const suffix = attempt === 0 ? "" : attempt === 1 ? `_${timestamp}` : `_${timestamp}-${attempt - 1}`;
        outputPath = `${basePath}${suffix}${extension}`;
        try {
            if (outputTgz) fs.closeSync(fs.openSync(outputPath, "wx"));
            else fs.mkdirSync(outputPath);
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (attempt === 0) onOutputExists(outputPath);
        }
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-pack-"));
    const abort = () => {
        remove(tempDir);
        remove(outputPath);
        process.exit(130);
    };
    process.once("SIGINT", abort);

    return {
        outputPath,
        tempDir,
        discardOutput: () => remove(outputPath),
        dispose: () => {
            process.off("SIGINT", abort);
            remove(tempDir);
        },
    };
}
