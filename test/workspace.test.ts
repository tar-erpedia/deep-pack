import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorkspace } from "../src/workspace.js";

const originalCwd = process.cwd();
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "deep-pack-ws-test-"));
process.chdir(cwd);
after(() => {
    process.chdir(originalCwd);
    fs.rmSync(cwd, { recursive: true, force: true });
});

test("a taken output name gets a timestamped name and is reported once", () => {
    const taken: string[] = [];
    const first = createWorkspace("@scope/pkg", "1.0.0", false, (p) => taken.push(p));
    const second = createWorkspace("@scope/pkg", "1.0.0", false, (p) => taken.push(p));
    try {
        assert.equal(path.basename(first.outputPath), "deep-pack-@scope_pkg_1.0.0");
        assert.match(path.basename(second.outputPath), /^deep-pack-@scope_pkg_1\.0\.0_\d{8}-\d{6}$/);
        assert.deepEqual(taken, [first.outputPath]);
    } finally {
        first.dispose();
        second.dispose();
    }
});

test("--tgz reserves an empty .tgz placeholder", () => {
    const ws = createWorkspace("tgz-pkg", "2.0.0", true, () => {});
    try {
        assert.equal(path.basename(ws.outputPath), "deep-pack-tgz-pkg_2.0.0.tgz");
        assert.equal(fs.statSync(ws.outputPath).size, 0);
    } finally {
        ws.dispose();
    }
});

test("dispose removes the temp dir and keeps the output; discardOutput removes the output", () => {
    const ws = createWorkspace("clean-pkg", "3.0.0", false, () => {});
    assert.ok(fs.existsSync(ws.tempDir));
    ws.dispose();
    assert.equal(fs.existsSync(ws.tempDir), false);
    assert.ok(fs.existsSync(ws.outputPath));
    ws.discardOutput();
    assert.equal(fs.existsSync(ws.outputPath), false);
});

test("dispose removes the SIGINT handler", () => {
    const before = process.listenerCount("SIGINT");
    const ws = createWorkspace("sig-pkg", "1.0.0", false, () => {});
    assert.equal(process.listenerCount("SIGINT"), before + 1);
    ws.dispose();
    assert.equal(process.listenerCount("SIGINT"), before);
    ws.discardOutput();
});
