/**
 * Integration test: loads the real reprompt extension through omp's
 * extension loader and verifies the /reprompt command is registered
 * (appears in autocomplete / command palette).
 *
 * Unlike handler.test.ts (which tests handler logic with mocks), this
 * test exercises the full loading path: legacy compat shim → dynamic
 * import → factory invocation → registerCommand → Extension.commands map.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { loadExtensions } from "../loader";
import type { Extension, LoadExtensionsResult, RegisteredCommand } from "../types";

const REPROMPT_EXTENSION_DIR = path.join(os.homedir(), ".omp", "agent", "extensions", "reprompt");

afterEach(() => {
	// No mocks to restore, but keep the hook for consistency.
});

describe("reprompt extension integration", () => {
	it("loads without errors", async () => {
		const result: LoadExtensionsResult = await loadExtensions(
			[path.join(REPROMPT_EXTENSION_DIR, "index.ts")],
			os.homedir(),
		);

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
	});

	it("registers a command named 'reprompt'", async () => {
		const result = await loadExtensions([path.join(REPROMPT_EXTENSION_DIR, "index.ts")], os.homedir());

		const ext: Extension | undefined = result.extensions[0];
		expect(ext).toBeDefined();

		const cmd: RegisteredCommand | undefined = ext!.commands.get("reprompt");
		expect(cmd).toBeDefined();
		expect(cmd!.name).toBe("reprompt");
	});

	it("command has a description for autocomplete display", async () => {
		const result = await loadExtensions([path.join(REPROMPT_EXTENSION_DIR, "index.ts")], os.homedir());

		const cmd = result.extensions[0]!.commands.get("reprompt");
		expect(cmd!.description).toContain("Reformat");
		expect(cmd!.description).toContain("smol");
	});

	it("command has a callable handler", async () => {
		const result = await loadExtensions([path.join(REPROMPT_EXTENSION_DIR, "index.ts")], os.homedir());

		const cmd = result.extensions[0]!.commands.get("reprompt");
		expect(typeof cmd!.handler).toBe("function");
	});

	it("does not register any other commands or tools", async () => {
		const result = await loadExtensions([path.join(REPROMPT_EXTENSION_DIR, "index.ts")], os.homedir());

		const ext = result.extensions[0]!;
		expect(ext.commands.size).toBe(1);
		expect(ext.tools.size).toBe(0);
	});
});
