#!/usr/bin/env bun

/**
 * Automates syncing released upstream changes into the `local` branch.
 *
 * Only merges up to the latest release tag (e.g. `v16.1.3`), never `origin/main`
 * — unreleased commits are excluded for stability.
 *
 * Usage:
 *   bun scripts/sync-upstream.ts [options]
 *
 * Options:
 *   --from-step=<step>    Resume from step: backup|fetch|merge|verify|build|summary (default: backup)
 *   --skip-build          Skip the build step
 *   --skip-tests          Skip omp --version check (still runs bun install + bun check)
 *   --dry-run             Print actions without executing
 *   --tag=<version>       Use a specific tag instead of latest (e.g. --tag=v16.1.0)
 */

import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

const STEP_ORDER = ["backup", "fetch", "merge", "verify", "build", "summary"] as const;
type Step = (typeof STEP_ORDER)[number];

interface CliOptions {
	fromStep: Step;
	skipBuild: boolean;
	skipTests: boolean;
	dryRun: boolean;
	tag: string | null;
}

interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

type StepResultStatus = "PASS" | "SKIPPED";

interface SyncState {
	latestTag: string;
	tagSha: string;
	oldBase: string;
	newMain: string;
	alreadyUpToDate: boolean;
}

const stepStatus: { label: string; status: StepResultStatus }[] = [
	{ label: "bun install", status: "SKIPPED" },
	{ label: "bun check (lint + typecheck)", status: "SKIPPED" },
	{ label: "omp --version", status: "SKIPPED" },
	{ label: "bun build:native", status: "SKIPPED" },
	{ label: "bun build", status: "SKIPPED" },
];

function setStatus(label: string, status: StepResultStatus): void {
	const entry = stepStatus.find(s => s.label === label);
	if (entry) entry.status = status;
}

function printUsage(): void {
	console.log(`Usage: bun scripts/sync-upstream.ts [options]

Options:
  --from-step=<step>    Resume from step: backup|fetch|merge|verify|build|summary (default: backup)
  --skip-build          Skip the build step
  --skip-tests          Skip omp --version check (still runs bun install + bun check)
  --dry-run             Print actions without executing
  --tag=<version>       Use a specific tag instead of latest (e.g. --tag=v16.1.0)`);
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		fromStep: "backup",
		skipBuild: false,
		skipTests: false,
		dryRun: false,
		tag: null,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = (): string => {
			const v = argv[i + 1];
			i += 1;
			return v ?? "";
		};
		if (arg === "--from-step") options.fromStep = next() as Step;
		else if (arg.startsWith("--from-step=")) options.fromStep = arg.slice("--from-step=".length) as Step;
		else if (arg === "--tag") options.tag = next() || null;
		else if (arg.startsWith("--tag=")) options.tag = arg.slice("--tag=".length);
		else if (arg === "--skip-build") options.skipBuild = true;
		else if (arg === "--skip-tests") options.skipTests = true;
		else if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--help" || arg === "-h") {
			printUsage();
			process.exit(0);
		} else {
			console.error(`Unknown argument: ${arg}`);
			printUsage();
			process.exit(1);
		}
	}
	if (!STEP_ORDER.includes(options.fromStep)) {
		console.error(`Invalid --from-step value: ${options.fromStep}. Expected one of: ${STEP_ORDER.join(", ")}`);
		process.exit(1);
	}
	return options;
}

function runGit(args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
	const exitCode = result.exitCode ?? -1;
	if (exitCode !== 0) {
		const stderr = result.stderr?.toString("utf-8").trim() ?? "";
		throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
	}
	return result.stdout?.toString("utf-8").trim() ?? "";
}

