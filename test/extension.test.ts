import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import piProfileExtension from "../extensions/pi-profile/index.ts";
import { MCP_ALLOWLIST_EVENT } from "../src/mcp-coordination.ts";
import { fakeEventBus, installFakeAdapter, type FakeEventBus } from "./helpers/fake-event-bus.ts";

let root: string;
let savedAgentDir: string | undefined;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "pi-profile-ext-"));
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
});

afterEach(async () => {
	process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	await rm(root, { recursive: true, force: true });
});

interface FakePi {
	handlers: Map<string, Array<(...args: never[]) => unknown>>;
	events: FakeEventBus;
	on(event: string, handler: (...args: never[]) => unknown): void;
}

function fakePi(): FakePi {
	const handlers = new Map<string, Array<(...args: never[]) => unknown>>();
	return {
		handlers,
		events: fakeEventBus(),
		on(event, handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};
}

function fakeCtx() {
	const notifications: Array<{ message: string; level: string }> = [];
	return {
		notifications,
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
		},
	};
}

async function writeLaunchPlan(plan: unknown): Promise<void> {
	await mkdir(root, { recursive: true });
	await writeFile(path.join(root, "pi-profile.json"), JSON.stringify(plan));
}

describe("pi-profile extension", () => {
	it("appends declared instructions to the built system prompt on every turn", async () => {
		await writeLaunchPlan({ profile: "review", source: "global", instructions: "Be picky." });
		const pi = fakePi();
		piProfileExtension(pi as never);

		const handler = pi.handlers.get("before_agent_start")?.[0];
		const result = (await handler?.({ systemPrompt: "BASE PROMPT" } as never)) as { systemPrompt?: string };

		expect(result?.systemPrompt).toBe("BASE PROMPT\n\nBe picky.");
	});

	it("registers no before_agent_start handler when the plan declares no instructions", async () => {
		await writeLaunchPlan({ profile: "review", source: "global" });
		const pi = fakePi();
		piProfileExtension(pi as never);

		expect(pi.handlers.get("before_agent_start") ?? []).toEqual([]);
	});

	it("tolerates a missing or malformed launch plan (no instructions applied)", async () => {
		const pi = fakePi();
		piProfileExtension(pi as never);

		expect(pi.handlers.get("before_agent_start") ?? []).toEqual([]);
	});

	describe("mcp coordination", () => {
		it("publishes the profile's runtime server allowlist on session start when the adapter answers", async () => {
			await writeLaunchPlan({ profile: "review", source: "global", mcp: ["github", "linear"] });
			const pi = fakePi();
			installFakeAdapter(pi.events);
			piProfileExtension(pi as never);

			const handler = pi.handlers.get("session_start")?.[0];
			await handler?.({} as never, fakeCtx() as never);

			const allowlist = pi.events.emitted.find((entry) => entry.channel === MCP_ALLOWLIST_EVENT);
			expect(allowlist?.data).toEqual({ version: 1, profile: "review", servers: ["github", "linear"] });
		});

		it("fails loudly when the plan declares mcp but the adapter is absent", async () => {
			await writeLaunchPlan({ profile: "review", source: "global", mcp: ["github"] });
			const pi = fakePi();
			piProfileExtension(pi as never);
			const ctx = fakeCtx();

			const handler = pi.handlers.get("session_start")?.[0];
			expect(() => handler?.({} as never, ctx as never)).toThrow(/pi-mcp-adapter is not active/);
			expect(ctx.notifications.some((entry) => entry.level === "error")).toBe(true);
			expect(pi.events.emitted.some((entry) => entry.channel === MCP_ALLOWLIST_EVENT)).toBe(false);
		});

		it("registers no coordination when the plan declares no mcp", async () => {
			await writeLaunchPlan({ profile: "default", source: "builtin" });
			const pi = fakePi();
			piProfileExtension(pi as never);

			expect(pi.handlers.get("session_start") ?? []).toEqual([]);
		});
	});
});
