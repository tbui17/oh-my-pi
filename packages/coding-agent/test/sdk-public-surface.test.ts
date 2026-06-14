import { describe, expect, it } from "bun:test";

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
});
