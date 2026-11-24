import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withWorkspace } from "../src/workspace.js";

// node --test runs each test file in its own process, so changing cwd here does not leak into other files.
const originalCwd = process.cwd();
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "deep-pack-ws-test-"));
process.chdir(cwd);
after(() => {
    process.chdir(originalCwd);
    fs.rmSync(cwd, { recursive: true, force: true });
});

const noop = () => {};

test("a taken output name gets a timestamped name and is reported once", async () => {
    const taken: string[] = [];
    const first = await withWorkspace("@scope/pkg", "1.0.0", false, (p) => taken.push(p), async (ws) => ws.outputPath);
    const second = await withWorkspace("@scope/pkg", "1.0.0", false, (p) => taken.push(p), async (ws) => ws.outputPath);
    assert.equal(path.basename(first), "deep-pack-@scope_pkg_1.0.0");
    assert.match(path.basename(second), /^deep-pack-@scope_pkg_1\.0\.0_\d{8}-\d{6}$/);
    assert.deepEqual(taken, [first]);
});

test("--tgz reserves an empty .tgz placeholder", async () => {
    await withWorkspace("tgz-pkg", "2.0.0", true, noop, async (ws) => {
        assert.equal(path.basename(ws.outputPath), "deep-pack-tgz-pkg_2.0.0.tgz");
        assert.equal(fs.statSync(ws.outputPath).size, 0);
    });
});

test("success keeps the output, removes the temp dir and the SIGINT handler", async () => {
    const listeners = process.listenerCount("SIGINT");
    const ws = await withWorkspace("ok-pkg", "1.0.0", false, noop, async (ws) => {
        assert.equal(process.listenerCount("SIGINT"), listeners + 1);
        return ws;
    });
    assert.ok(fs.existsSync(ws.outputPath));
    assert.equal(fs.existsSync(ws.tempDir), false);
    assert.equal(process.listenerCount("SIGINT"), listeners);
});

test("failure removes the output and the temp dir and rethrows", async () => {
    let seen: { outputPath: string; tempDir: string } | undefined;
    await assert.rejects(
        withWorkspace("fail-pkg", "1.0.0", false, noop, async (ws) => {
            seen = ws;
            throw new Error("boom");
        }),
        /boom/
    );
    assert.equal(fs.existsSync(seen!.outputPath), false);
    assert.equal(fs.existsSync(seen!.tempDir), false);
});

test("if the temp dir cannot be created, the reserved output is removed", async () => {
    const tempVars = ["TEMP", "TMP", "TMPDIR"] as const;
    const saved = tempVars.map((name) => process.env[name]);
    for (const name of tempVars) process.env[name] = path.join(cwd, "does-not-exist");
    try {
        await assert.rejects(withWorkspace("no-temp-pkg", "1.0.0", false, noop, async () => {}));
    } finally {
        tempVars.forEach((name, i) => (saved[i] === undefined ? delete process.env[name] : (process.env[name] = saved[i])));
    }
    assert.equal(fs.existsSync(path.join(cwd, "deep-pack-no-temp-pkg_1.0.0")), false);
});

test("a cleanup error does not replace the real result", async () => {
    const realRmSync = fs.rmSync;
    let tempDir = "";
    fs.rmSync = () => {
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    };
    try {
        const result = await withWorkspace("locked-pkg", "1.0.0", false, noop, async (ws) => {
            tempDir = ws.tempDir;
            return "done";
        });
        assert.equal(result, "done");
    } finally {
        fs.rmSync = realRmSync;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
