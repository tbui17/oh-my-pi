/**
 * E2E test: creates a real omp agent session via the SDK and exercises the
 * /reprompt command through the full dispatch pipeline.
 *
 * Unlike the unit test (which tests the handler in isolation with a DI mock)
 * and the integration test (which only verifies the extension loads and
 * registers), this test exercises:
 *   createAgentSession → extension discovery → initializeExtensions
 *   → session.prompt("/reprompt …") → #tryExecuteExtensionCommand
 *   → handler → completeSimple (spied) → setEditorText (captured via UI context)
 *
 * The LLM call is intercepted via vi.spyOn so no network access is needed.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import { initializeExtensions } from "../../../modes/runtime-init";
import { createAgentSession } from "../../../sdk";
import type { ExtensionUIContext } from "../types";

afterEach(() => vi.restoreAllMocks());

/** A capturing ExtensionUIContext that records setEditorText/notify/setStatus calls. */
function makeCapturingUIContext(): ExtensionUIContext & {
	editorTexts: string[];
	notifications: Array<{ message: string; type?: string }>;
	statuses: Array<{ key: string; text: string | undefined }>;
} {
	const editorTexts: string[] = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];

	return {
		editorTexts,
		notifications,
		statuses,
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		editor: async () => undefined,
		notify: (message: string, type?: "info" | "warning" | "error") => {
			notifications.push({ message, type });
		},
		setStatus: (key: string, text: string | undefined) => {
			statuses.push({ key, text });
		},
		setEditorText: (text: string) => {
			editorTexts.push(text);
		},
		getEditorText: () => "",
		pasteToEditor: (text: string) => {
			editorTexts.push(text);
		},
		onTerminalInput: () => () => {},
		setWorkingMessage: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined as never,
		setEditorComponent: () => {},
		setToolsExpanded: () => {},
		getToolsExpanded: () => false,
		get theme() {
			return { name: "test", colors: {} } as never;
		},
		getAllThemes: async () => [],
		getTheme: async () => undefined,
		setTheme: async () => ({ success: false }),
		addAutocompleteProvider: () => {},
	} as ExtensionUIContext & {
		editorTexts: string[];
		notifications: Array<{ message: string; type?: string }>;
		statuses: Array<{ key: string; text: string | undefined }>;
	};
}

describe("reprompt e2e via SDK", () => {
	it("dispatches /reprompt through the full session pipeline", async () => {
		// Spy on completeSimple to avoid real LLM calls
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			role: "assistant",
			content: [{ type: "text", text: "<task>Fix the authentication bug</task>" }],
			api: "openai-responses",
			provider: "test",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
		} as never);

		// Create a real agent session with extensions loaded
		const { session } = await createAgentSession({
			hasUI: false,
		});

		// Wire a capturing UI context so we can observe setEditorText calls
		const ui = makeCapturingUIContext();
		await initializeExtensions(session, {
			reportSendError: () => {},
			reportRuntimeError: () => {},
			uiContext: ui,
		});

		// Dispatch the /reprompt command
		await session.prompt("/reprompt fix the authentication bug in the login flow");

		spy.mockRestore();

		// The handler should have set the editor text twice:
		// 1. The placeholder
		// 2. The reformatted prompt
		expect(ui.editorTexts.length).toBeGreaterThanOrEqual(2);
		expect(ui.editorTexts[0]).toBe("Reformatting with smol model\u2026");
		expect(ui.editorTexts[ui.editorTexts.length - 1]).toBe("<task>Fix the authentication bug</task>");

		// Status was set and then cleared
		expect(ui.statuses.length).toBeGreaterThanOrEqual(2);
		expect(ui.statuses[0].key).toBe("reprompt");
		expect(ui.statuses[0].text).toContain("Smol model processing");
		const lastStatus = ui.statuses[ui.statuses.length - 1];
		expect(lastStatus.key).toBe("reprompt");
		expect(lastStatus.text).toBeUndefined();

		// No error/warning notifications on the happy path
		expect(ui.notifications).toEqual([]);
	}, 60_000);

	it("shows a warning and does not touch the editor when called with no args", async () => {
		const { session } = await createAgentSession({ hasUI: false });
		const ui = makeCapturingUIContext();
		await initializeExtensions(session, {
			reportSendError: () => {},
			reportRuntimeError: () => {},
			uiContext: ui,
		});

		await session.prompt("/reprompt");

		expect(ui.notifications.length).toBeGreaterThanOrEqual(1);
		expect(ui.notifications[0].message).toContain("Usage: /reprompt");
		expect(ui.notifications[0].type).toBe("warning");
		expect(ui.editorTexts.length).toBe(0);
	}, 60_000);
});
