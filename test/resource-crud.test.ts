import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RegistryError } from "../src/resource-registry.ts";
import { deleteRegistryEntry, findReferrers, listRegistryEntries, upsertRegistryEntry } from "../src/switching/resource-crud.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;
let savedHome: string | undefined;

beforeEach(async () => {
	fixture = await createPiFixture();
	savedHome = process.env.HOME;
	process.env.HOME = fixture.root;
});

afterEach(async () => {
	process.env.HOME = savedHome;
	await rm(fixture.root, { recursive: true, force: true });
});

const input = () => ({ realAgentDir: fixture.agentDir, cwd: fixture.cwd });
const trust = () => writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ [fixture.cwd]: true }));
const writeGlobalRegistry = (resources: Record<string, unknown>) =>
	writeFile(path.join(fixture.agentDir, "resources.json"), JSON.stringify({ schemaVersion: 1, resources }));
const writeProjectRegistry = (resources: Record<string, unknown>) =>
	writeFile(path.join(fixture.cwd, ".pi", "resources.json"), JSON.stringify({ schemaVersion: 1, resources }));

describe("listRegistryEntries", () => {
	it("merges scopes with winning source and shadowing, trust-gated", async () => {
		await writeGlobalRegistry({ linter: { kind: "extension", entry: "/g/linter.ts" } });
		await writeProjectRegistry({
			linter: { kind: "extension", entry: "/p/linter.ts" },
			proj: { kind: "extension", entry: "/p/proj.ts" },
		});

		// Untrusted: project entries invisible.
		expect((await listRegistryEntries(input())).map((entry) => entry.id)).toEqual(["linter"]);

		await trust();
		const entries = await listRegistryEntries(input());
		const linter = entries.find((entry) => entry.id === "linter");
		expect(linter?.source).toBe("project");
		expect(linter?.shadowsGlobal).toBe(true);
		expect(linter?.entry).toBe("/p/linter.ts");
		expect(entries.find((entry) => entry.id === "proj")?.source).toBe("project");
	});
});

describe("deleteRegistryEntry", () => {
	it("refuses deletion referenced by any profile, naming the referrer", async () => {
		await writeGlobalRegistry({ linter: { kind: "extension", entry: "/g.ts" } });
		await writeFile(
			path.join(fixture.agentDir, "profiles.json"),
			JSON.stringify({ schemaVersion: 1, profiles: { review: { extensions: ["linter"] } } }),
		);

		await expect(deleteRegistryEntry(input(), "global", "linter")).rejects.toThrow(
			/referenced by profile "review" \(global\)/,
		);
	});

	it("refuses deletion referenced by another resource's dependsOn, across scopes", async () => {
		await writeGlobalRegistry({ base: { kind: "extension", entry: "/b.ts" } });
		await writeProjectRegistry({ ui: { kind: "extension", entry: "/u.ts", dependsOn: ["base"] } });
		await trust();

		await expect(deleteRegistryEntry(input(), "global", "base")).rejects.toThrow(/resource "ui" dependsOn/);
	});

	it("sees references in shadowed global profiles (they activate elsewhere)", async () => {
		await writeGlobalRegistry({ linter: { kind: "extension", entry: "/g.ts" } });
		await writeFile(
			path.join(fixture.agentDir, "profiles.json"),
			JSON.stringify({ schemaVersion: 1, profiles: { shared: { extensions: ["linter"] } } }),
		);
		await writeFile(
			path.join(fixture.cwd, ".pi", "profiles.json"),
			JSON.stringify({ schemaVersion: 1, profiles: { shared: {} } }),
		);
		await trust();

		expect(await findReferrers(input(), "linter")).toContain('profile "shared" (global)');
	});

	it("deletes unreferenced entries and writes project-scope overrides", async () => {
		await writeGlobalRegistry({ linter: { kind: "extension", entry: "/g.ts" } });
		await deleteRegistryEntry(input(), "global", "linter");
		expect((await listRegistryEntries(input())).map((entry) => entry.id)).toEqual([]);

		await trust();
		await upsertRegistryEntry(input(), "project", { id: "linter", entry: "/p.ts" });
		const entries = await listRegistryEntries(input());
		expect(entries[0]?.source).toBe("project");
	});

	it("rejects project-scope mutations for untrusted projects", async () => {
		// A trust-requiring project file with no stored decision => untrusted.
		await writeFile(
			path.join(fixture.cwd, ".pi", "profiles.json"),
			JSON.stringify({ schemaVersion: 1, profiles: {} }),
		);
		await expect(upsertRegistryEntry(input(), "project", { id: "x", entry: "/x.ts" })).rejects.toThrow(
			RegistryError,
		);
	});
});
