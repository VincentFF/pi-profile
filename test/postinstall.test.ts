/**
 * Default-catalog seeding (install time): bin/postinstall.js writes the
 * shipped `defaults/profiles.json` to the profile-switch dir ONLY when no
 * catalog exists — never overwriting user data, never shadowing the legacy
 * ~/.pi/agent fallback, never failing the install.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installDefaultProfiles } from "../bin/postinstall.js";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "pi-profile-postinstall-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function envFor(dir: string): NodeJS.ProcessEnv {
	return { PI_PROFILE_SWITCH_DIR: dir };
}

describe("installDefaultProfiles", () => {
	it("writes the shipped default catalog when none exists", async () => {
		const dir = path.join(root, "switch");

		const result = await installDefaultProfiles({ env: envFor(dir) });

		expect(result.written).toBe(true);
		const written = await readFile(path.join(dir, "profiles.json"), "utf8");
		const template = await readFile(path.resolve("defaults/profiles.json"), "utf8");
		expect(written).toBe(template);
		// The seeded profile is the read-only "ask" starter.
		const parsed = JSON.parse(written);
		expect(Object.keys(parsed.profiles)).toEqual(["ask"]);
		expect(parsed.profiles.ask.tools).toEqual(["read", "grep", "find", "ls"]);
		expect(parsed.profiles.ask.skills).toEqual([]);
		expect(parsed.profiles.ask.extensions).toEqual([]);
	});

	it("never overwrites an existing catalog", async () => {
		const dir = path.join(root, "switch");
		await mkdir(dir, { recursive: true });
		const target = path.join(dir, "profiles.json");
		await writeFile(target, JSON.stringify({ schemaVersion: 1, profiles: { mine: { tools: ["read"] } } }));

		const result = await installDefaultProfiles({ env: envFor(dir) });

		expect(result.written).toBe(false);
		expect(await readFile(target, "utf8")).toBe(
			JSON.stringify({ schemaVersion: 1, profiles: { mine: { tools: ["read"] } } }),
		);
	});

	it("is idempotent: a second run writes nothing", async () => {
		const dir = path.join(root, "switch");

		const first = await installDefaultProfiles({ env: envFor(dir) });
		const second = await installDefaultProfiles({ env: envFor(dir) });

		expect(first.written).toBe(true);
		expect(second.written).toBe(false);
	});

	it("skips when a legacy ~/.pi/agent catalog exists (no shadowing)", async () => {
		const dir = path.join(root, "switch");
		const agentDir = path.join(root, "agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(path.join(agentDir, "profiles.json"), JSON.stringify({ schemaVersion: 1, profiles: {} }));

		const result = await installDefaultProfiles({
			env: { PI_PROFILE_SWITCH_DIR: dir, PI_CODING_AGENT_DIR: agentDir },
		});

		expect(result.written).toBe(false);
		expect(result.skipped).toBe("legacy-catalog-present");
		await expect(readFile(path.join(dir, "profiles.json"), "utf8")).rejects.toThrow();
	});
});
