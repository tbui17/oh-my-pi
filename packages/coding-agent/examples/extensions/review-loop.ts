/**
 * Review-Revise Loop Extension
 *
 * Demonstrates spawning deterministic subagent workflows from an extension via
 * the `runEvalAgent` API — no eval strings, no model-in-the-loop orchestration.
 *
 * The workflow: a worker agent produces work, a reviewer agent evaluates it
 * against structured criteria and returns a JSON-validated verdict, the worker
 * revises based on the reviewer's feedback, and this repeats for up to `maxTurns`
 * rounds. A final reporter agent summarizes the outcome for the main agent.
 *
 * Requires omp 16.2+ (exposes `ctx.getToolSession()` on ExtensionContext).
 *
 * Usage:
 *   omp --extension examples/extensions/review-loop.ts
 *
 * Then ask the model to use the `review_loop` tool.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { EvalAgentResult } from "@oh-my-pi/pi-coding-agent/eval";
import { runEvalAgent } from "@oh-my-pi/pi-coding-agent/eval";

/** JSON Schema the reviewer must satisfy. `runEvalAgent` validates output against it. */
const REVIEW_SCHEMA = {
	type: "object",
	properties: {
		satisfied: {
			type: "boolean",
			description: "True if the work meets the review criteria and no further revision is needed.",
		},
		issues: {
			type: "array",
			items: { type: "string" },
			description: "Specific issues that must be fixed. Empty if satisfied.",
		},
		summary: {
			type: "string",
			description: "One-sentence assessment of the current state.",
		},
	},
	required: ["satisfied", "issues", "summary"],
	additionalProperties: false,
} as const;

interface ReviewVerdict {
	satisfied: boolean;
	issues: string[];
	summary: string;
}

