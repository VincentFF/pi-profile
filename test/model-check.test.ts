import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkDeclaredModel } from "../src/launcher/model-check.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
	await writeFile(
		path.join(fixture.agentDir, "models.json"),
		JSON.stringify({
			providers: {
				testprov: {
					baseUrl: "http://localhost:9/v1",
					api: "openai-completions",
					apiKey: "static-key",
					models: [{ id: "test-model" }],
				},
			},
		}),
	);
	await writeFile(
		path.join(fixture.agentDir, "auth.json"),
		JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }),
	);
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

describe("checkDeclaredModel", () => {
	it("accepts a custom provider model with configured auth", async () => {
		expect(await checkDeclaredModel(fixture.agentDir, { provider: "testprov", id: "test-model" })).toBeUndefined();
	});

	it("accepts a built-in provider model with a stored credential", async () => {
		expect(await checkDeclaredModel(fixture.agentDir, { provider: "openai", id: "gpt-5.4" })).toBeUndefined();
	});

	it("rejects an unknown provider", async () => {
		const error = await checkDeclaredModel(fixture.agentDir, { provider: "noprov", id: "x" });

		expect(error).toMatch(/noprov/);
	});

	it("rejects a known model without any credentials", async () => {
		const error = await checkDeclaredModel(fixture.agentDir, { provider: "anthropic", id: "claude-sonnet-4-5" });

		expect(error).toMatch(/anthropic/i);
	});
});