function runGitNoThrow(args: string[]): CommandResult {
	const result = Bun.spawnSync(["git", ...args], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
	return {
		exitCode: result.exitCode ?? -1,
		stdout: result.stdout?.toString("utf-8").trim() ?? "",
		stderr: result.stderr?.toString("utf-8").trim() ?? "",
	};
}

function runStep(name: string, command: string[], opts?: { cwd?: string }): { exitCode: number } {
	console.log(`[RUN] ${name}`);
	const result = Bun.spawnSync(command, {
		cwd: opts?.cwd ?? repoRoot,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return { exitCode: result.exitCode ?? -1 };
}

function findLatestTag(): string {
	const out = runGit(["tag", "--sort=-creatordate", "--list", "v*"]);
	const first = out.split(/\r?\n/)[0]?.trim();
	if (!first?.startsWith("v")) {
		throw new Error("No release tags (v*) found in repository.");
	}
	return first;
}

function resolveOldBaseLabel(oldBase: string): string {
	const pointed = runGitNoThrow(["tag", "--points-at", oldBase, "--list", "v*"]).stdout;
	const first = pointed.split(/\r?\n/)[0]?.trim();
	if (first?.startsWith("v")) return first;
	return runGit(["rev-parse", "--short", oldBase]);
}

function runPreFlight(_opts: CliOptions): void {
	const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
	if (branch !== "local") {
		console.error(`Pre-flight failed: expected branch 'local', currently on '${branch}'.`);
		console.error("Switch to local first: git checkout local");
		process.exit(1);
	}
	const status = runGit(["status", "--porcelain"]);
	if (status.length > 0) {
		console.error("Pre-flight failed: working tree is not clean.");
		console.error("Commit or stash changes before syncing:");
		console.error(status);
		process.exit(1);
	}
	console.log("Pre-flight: on branch 'local', working tree clean.");
}

async function stepBackup(opts: CliOptions): Promise<void> {
	console.log("\n=== Step 1: backup ===");
	if (opts.dryRun) {
		const sha = runGit(["rev-parse", "local"]);
		console.log("[DRY-RUN] Would delete local-backup if it exists");
		console.log(`[DRY-RUN] Would create backup branch local-backup @ ${sha}`);
		return;
	}
	const del = runGitNoThrow(["branch", "-D", "local-backup"]);
	if (del.exitCode === 0) {
		console.log("Deleted existing local-backup.");
	} else {
		console.log("No prior local-backup to delete.");
	}
	runGit(["branch", "local-backup", "local"]);
	const sha = runGit(["rev-parse", "local-backup"]);
	console.log(`Backup: local-backup @ ${sha}`);
}

async function stepFetch(opts: CliOptions): Promise<void> {
	console.log("\n=== Step 2: fetch ===");
	if (opts.dryRun) {
		console.log("[DRY-RUN] Would run: git fetch origin --tags");
		return;
	}
	runGit(["fetch", "origin", "--tags"]);
	console.log("Fetched origin with tags.");
}

async function stepMerge(opts: CliOptions, state: SyncState): Promise<void> {
	console.log("\n=== Step 3: merge ===");
	const tag = opts.tag ?? findLatestTag();
	if (!tag.startsWith("v")) {
		throw new Error(`Resolved tag does not look like a release tag: ${tag}`);
	}
	state.latestTag = tag;
	const tagSha = runGit(["rev-parse", tag]);
	state.tagSha = tagSha;
	console.log(`Latest release tag: ${tag} (${tagSha.slice(0, 7)})`);

	if (opts.dryRun) {
		console.log(`[DRY-RUN] Would update main to ${tag} (${tagSha.slice(0, 7)})`);
		console.log("[DRY-RUN] Would checkout local and merge main into local");
		return;
	}

	runGit(["branch", "-f", "main", tagSha]);
	console.log(`Updated main to ${tag} (${tagSha.slice(0, 7)}).`);

	runGitNoThrow(["checkout", "local"]);
	const mergeRes = runGitNoThrow(["merge", "main"]);
	const mergeOut = `${mergeRes.stdout}\n${mergeRes.stderr}`.trim();
	if (mergeRes.exitCode === 0) {
		if (/already up to date/i.test(mergeOut)) {
			console.log("Already up to date — nothing to merge.");
			state.alreadyUpToDate = true;
			return;
		}
		console.log("Merge successful.");
		return;
	}

	const conflicts = runGit(["diff", "--name-only", "--diff-filter=U"]);
	console.error("Merge conflicts detected. Conflicted files:");
	console.error(conflicts || "(none)");
	console.error("");
	console.error("Resolve conflicts in the files above, then:");
	console.error("  git add . && git commit");
	console.error("  bun scripts/sync-upstream.ts --from-step=verify");
	console.error("");
	console.error("To abort the merge:");
	console.error("  git merge --abort");
	process.exit(1);
}

function runCheckedStep(label: string, command: string[]): void {
	const res = runStep(label, command);
	if (res.exitCode !== 0) {
		console.error(`[FAIL] ${label} (exit ${res.exitCode})`);
		process.exit(1);
	}
	setStatus(label, "PASS");
	console.log(`[PASS] ${label}`);
}

function stepVerify(opts: CliOptions): void {
	console.log("\n=== Step 4: verify ===");
	if (opts.dryRun) {
		console.log("[DRY-RUN] Would run: bun install");
		console.log("[DRY-RUN] Would run: bun check");
		if (!opts.skipTests) console.log("[DRY-RUN] Would run: omp --version");
		return;
	}
	const mergeHead = runGitNoThrow(["rev-parse", "--verify", "MERGE_HEAD"]);
	if (mergeHead.exitCode === 0) {
		console.error("Merge is still in progress. Complete the merge first: git add . && git commit");
		process.exit(1);
	}
	runCheckedStep("bun install", ["bun", "install"]);
	runCheckedStep("bun check (lint + typecheck)", ["bun", "check"]);
	if (opts.skipTests) {
		setStatus("omp --version", "SKIPPED");
		console.log("[SKIPPED] omp --version (--skip-tests)");
	} else {
		runCheckedStep("omp --version", ["bun", "packages/coding-agent/src/cli.ts", "--version"]);
	}
}

async function stepBuild(opts: CliOptions): Promise<void> {
	console.log("\n=== Step 5: build (parallel) ===");
	if (opts.skipBuild) {
		setStatus("bun build:native", "SKIPPED");
		setStatus("bun build", "SKIPPED");
		console.log("[SKIPPED] build step (--skip-build)");
		return;
	}
	if (opts.dryRun) {
		console.log("[DRY-RUN] Would run in parallel: bun run build:native + bun run build");
		return;
	}

	const builds: { label: string; cmd: string[] }[] = [
		{ label: "bun build:native", cmd: ["bun", "run", "build:native"] },
		{ label: "bun build", cmd: ["bun", "run", "build"] },
	];

	const procs = builds.map(b => ({
		label: b.label,
		proc: Bun.spawn(b.cmd, { cwd: repoRoot, stdout: "pipe", stderr: "pipe" }),
	}));

	const results = await Promise.all(
		procs.map(async p => ({
			label: p.label,
			exitCode: await p.proc.exited,
			stdout: await new Response(p.proc.stdout as ReadableStream<Uint8Array>).text(),
			stderr: await new Response(p.proc.stderr as ReadableStream<Uint8Array>).text(),
		})),
	);

	for (const r of results) {
		console.log(`\n--- ${r.label} ---`);
		if (r.stdout.trim()) console.log(r.stdout.trim());
		if (r.stderr.trim()) console.error(r.stderr.trim());
		if (r.exitCode !== 0) {
			console.error(`[FAIL] ${r.label} (exit ${r.exitCode})`);
			process.exit(1);
		}
		setStatus(r.label, "PASS");
		console.log(`[PASS] ${r.label}`);
	}
}

function ensureLatestTag(state: SyncState): void {
	if (state.latestTag) return;
	const mainSha = runGitNoThrow(["rev-parse", "main"]).stdout;
	if (mainSha) {
		const pointed = runGitNoThrow(["tag", "--points-at", mainSha, "--list", "v*"]).stdout;
		const t = pointed.split(/\r?\n/)[0]?.trim();
		state.latestTag = t?.startsWith("v") ? t : findLatestTag();
		state.tagSha = mainSha;
	} else {
		state.latestTag = findLatestTag();
		state.tagSha = runGit(["rev-parse", state.latestTag]);
	}
}

function stepSummary(opts: CliOptions, state: SyncState): void {
	console.log("\n=== Step 6: summary ===");
	if (opts.dryRun) {
		const tag = opts.tag ?? findLatestTag();
		console.log("[DRY-RUN] Would print sync summary");
		console.log(`[DRY-RUN] Latest tag: ${tag}`);
		return;
	}

	ensureLatestTag(state);

	const backupSha = runGit(["rev-parse", "local-backup"]);
	const oldBase = runGit(["merge-base", "local-backup", "main"]);
	const newMain = runGit(["rev-parse", "main"]);
	state.oldBase = oldBase;
	state.newMain = newMain;

	const oldTagOrSha = resolveOldBaseLabel(oldBase);
	const localSha = runGit(["rev-parse", "local"]);
	const mainSha = runGit(["rev-parse", "main"]);
	const aheadCount = runGitNoThrow(["rev-list", "--count", "main..local"]).stdout.trim() || "0";

	const bar = "=".repeat(80);
	const lines: string[] = [];
	lines.push(bar);
	lines.push("  Upstream Sync Summary");
	lines.push(bar);
	lines.push("");
	lines.push(`Synced: ${oldTagOrSha} -> ${state.latestTag}`);
	lines.push(`Backup: local-backup @ ${backupSha}`);
	lines.push("");
	lines.push("  Verification:");
	for (const s of stepStatus) {
		lines.push(`    [${s.status}] ${s.label}`);
	}
	lines.push("");
	lines.push("  Branch state:");
	lines.push(`    local: ${localSha} (${aheadCount} commits ahead of main)`);
	lines.push(`    main: ${mainSha} (${state.latestTag})`);
	lines.push(`    local-backup: ${backupSha}`);
	lines.push("");
	lines.push("  Rollback if needed: git reset --hard local-backup");
	lines.push(bar);

	console.log(lines.join("\n"));
}

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2));
	const startIdx = STEP_ORDER.indexOf(opts.fromStep);
	const state: SyncState = {
		latestTag: "",
		tagSha: "",
		oldBase: "",
		newMain: "",
		alreadyUpToDate: false,
	};

	if (opts.fromStep !== "summary") {
		runPreFlight(opts);
	}

	if (startIdx <= STEP_ORDER.indexOf("backup")) await stepBackup(opts);
	if (startIdx <= STEP_ORDER.indexOf("fetch")) await stepFetch(opts);
	if (startIdx <= STEP_ORDER.indexOf("merge")) await stepMerge(opts, state);
	if (startIdx <= STEP_ORDER.indexOf("verify") && !state.alreadyUpToDate) stepVerify(opts);
	if (startIdx <= STEP_ORDER.indexOf("build") && !state.alreadyUpToDate) await stepBuild(opts);
	if (startIdx <= STEP_ORDER.indexOf("summary")) stepSummary(opts, state);
}

main().catch((err: unknown) => {
	console.error((err as Error)?.message ?? String(err));
	process.exit(1);
});
