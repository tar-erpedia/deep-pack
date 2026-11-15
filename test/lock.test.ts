import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Package from "../src/package.js";

const lock = {
    name: "root",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
        "": { name: "root" },
        "node_modules/prod": { version: "1.0.0" },
        "node_modules/dev-only": { version: "1.0.0", dev: true },
        "node_modules/dev-optional": { version: "1.0.0", devOptional: true },
        "node_modules/opt": { version: "1.0.0", optional: true },
        "node_modules/peer-dep": { version: "1.0.0", peer: true },
        "node_modules/linked": { link: true },
        "node_modules/from-git": { version: "1.0.0", resolved: "git+ssh://git@github.com/a/b.git#abc" },
    },
};

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-pack-test-"));
after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function writeJson(name: string, data: unknown) {
    const file = path.join(tempDir, name);
    fs.writeFileSync(file, JSON.stringify(data));
    return file;
}

async function lockDependencies(includePeer: boolean, includeOptional: boolean) {
    const root = await Package.fromString(writeJson("any-name.json", lock));
    const deps = await root.getDependencies(false, includePeer, includeOptional);
    return Object.fromEntries(deps.map((dep) => [dep.name, dep]));
}

test("lock file is detected by content and includes dev entries by default", async () => {
    const deps = await lockDependencies(true, false);
    assert.deepEqual(Object.keys(deps).sort(), ["dev-only", "dev-optional", "from-git", "peer-dep", "prod"]);
    assert.equal(deps["from-git"]?.warning, true);
});

test("--optional adds optional entries, --no-peer drops peers", async () => {
    const deps = await lockDependencies(false, true);
    assert.deepEqual(Object.keys(deps).sort(), ["dev-only", "dev-optional", "from-git", "opt", "prod"]);
    assert.equal(deps["opt"]?.optionalEdge, true);
});

test("a file without lockfileVersion is read as a package.json", async () => {
    const root = await Package.fromString(writeJson("manifest.json", { name: "app", version: "2.0.0" }));
    assert.equal(root.fullName, "app@2.0.0");
    assert.equal(root.manifest?.name, "app");
});
