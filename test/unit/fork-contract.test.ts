import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (file: string) => fs.readFileSync(new URL(file, root), "utf8");

test("the Git-distributed fork has its own identity and no standalone installer or publish entrypoint", () => {
	const manifest = JSON.parse(read("package.json"));
	const lock = JSON.parse(read("package-lock.json"));
	assert.equal(manifest.name, "pi-subagents-cc");
	assert.equal(lock.name, manifest.name);
	assert.equal(lock.packages[""].name, manifest.name);
	assert.equal(manifest.private, true);
	assert.equal(manifest.bin, undefined);
	assert.equal(lock.packages[""].bin, undefined);
	assert.equal(manifest.repository.url, "git+https://github.com/ttaatoo/pi-subagents-cc.git");
	assert.equal(manifest.bugs.url, "https://github.com/ttaatoo/pi-subagents-cc/issues");
	assert.equal(fs.existsSync(new URL("install.mjs", root)), false);
	assert.equal(fs.existsSync(new URL(".github/workflows/release.yml", root)), false);
	assert.match(read("scripts/build-package.mjs"), /private: true/);
});

test("README documents current tools and uses installed-version references", () => {
	const readme = read("README.md");
	assert.match(readme, /does not register `Agent`/);
	assert.match(readme, /pi remove https:\/\/github\.com\/ttaatoo\/pi-subagents-cc/);
	assert.doesNotMatch(readme, /calling conventions|extensions\/subagent-cc|nicobailon\/pi-subagents\/blob\/main\/docs/);
	for (const match of readme.matchAll(/\]\((docs\/[^)#]+)(?:#[^)]*)?\)/g)) {
		assert.ok(fs.existsSync(new URL(match[1]!, root)), fileURLToPath(new URL(match[1]!, root)));
	}
});