export default function (pi: ExtensionAPI) {
	const { z } = pi.zod;

	pi.registerTool({
		name: "review_loop",
		label: "Review-Revise Loop",
		description:
			"Run a worker→reviewer→revise loop until the reviewer is satisfied or a turn cap is reached. " +
			"A reporter agent then summarizes the outcome. Use for tasks that benefit from iterative refinement.",
		parameters: z.object({
			task: z.string().describe("The task for the worker agent to complete."),
			criteria: z.string().describe("Review criteria the work must satisfy."),
			maxTurns: z
				.number()
				.int()
				.min(1)
				.max(10)
				.default(5)
				.describe("Maximum worker-reviewer rounds before giving up."),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { task, criteria, maxTurns } = params;

			// --- Guard: getToolSession was added in omp 16.2 alongside the
			// eval/agent-bridge export. Without it, runEvalAgent cannot be called. ---
			const session = ctx.getToolSession?.();
			if (!session) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								"review_loop requires a session that exposes getToolSession(). " +
								"Update to omp 16.2+ and ensure the extension runner was initialized with a toolSession.",
						},
					],
					isError: true,
					details: { reason: "no_tool_session" },
				};
			}

			let workerOutput = "";
			let verdict: ReviewVerdict | undefined;
			let turns = 0;
			let satisfied = false;

			// --- The loop: worker produces → reviewer evaluates → check exit. ---
			for (let turn = 1; turn <= maxTurns; turn++) {
				if (signal?.aborted) break;
				turns = turn;

				// Worker turn: produce or revise work.
				const previousWorkSection =
					turn === 1 ? "This is your first attempt." : `This is your current work:\n\n${workerOutput}`;

				const reviewerFeedbackSection =
					verdict && verdict.issues.length > 0
						? `The reviewer found these issues that you MUST fix:\n${verdict.issues
								.map((issue, i) => `${i + 1}. ${issue}`)
								.join("\n")}`
						: "";

				const workerPrompt = [
					"You are a worker agent. Complete the following task:",
					"",
					`TASK: ${task}`,
					"",
					previousWorkSection,
					reviewerFeedbackSection ? `\n${reviewerFeedbackSection}\n` : "",
					"Produce your best work. Be thorough and address every issue raised.",
				]
					.filter(Boolean)
					.join("\n");

				let workerResult: EvalAgentResult;
				try {
					workerResult = await runEvalAgent(
						{ prompt: workerPrompt, agent: "task", label: `Worker T${turn}` },
						{ session, signal },
					);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return errorResult(`Worker agent failed on turn ${turn}: ${message}`, {
						turns: turn,
						phase: "worker",
					});
				}

				workerOutput = workerResult.text;

				if (signal?.aborted) break;

				// Reviewer turn: evaluate against criteria, return structured verdict.
				const reviewerPrompt = [
					"You are a reviewer agent. Evaluate the following work against the criteria.",
					"",
					`REVIEW CRITERIA: ${criteria}`,
					"",
					"WORK TO REVIEW:",
					workerOutput,
					"",
					"Assess whether the work meets all criteria. If it does, set satisfied=true and issues=[]. " +
						"If not, set satisfied=false and list every specific issue in the issues array. " +
						"Be rigorous — do not approve work that has gaps.",
				].join("\n");

				let reviewerResult: EvalAgentResult;
				try {
					reviewerResult = await runEvalAgent(
						{ prompt: reviewerPrompt, agent: "task", schema: REVIEW_SCHEMA, label: `Reviewer T${turn}` },
						{ session, signal },
					);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return errorResult(`Reviewer agent failed on turn ${turn}: ${message}`, {
						turns: turn,
						phase: "reviewer",
					});
				}

				// Parse the validated JSON verdict. Schema validation in runEvalAgent
				// makes this safe, but defend against edge cases.
				let parsed: ReviewVerdict;
				try {
					parsed = JSON.parse(reviewerResult.text) as ReviewVerdict;
				} catch {
					return errorResult(
						`Reviewer returned unparseable output on turn ${turn} (schema validation should prevent this):\n${reviewerResult.text}`,
						{ turns: turn, phase: "reviewer_parse" },
					);
				}

				verdict = parsed;

				// If the reviewer is unsatisfied but gave no actionable issues, the
				// loop cannot productively continue — bail with an error.
				if (!verdict.satisfied && verdict.issues.length === 0) {
					return errorResult(
						`Reviewer rejected the work on turn ${turn} but provided no issues to address. Summary: ${verdict.summary}`,
						{ turns: turn, phase: "reviewer_empty_issues" },
					);
				}

				if (verdict.satisfied) {
					satisfied = true;
					break;
				}
			}

			// --- Reporter turn: summarize the outcome for the main agent. ---
			const outcome = satisfied
				? "The reviewer approved the work."
				: `The reviewer did not approve the work after ${maxTurns} rounds.`;

			const reporterPrompt = [
				"You are a reporter agent. Summarize the outcome of a review-revise loop.",
				"",
				`ORIGINAL TASK: ${task}`,
				`TOTAL ROUNDS: ${turns}`,
				`OUTCOME: ${outcome}`,
				`REVIEWER'S FINAL ASSESSMENT: ${verdict?.summary ?? "(no assessment)"}`,
				"",
				"FINAL WORK STATE:",
				workerOutput,
				"",
				"Write a concise summary for the main agent: what was accomplished, whether it was approved, " +
					"and any remaining concerns.",
			].join("\n");

			let reporterResult: EvalAgentResult;
			try {
				reporterResult = await runEvalAgent(
					{ prompt: reporterPrompt, agent: "task", label: "Reporter" },
					{ session, signal },
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return errorResult(`Reporter agent failed: ${message}`, {
					turns,
					satisfied,
					phase: "reporter",
				});
			}

			return {
				content: [{ type: "text" as const, text: reporterResult.text }],
				details: {
					turns,
					satisfied,
					reviewerSummary: verdict?.summary ?? null,
				},
			};
		},
	});
}

/** Build a non-throwing tool error result. */
function errorResult(text: string, details: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text }],
		isError: true,
		details,
	};
}
