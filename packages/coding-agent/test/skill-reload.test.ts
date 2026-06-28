import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("refreshSkills reloads skills from disk", () => {
	const tempDirs: TempDir[] = [];

	afterEach(async () => {
		for (const tempDir of tempDirs.splice(0)) {
			await tempDir.remove().catch(() => {});
		}
	});

	it("picks up skills added after session creation", async () => {
		const projectDir = TempDir.createSync("@pi-skill-reload-proj-");
		const agentDir = TempDir.createSync("@pi-skill-reload-agent-");
		tempDirs.push(projectDir, agentDir);
		const cwd = projectDir.join("project");
		fs.mkdirSync(cwd, { recursive: true });

		// Write one skill before session creation.
		const skillDir1 = path.join(cwd, ".agent", "skills", "alpha");
		fs.mkdirSync(skillDir1, { recursive: true });
		fs.writeFileSync(
			path.join(skillDir1, "SKILL.md"),
			"---\ndescription: Alpha skill\n---\n# Alpha\nDo work.\n",
			"utf8",
		);

		const authStorage = await AuthStorage.create(agentDir.join("testauth.db"));
		authStorage.setRuntimeApiKey("openai", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.create(cwd, agentDir.join("sessions"));

		let session: AgentSession | undefined;
		try {
			const result = await createAgentSession({
				cwd,
				agentDir: agentDir.path(),
				sessionManager,
				authStorage,
				modelRegistry,
				settings: Settings.isolated({ "async.enabled": false }),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				// skills: undefined → triggers real discoverSkills()
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
			});
			session = result.session;

			// Initial discovery finds alpha.
			const initialSkillNames = session.skills.map(s => s.name);
			expect(initialSkillNames).toContain("alpha");

			// Add a second skill after session creation.
			const skillDir2 = path.join(cwd, ".agent", "skills", "beta");
			fs.mkdirSync(skillDir2, { recursive: true });
			fs.writeFileSync(
				path.join(skillDir2, "SKILL.md"),
				"---\ndescription: Beta skill\n---\n# Beta\nDo work.\n",
				"utf8",
			);

			// refreshSkills re-runs discoverSkills and updates all snapshots.
			await session.refreshSkills();

			const reloadedSkillNames = session.skills.map(s => s.name);
			expect(reloadedSkillNames).toContain("alpha");
			expect(reloadedSkillNames).toContain("beta");
		} finally {
			await session?.dispose().catch(() => {});
		}
	});
});
