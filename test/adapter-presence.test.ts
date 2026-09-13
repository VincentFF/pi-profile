import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { adapterPresent } from "../src/adapter-presence.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

describe("adapterPresent", () => {
	it("is false when nothing points at the adapter", () => {
		expect(adapterPresent({ agentDir: fixture.agentDir, argv: [] })).toBe(false);
	});

	it("sees Pi's npm package root", async () => {
		await mkdir(path.join(fixture.agentDir, "npm", "node_modules", "pi-mcp-adapter"), { recursive: true });

		expect(adapterPresent({ agentDir: fixture.agentDir, argv: [] })).toBe(true);
	});

	it("sees the adapter on the command line", () => {
		expect(
			adapterPresent({ agentDir: fixture.agentDir, argv: ["-e", "/opt/pi-mcp-adapter/index.ts"] }),
		).toBe(true);
	});

	it("sees the adapter in Pi settings packages", async () => {
		await writeFile(
			path.join(fixture.agentDir, "settings.json"),
			JSON.stringify({ packages: ["npm:context-mode", { source: "npm:pi-mcp-adapter" }] }),
		);

		expect(adapterPresent({ agentDir: fixture.agentDir, argv: [] })).toBe(true);
	});

	it("accepts the event-bus probe answer", () => {
		expect(adapterPresent({ agentDir: fixture.agentDir, argv: [], probeAnswered: true })).toBe(true);
	});

	it("treats unreadable settings as absent instead of throwing", async () => {
		await writeFile(path.join(fixture.agentDir, "settings.json"), "{ not json");

		expect(adapterPresent({ agentDir: fixture.agentDir, argv: [] })).toBe(false);
	});
});
