import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import piProfileExtension from "../extensions/pi-profile/index.ts";

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
	handlers: Map<string, Array<(event: never) => unknown>>;
	on(event: string, handler: (event: never) => unknown): void;
}

function fakePi(): FakePi {
	const handlers = new Map<string, Array<(event: never) => unknown>>();
	return {
		handlers,
		on(event, handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
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
});
