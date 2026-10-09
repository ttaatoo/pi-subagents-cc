import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../src/shared/utils.ts";
import { resolveInstalledPiPackageRoot } from "../../src/runs/shared/pi-spawn.ts";

/**
 * Boots the real extension in a subprocess and fires `input` events at the
 * `@mention` router. Only exercises paths that never launch children
 * (continue/transform); live steer, resume, and spawn execution are covered
 * by `mention.test.ts` with stub actions plus the existing fleet suites.
 */
describe("@mention input wiring", () => {
	it("routes @ text without launching work", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "mention-input-"));
		const env = { ...process.env, PI_CODING_AGENT_DIR: home };
		if (!env[PI_CODING_AGENT_PACKAGE_ROOT_ENV]) {
			const hostRoot = resolveInstalledPiPackageRoot();
			if (hostRoot) env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = hostRoot;
		}
		try {
			const output = execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", String.raw`
				import assert from "node:assert/strict";
				import fs from "node:fs";
				import path from "node:path";
				import register from "./src/extension/index.ts";
				const home = process.env.PI_CODING_AGENT_DIR;
				const cwd = path.join(home, "project");
				fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
				fs.mkdirSync(path.join(home, "agents"), { recursive: true });
				const handlers = new Map();
				const pi = new Proxy({
					events: { on() { return () => {}; }, emit() {} },
					on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
					registerTool() {},
					getActiveTools() { return ["subagent"]; },
				}, { get(target, key) { return key in target ? target[key] : () => undefined; } });
				register(pi);
				const inputHandlers = handlers.get("input") ?? [];
				const ctx = {
					cwd, hasUI: false, model: { provider: "test", id: "test" },
					ui: { notify() {} },
					modelRegistry: { getAvailable() { return []; }, getAll() { return []; } },
					sessionManager: { getSessionId() { return "mention-input-test"; }, getSessionFile() { return undefined; }, getBranch() { return []; } },
				};
				// Other features (e.g. watchdog) also listen on "input"; find the
				// mention router by behavior, not by registration order.
				let router = undefined;
				for (const handler of inputHandlers) {
					const probe = await handler({ type: "input", text: "@main probe-token", source: "interactive" }, ctx);
					if (probe && probe.action === "transform" && probe.text === "probe-token") { router = handler; break; }
				}
				assert.ok(router, "mention input router must be registered");
				const fire = (text, source = "interactive", images = undefined) =>
					router({ type: "input", text, ...(images ? { images } : {}), source }, ctx);
				assert.equal(await fire("hello"), undefined);
				assert.equal(await fire("@scout"), undefined);
				assert.equal(await fire("@unknown go"), undefined);
				assert.equal(await fire("@reviewer look", "extension"), undefined);
				assert.equal(await fire("@reviewer look", "interactive", [{ type: "image" }]), undefined);
				assert.deepEqual(await fire("@main please continue"), { action: "transform", text: "please continue" });
				assert.equal(await fire("@main"), undefined);
				console.log("mention-input-wiring-ok");
			`], { cwd: process.cwd(), env, stdio: "pipe" }).toString();
			assert.match(output, /mention-input-wiring-ok/);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});
});
