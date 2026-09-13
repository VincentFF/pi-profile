import {
	createSyntheticSourceInfo,
	formatSkillsForPrompt,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import piProfileExtension from "../extensions/pi-profile-switch/index.ts";
import { RuntimeStateStore } from "../src/runtime-state-store.ts";
import { fakeApplySurface } from "./helpers/fake-apply.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

/** A minimal in-memory Pi whose handlers and commands tests can invoke. */
interface FakePi {
	api: ExtensionAPI;
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>;
	commands: Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>;
	flagValues: Map<string, string | boolean>;
	activeTools: string[];
	messages: Array<{ customType?: string; content?: string; details?: unknown }>;
	/** Every `ctx.ui.setStatus` call, in order. */
	statuses: Array<{ key: string; text: string | undefined }>;
	events: { emitted: Array<{ channel: string; data: unknown }>; emit(channel: string, data: unknown): void };
	notifications: Array<{ message: string; level: string }>;
}

function fakePi(toolNames: string[]): FakePi {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const flagValues = new Map<string, string | boolean>();
	const messages: FakePi["messages"] = [];
	const notifications: FakePi["notifications"] = [];
	const statuses: FakePi["statuses"] = [];
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const fake: FakePi = {
		handlers,
		commands,
		flagValues,
		activeTools: [],
		messages,
		notifications,
		statuses,
		events: {
			emitted,
			emit: (channel: string, data: unknown) => {
				emitted.push({ channel, data });
			},
		},
	} as unknown as FakePi;
	const api = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
			commands.set(name, options);
		},
		registerFlag: (name: string, options: { type: string; default?: unknown }) => {
			if (options.default !== undefined) flagValues.set(name, options.default as string | boolean);
		},
		getFlag: (name: string) => flagValues.get(name),
		getAllTools: () => toolNames.map((name) => ({ name })),
		setActiveTools: (names: string[]) => {
			fake.activeTools = names;
		},
		setModel: async () => true,
		setThinkingLevel: () => {},
		getCommands: () => [],
		sendMessage: (message: { customType?: string; content?: string; details?: unknown }) => {
			messages.push(message);
		},
		events: fake.events,
	};
	fake.api = api as unknown as ExtensionAPI;
	return fake;
}

function skill(name: string): Skill {
	const filePath = `/skills/${name}/SKILL.md`;
	return {
		name,
		description: `Skill ${name}`,
		filePath,
		baseDir: path.dirname(filePath),
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
		disableModelInvocation: false,
	};
}

function promptOptions(skills: Skill[]): BuildSystemPromptOptions {
	return { cwd: "/project", selectedTools: ["read", "bash", "edit", "write"], skills };
}

interface FakeContextOptions {
	cwd: string;
	trusted?: boolean;
	skills?: Skill[];
	toolNames?: string[];
	mode?: string;
	hasUI?: boolean;
	/** Answer returned by `ctx.ui.select` (undefined = cancelled). */
	selectAnswer?: string;
	/** Theme stub. The default renders text unchanged so assertions read as
	 *  plain badge text; pass a marker theme to observe the color choices. */
	theme?: { fg(color: string, text: string): string };
}

function fakeContext(fake: FakePi, options: FakeContextOptions): ExtensionContext & ExtensionCommandContext {
	const { surface } = fakeApplySurface({ toolNames: options.toolNames ?? ["read", "grep"] });
	const context = {
		cwd: options.cwd,
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		ui: {
			notify: (message: string, level: string) => {
				fake.notifications.push({ message, level });
			},
			setStatus: (key: string, text: string | undefined) => {
				fake.statuses.push({ key, text });
			},
			theme: options.theme ?? { fg: (_color: string, text: string) => text },
			select: async () => options.selectAnswer,
			input: async () => undefined,
		},
		modelRegistry: surface.modelRegistry,
		sessionManager: { getEntries: () => [] },
		isProjectTrusted: () => options.trusted ?? false,
		getSystemPromptOptions: () => promptOptions(options.skills ?? []),
		waitForIdle: async () => {},
	};
	return context as unknown as ExtensionContext & ExtensionCommandContext;
}

async function emit(
	fake: FakePi,
	event: string,
	payload: unknown,
	ctx: ExtensionContext,
): Promise<unknown[]> {
	const results: unknown[] = [];
	for (const handler of fake.handlers.get(event) ?? []) {
		results.push(await handler(payload, ctx));
	}
	return results;
}

