import { describe, expect, it } from "bun:test";
import { writeMessage } from "@oh-my-pi/pi-coding-agent/lsp/client";
import type { LspJsonRpcRequest } from "@oh-my-pi/pi-coding-agent/lsp/types";

/**
 * Regression: when the LSP server exits between read-loop ticks, `FileSink.write()`
 * returns a rejected Promise (EPIPE). The old code discarded the return value, so
 * the rejection floated as a fatal unhandled rejection and tore down the whole
 * agent session (4 crashes on 2026-07-11, `~/.omp/logs/omp.2026-07-11.log` lines
 * 5506/5555/6379/11868). `writeMessage` must capture and neutralize that rejection,
 * mirroring the pattern in `writeFrame` (mcp/transports/stdio.ts) and `safeSend`
 * (utils/ipc.ts).
 */
function trackUnhandled(): { release: () => unknown[]; capture: () => unknown[] } {
	const seen: unknown[] = [];
	const listener = (reason: unknown) => {
		seen.push(reason);
	};
	process.on("unhandledRejection", listener);
	return {
		release: () => {
			process.off("unhandledRejection", listener);
			return seen.slice();
		},
		capture: () => seen.slice(),
	};
}

const message: LspJsonRpcRequest = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {},
};

/** Drain the microtask queue so a floating rejected Promise surfaces. */
async function drainMicrotasks(ticks = 20): Promise<void> {
	for (let i = 0; i < ticks; i++) await Promise.resolve();
}

describe("writeMessage EPIPE neutralization", () => {
	it("does not surface an unhandled rejection when sink.write() returns a rejected Promise", async () => {
		const sink = {
			write() {
				return Promise.reject(
					Object.assign(new Error("EPIPE: broken pipe, write"), {
						code: "EPIPE",
						syscall: "write",
						errno: -32,
					}),
				);
			},
			flush() {},
		};

		const tracker = trackUnhandled();
		try {
			await writeMessage(sink as unknown as Bun.FileSink, message);
			await drainMicrotasks();
			expect(tracker.capture()).toEqual([]);
		} finally {
			tracker.release();
		}
	});

	it("does not surface an unhandled rejection when sink.flush() rejects too", async () => {
		const sink = {
			write() {},
			flush() {
				return Promise.reject(
					Object.assign(new Error("EPIPE: broken pipe, flush"), {
						code: "EPIPE",
						syscall: "write",
						errno: -32,
					}),
				);
			},
		};

		const tracker = trackUnhandled();
		try {
			await expect(
				writeMessage(sink as unknown as Bun.FileSink, message),
			).rejects.toThrow("EPIPE");
			await drainMicrotasks();
			expect(tracker.capture()).toEqual([]);
		} finally {
			tracker.release();
		}
	});
});
