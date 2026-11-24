import fsPromises from "node:fs/promises";

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function sanitizePathComponent(value: string): string {
    let component = value.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_").replace(/[. ]+$/g, "");
    if (!component) component = "_";

    const deviceName = component.split(".")[0] ?? "";
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(deviceName)) {
        component = `_${component}`;
    }
    return component;
}

export function outputSize(size: number): string {
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

export function timestampSuffix(): string {
    const date = new Date();
    const pad = (value: number) => value.toString().padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export async function moveFile(source: string, destination: string): Promise<void> {
    try {
        await fsPromises.rename(source, destination);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        await fsPromises.copyFile(source, destination);
        await fsPromises.rm(source);
    }
}