/** Runs fn with a controlled process.argv (the extension reads CLI
 *  declarations from it at load time). */
async function withArgv(argv: string[], fn: () => Promise<void>): Promise<void> {
	const original = process.argv;
	process.argv = ["node", "pi", ...argv];
	try {
		await fn();
	} finally {
		process.argv = original;
	}
}

let fixture: PiFixture;
let originalAgentDir: string | undefined;

beforeEach(async () => {
	fixture = await createPiFixture();
	originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
	await writeFile(
		path.join(fixture.agentDir, "profiles.json"),
		JSON.stringify({
			schemaVersion: 1,
			profiles: {
				review: { skills: ["alpha"], tools: ["read"], instructions: "Review only." },
				plain: {},
			},
		}),
	);
});

afterEach(async () => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	await rm(fixture.root, { recursive: true, force: true });
});

describe("pi-profile-switch extension: session_start", () => {
	it("activates the saved profile and applies tools", async () => {
		await new RuntimeStateStore(fixture.agentDir).write({ activeProfile: "review" });
		const fake = fakePi(["read", "grep"]);
		piProfileExtension(fake.api);
		const ctx = fakeContext(fake, { cwd: fixture.cwd, skills: [skill("alpha"), skill("beta")] });

		await emit(fake, "session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(fake.activeTools).toEqual(["read"]);
		expect(fake.notifications).toEqual([]);
	});

	it("keeps the runtime native when no profile is saved (default)", async () => {
		const fake = fakePi(["read", "grep"]);
		piProfileExtension(fake.api);
		const ctx = fakeContext(fake, { cwd: fixture.cwd, skills: [skill("alpha")] });

		await emit(fake, "session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(fake.activeTools).toEqual([]);
	});

	it("reports an unknown --profile value and stays native", async () => {
		const fake = fakePi(["read"]);
		fake.flagValues.set("profile", "ghost");
		piProfileExtension(fake.api);
		const ctx = fakeContext(fake, { cwd: fixture.cwd, skills: [skill("alpha")] });

		await emit(fake, "session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(fake.activeTools).toEqual([]);
		expect(fake.notifications.map((entry) => entry.message).join("\n")).toMatch(/unknown profile "ghost"/);
	});

	it("does not persist a --profile selection", async () => {
		const fake = fakePi(["read"]);
		fake.flagValues.set("profile", "review");
		piProfileExtension(fake.api);
		const ctx = fakeContext(fake, { cwd: fixture.cwd, skills: [skill("alpha")] });

		await emit(fake, "session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(await new RuntimeStateStore(fixture.agentDir).read()).toEqual({});
	});
});

describe("pi-profile-switch extension: before_agent_start", () => {
	it("filters the skills section to the profile and appends instructions", async () => {
		await new RuntimeStateStore(fixture.agentDir).write({ activeProfile: "review" });
		const fake = fakePi(["read"]);
		piProfileExtension(fake.api);
		const skills = [skill("alpha"), skill("beta")];
		const ctx = fakeContext(fake, { cwd: fixture.cwd, skills });
		const systemPrompt = `HEADER${formatSkillsForPrompt(skills, "read")}\nCurrent working directory: ${fixture.cwd}`;

		await emit(fake, "session_start", { type: "session_start", reason: "startup" }, ctx);
		const results = await emit(
			fake,
			"before_agent_start",
			{ type: "before_agent_start", prompt: "hi", systemPrompt, systemPromptOptions: promptOptions(skills) },
			ctx,
		);

		const result = results[0] as { systemPrompt: string };
		expect(result.systemPrompt).toContain("Skill alpha");
		expect(result.systemPrompt).not.toContain("Skill beta");
		expect(result.systemPrompt).toContain('<profile_instructions name="review">\nReview only.\n</profile_instructions>');
	});

	it("leaves the prompt untouched for the default profile", async () => {
		const fake = fakePi(["read"]);
		piProfileExtension(fake.api);
		const skills = [skill("alpha"), skill("beta")];
		const ctx = fakeContext(fake, { cwd: fixture.cwd, skills });
		const systemPrompt = `HEADER${formatSkillsForPrompt(skills, "read")}`;

		await emit(fake, "session_start", { type: "session_start", reason: "startup" }, ctx);
		const results = await emit(
			fake,
			"before_agent_start",
			{ type: "before_agent_start", prompt: "hi", systemPrompt, systemPromptOptions: promptOptions(skills) },
			ctx,
		);

		expect(results[0]).toBeUndefined();
	});
});

describe("pi-profile-switch extension: commands", () => {
	it("lists profiles with the structured payload", async () => {
		const fake = fakePi(["read"]);
		piProfileExtension(fake.api);
		const ctx = fakeContext(fake, { cwd: fixture.cwd });

		await fake.commands.get("profile")!.handler("list", ctx);

		const message = fake.messages.at(-1);
		expect(message?.customType).toBe("pi-profile-switch");
		expect(message?.content).toMatch(/review \[global\]/);
		expect((message?.details as { kind: string }).kind).toBe("list");
	});

	it("switches the active profile and persists the selection", async () => {
		const fake = fakePi(["read", "grep"]);
		piProfileExtension(fake.api);
		const ctx = fakeContext(fake, { cwd: fixture.cwd, skills: [skill("alpha")] });

		await fake.commands.get("profile")!.handler("use review", ctx);

		expect(fake.activeTools).toEqual(["read"]);
		expect(await new RuntimeStateStore(fixture.agentDir).read()).toEqual({ activeProfile: "review" });
		expect(fake.notifications.map((entry) => entry.message)).toContain("profile active: review");
	});

	it("reports status with the structured payload", async () => {
		const fake = fakePi(["read"]);
		piProfileExtension(fake.api);
		const ctx = fakeContext(fake, { cwd: fixture.cwd, skills: [skill("alpha"), skill("beta")] });
		await fake.commands.get("profile")!.handler("use review", ctx);

		await fake.commands.get("profile")!.handler("status", ctx);

		const message = fake.messages.at(-1);
		expect(message?.content).toMatch(/### profile: review \(global\)/);
		expect((message?.details as { kind: string }).kind).toBe("status");
	});

	it("refuses CRUD outside TUI mode with a mode-aware message", async () => {
		const fake = fakePi(["read"]);
		piProfileExtension(fake.api);
		const ctx = fakeContext(fake, { cwd: fixture.cwd, mode: "rpc", hasUI: false });

		await fake.commands.get("profile")!.handler("create", ctx);

		expect(fake.notifications.at(-1)?.message).toMatch(/requires TUI mode \(current mode: rpc\)/);
	});

	it("refuses the MCP toggle without an active profile", async () => {
		const fake = fakePi(["read"]);
		piProfileExtension(fake.api);
		const ctx = fakeContext(fake, { cwd: fixture.cwd });

		await fake.commands.get("mcp")!.handler("enable atlassian", ctx);

		expect(fake.notifications.at(-1)?.message).toMatch(/no active profile/);
	});

	it("activates the profile chosen from the bare /profile picker", async () => {
		const fake = fakePi(["read", "grep"]);
		piProfileExtension(fake.api);
		const ctx = fakeContext(fake, {
			cwd: fixture.cwd,
			skills: [skill("alpha")],
			selectAnswer: "review [global] — Review",
		});

		await fake.commands.get("profile")!.handler("", ctx);

		expect(fake.activeTools).toEqual(["read"]);
		expect(fake.notifications.map((entry) => entry.message)).toContain("profile active: review");
	});

	it("falls back to the profile list without dialog-capable UI", async () => {
		const fake = fakePi(["read"]);
		piProfileExtension(fake.api);
		const ctx = fakeContext(fake, { cwd: fixture.cwd, hasUI: false, mode: "print" });

		await fake.commands.get("profile")!.handler("", ctx);

		expect(fake.messages.at(-1)?.content).toMatch(/review \[global\]/);
	});

	it("cancels the bare /profile picker without activating anything", async () => {
		const fake = fakePi(["read"]);
		piProfileExtension(fake.api);
		const ctx = fakeContext(fake, { cwd: fixture.cwd }); // selectAnswer undefined = cancelled

		await fake.commands.get("profile")!.handler("", ctx);

		expect(fake.activeTools).toEqual([]);
		expect(fake.notifications).toEqual([]);
	});

	it("suppresses the profile's tools when the CLI declares --tools", async () => {
		await withArgv(["--tools", "read"], async () => {
			await new RuntimeStateStore(fixture.agentDir).write({ activeProfile: "review" });
			const fake = fakePi(["read", "grep"]);
			piProfileExtension(fake.api);
			const ctx = fakeContext(fake, { cwd: fixture.cwd, skills: [skill("alpha")] });

			await emit(fake, "session_start", { type: "session_start", reason: "startup" }, ctx);

			// review declares tools: ["read"] — the CLI keeps owning the set.
			expect(fake.activeTools).toEqual([]);

			// An explicit /profile use applies the declaration over the CLI.
			await fake.commands.get("profile")!.handler("use review", ctx);
			expect(fake.activeTools).toEqual(["read"]);
		});
	});
});

describe("pi-profile-switch extension: skills filter visibility", () => {
	it("warns once when no skill-reading tool is active", async () => {
		await new RuntimeStateStore(fixture.agentDir).write({ activeProfile: "review" });
		const fake = fakePi(["edit"]);
		piProfileExtension(fake.api);
		const skills = [skill("alpha")];
		const ctx = fakeContext(fake, { cwd: fixture.cwd, skills, toolNames: ["edit"] });

		await emit(fake, "session_start", { type: "session_start", reason: "startup" }, ctx);
		const event = {
			type: "before_agent_start",
			prompt: "hi",
			systemPrompt: "HEADER",
			systemPromptOptions: { cwd: fixture.cwd, selectedTools: ["edit"], skills },
		};
		await emit(fake, "before_agent_start", event, ctx);
		await emit(fake, "before_agent_start", event, ctx);

		const filterWarnings = fake.notifications.filter(
			(entry) => entry.level === "warning" && /neither the read nor the bash tool is active/.test(entry.message),
		);
		expect(filterWarnings).toHaveLength(1);
	});

	it("reports an unapplied filter in /profile status", async () => {
		await new RuntimeStateStore(fixture.agentDir).write({ activeProfile: "review" });
		const fake = fakePi(["edit"]);
		piProfileExtension(fake.api);
		const skills = [skill("alpha")];
		const ctx = fakeContext(fake, { cwd: fixture.cwd, skills, toolNames: ["edit"] });

		await emit(fake, "session_start", { type: "session_start", reason: "startup" }, ctx);
		await emit(
			fake,
			"before_agent_start",
			{
				type: "before_agent_start",
				prompt: "hi",
				systemPrompt: "HEADER",
				systemPromptOptions: { cwd: fixture.cwd, selectedTools: ["edit"], skills },
			},
			ctx,
		);
		await fake.commands.get("profile")!.handler("status", ctx);

		expect(fake.messages.at(-1)?.content).toMatch(/skills filter: not applied \(no-read-tool\)/);
	});
});

describe("pi-profile-switch extension: footer badge", () => {
	it("shows the active profile after a successful startup activation", async () => {
		await new RuntimeStateStore(fixture.agentDir).write({ activeProfile: "review" });
		const fake = fakePi(["read"]);
		piProfileExtension(fake.api);
		const ctx = fakeContext(fake, { cwd: fixture.cwd, skills: [skill("alpha")] });

		await emit(fake, "session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(fake.statuses).toEqual([{ key: "active-profile", text: "profile: review" }]);
	});

	it("ignores a stored overlay at startup (it never outlives its runtime)", async () => {
		await new RuntimeStateStore(fixture.agentDir).write({
			activeProfile: "review",
			overlay: { disabledSkills: ["alpha"] },
		});
		const fake = fakePi(["read"]);
		piProfileExtension(fake.api);
		const ctx = fakeContext(fake, { cwd: fixture.cwd, skills: [skill("alpha")] });

		await emit(fake, "session_start", { type: "session_start", reason: "startup" }, ctx);

		// Startup activation passes `overlay: null`, so the badge must not
		// claim a narrowing the runtime does not have.
		expect(fake.statuses.at(-1)?.text).toBe("profile: review");
	});

	it("writes no status at all for the default profile", async () => {
		const fake = fakePi(["read"]);
		piProfileExtension(fake.api);
		const ctx = fakeContext(fake, { cwd: fixture.cwd, skills: [skill("alpha")] });

		await emit(fake, "session_start", { type: "session_start", reason: "startup" }, ctx);

		// Touching no status keeps Pi's footer status line absent, so a plain
		// session looks exactly like native Pi.
		expect(fake.statuses).toEqual([]);
	});

	it("follows /profile use and the picker", async () => {
		const fake = fakePi(["read"]);
		piProfileExtension(fake.api);
		const ctx = fakeContext(fake, { cwd: fixture.cwd, skills: [skill("alpha")], selectAnswer: "plain [global]" });

		await fake.commands.get("profile")!.handler("use review", ctx);
		expect(fake.statuses.at(-1)?.text).toBe("profile: review");

		await fake.commands.get("profile")!.handler("", ctx);
		expect(fake.statuses.at(-1)?.text).toBe("profile: plain");
	});

	it("marks a runtime overlay and drops the marker on /profile reset", async () => {
		await new RuntimeStateStore(fixture.agentDir).write({ activeProfile: "review" });
		const fake = fakePi(["read"]);
		piProfileExtension(fake.api);
		const ctx = fakeContext(fake, { cwd: fixture.cwd, skills: [skill("alpha")] });
		await emit(fake, "session_start", { type: "session_start", reason: "startup" }, ctx);

		await fake.commands.get("profile")!.handler("customize disable skill alpha", ctx);
		expect(fake.statuses.at(-1)?.text).toBe("profile: review*");

		await fake.commands.get("profile")!.handler("reset", ctx);
		expect(fake.statuses.at(-1)?.text).toBe("profile: review");
	});

	it("keeps the applied profile when an activation fails", async () => {
		await new RuntimeStateStore(fixture.agentDir).write({ activeProfile: "review" });
		const fake = fakePi(["read"]);
		piProfileExtension(fake.api);
		const ctx = fakeContext(fake, { cwd: fixture.cwd, skills: [skill("alpha")] });
		await emit(fake, "session_start", { type: "session_start", reason: "startup" }, ctx);

		await fake.commands.get("profile")!.handler("use ghost", ctx);

		expect(fake.notifications.at(-1)?.message).toMatch(/unknown profile "ghost"/);
		expect(fake.statuses.at(-1)?.text).toBe("profile: review");
		expect(fake.statuses.every((entry) => entry.text !== undefined)).toBe(true);
	});

	it("does not touch the footer in modes without UI", async () => {
		const fake = fakePi(["read"]);
		piProfileExtension(fake.api);
		const ctx = fakeContext(fake, { cwd: fixture.cwd, skills: [skill("alpha")], mode: "print", hasUI: false });

		await fake.commands.get("profile")!.handler("use review", ctx);

		expect(fake.statuses).toEqual([]);
	});

	it("does not re-render an unchanged badge on the next turn", async () => {
		await new RuntimeStateStore(fixture.agentDir).write({ activeProfile: "review" });
		const fake = fakePi(["read"]);
		piProfileExtension(fake.api);
		const skills = [skill("alpha")];
		const ctx = fakeContext(fake, { cwd: fixture.cwd, skills });
		await emit(fake, "session_start", { type: "session_start", reason: "startup" }, ctx);

		await emit(
			fake,
			"before_agent_start",
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "HEADER", systemPromptOptions: promptOptions(skills) },
			ctx,
		);

		expect(fake.statuses).toHaveLength(1);
	});

	it("re-renders on the next turn when the theme changed", async () => {
		let themeTag = "t1";
		const theme = { fg: (color: string, text: string) => `[${themeTag}${color}]${text}` };
		await new RuntimeStateStore(fixture.agentDir).write({ activeProfile: "review" });
		const fake = fakePi(["read"]);
		piProfileExtension(fake.api);
		const skills = [skill("alpha")];
		const ctx = fakeContext(fake, { cwd: fixture.cwd, skills, theme });
		await emit(fake, "session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(fake.statuses.at(-1)?.text).toContain("[t1dim]");

		// Pi has no extension-visible theme-change event, so the turn is the
		// refresh point that keeps the badge's colors current.
		themeTag = "t2";
		await emit(
			fake,
			"before_agent_start",
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "HEADER", systemPromptOptions: promptOptions(skills) },
			ctx,
		);

		expect(fake.statuses).toHaveLength(2);
		expect(fake.statuses.at(-1)?.text).toContain("[t2dim]");
	});
});
