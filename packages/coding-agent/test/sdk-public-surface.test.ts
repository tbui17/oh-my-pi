import { describe, expect, it } from "bun:test";
import * as evalApi from "../src/eval";
import type { ExtensionContext } from "../src/extensibility/extensions";
import * as api from "../src/index";

describe("@oh-my-pi/pi-coding-agent root API", () => {
	it("does not expose local legacy SDK shims", () => {
		expect("defineTool" in api).toBe(false);
		expect("DefaultResourceLoader" in api).toBe(false);
		expect("SettingsManager" in api).toBe(false);
	});

	it("keeps parseFrontmatter available from the package root", () => {
		expect(typeof api.parseFrontmatter).toBe("function");
	});

	it("exports runEvalAgent and its types from the eval barrel", () => {
		expect(typeof evalApi.runEvalAgent).toBe("function");
		expect(evalApi.EVAL_AGENT_BRIDGE_NAME).toBe("__agent__");
		expect(typeof evalApi.EVAL_AGENT_MAX_DEPTH).toBe("number");
	});
});

describe("ExtensionContext.getToolSession", () => {
	it("is present on the ExtensionContext type as an optional accessor", () => {
		// Compile-time check: getToolSession is a member of ExtensionContext.
		// Runtime check: a minimal object satisfying ExtensionContext exposes it as undefined.
		const ctx = {
			ui: {} as never,
			hasUI: false,
			cwd: "/tmp",
			sessionManager: {} as never,
			modelRegistry: {} as never,
			model: undefined,
			models: {} as never,
			isIdle: () => true,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getSystemPrompt: () => [],
			getToolSession: undefined,
			getContextUsage: () => undefined,
			compact: async () => {},
		} satisfies ExtensionContext;
		expect(ctx.getToolSession).toBeUndefined();
	});
});
