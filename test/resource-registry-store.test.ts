import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RegistryError, ResourceRegistry } from "../src/resource-registry.ts";
import { ResourceRegistryStore } from "../src/resource-registry-store.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

const store = () => new ResourceRegistryStore(path.join(fixture.agentDir, "resources.json"));

describe("ResourceRegistryStore", () => {
	it("upserts entries into a missing file with the schema envelope, loadable by ResourceRegistry", async () => {
		await store().upsert({ id: "linter", entry: "/x/linter.ts", dependsOn: ["base"], alwaysOn: true });

		const raw = JSON.parse(await readFile(path.join(fixture.agentDir, "resources.json"), "utf8"));
		expect(raw).toEqual({
			schemaVersion: 1,
			resources: { linter: { kind: "extension", entry: "/x/linter.ts", dependsOn: ["base"], alwaysOn: true } },
		});
		const loaded = await ResourceRegistry.load(fixture.agentDir);
		expect(loaded.get("linter")?.alwaysOn).toBe(true);
	});

	it("edits an existing entry in place and omits empty optionals", async () => {
		await store().upsert({ id: "linter", entry: "/old.ts", dependsOn: ["base"] });
		await store().upsert({ id: "linter", entry: "/new.ts" });

		const loaded = await ResourceRegistry.load(fixture.agentDir);
		expect(loaded.get("linter")).toEqual({ id: "linter", kind: "extension", entry: "/new.ts", dependsOn: [], alwaysOn: false });
	});

	it("remove deletes the entry and is loud about unknown ids", async () => {
		await store().upsert({ id: "linter", entry: "/x.ts" });
		await store().remove("linter");

		expect((await ResourceRegistry.load(fixture.agentDir)).get("linter")).toBeUndefined();
		await expect(store().remove("linter")).rejects.toThrow(RegistryError);
	});

	it("rejects malformed saves and malformed existing files loudly", async () => {
		await expect(store().upsert({ id: " ", entry: "/x.ts" })).rejects.toThrow(RegistryError);
		await expect(store().upsert({ id: "linter", entry: "" })).rejects.toThrow(RegistryError);

		await writeFile(path.join(fixture.agentDir, "resources.json"), JSON.stringify({ schemaVersion: 1, resources: { bad: { kind: "mcp" } } }));
		await expect(store().upsert({ id: "linter", entry: "/x.ts" })).rejects.toThrow(/kind/);
	});

	it("wizard saves never block on external concurrent edits (last write wins)", async () => {
		// The store re-reads at write time: no optimistic-concurrency
		// failure, and unrelated external entries survive the save.
		await store().upsert({ id: "linter", entry: "/x.ts" });
		await writeFile(
			path.join(fixture.agentDir, "resources.json"),
			JSON.stringify({ schemaVersion: 1, resources: { external: { kind: "extension", entry: "/e.ts" } } }),
		);

		await store().upsert({ id: "linter", entry: "/y.ts" });
		const loaded = await ResourceRegistry.load(fixture.agentDir);
		expect(loaded.get("linter")?.entry).toBe("/y.ts");
		expect(loaded.get("external")).toBeDefined();
	});
});
