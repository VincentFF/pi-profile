/**
 * The shipped JSON schemas validate the shipped examples, and the
 * validator agrees with the runtime parsers on the loadable surface
 * (schema-valid files parse; the parser's rejections are schema-invalid).
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { ProfileCatalog } from "../src/profile-catalog.ts";
import { ResourceRegistry } from "../src/resource-registry.ts";

const Ajv2020 = Ajv2020Module.default;

// ajv/dist/2020: draft 2020-12 support (propertyNames + const).
// Fresh instance per use — compile() registers $id and refuses duplicates.
const newAjv = () => new Ajv2020({ strict: true });

async function loadSchema(name: string) {
	return JSON.parse(await readFile(path.resolve("schemas", name), "utf8"));
}

describe("shipped JSON schemas", () => {
	it("both schemas validate the shipped examples", async () => {
		const profiles = await loadSchema("profiles.schema.json");
		const resources = await loadSchema("resources.schema.json");
		const profilesExample = JSON.parse(await readFile(path.resolve("examples/profiles.json"), "utf8"));
		const resourcesExample = JSON.parse(await readFile(path.resolve("examples/resources.json"), "utf8"));

		const ajv = newAjv();
		expect(ajv.validate(profiles, profilesExample), JSON.stringify(ajv.errors)).toBe(true);
		expect(ajv.validate(resources, resourcesExample), JSON.stringify(ajv.errors)).toBe(true);
	});

	it("the profiles schema rejects the built-in name, inheritance keys, and wrong types", async () => {
		const validate = newAjv().compile(await loadSchema("profiles.schema.json"));

		expect(validate({ schemaVersion: 1, profiles: { default: {} } })).toBe(false);
		expect(validate({ schemaVersion: 1, profiles: { review: { extends: "base" } } })).toBe(false);
		expect(validate({ schemaVersion: 1, profiles: { review: { skills: "oops" } } })).toBe(false);
		expect(validate({ schemaVersion: 2, profiles: {} })).toBe(false);
	});

	it("the resources schema rejects non-extension kinds and missing entries", async () => {
		const validate = newAjv().compile(await loadSchema("resources.schema.json"));

		expect(validate({ schemaVersion: 1, resources: { x: { kind: "mcp", entry: "/e.ts" } } })).toBe(false);
		expect(validate({ schemaVersion: 1, resources: { x: { kind: "extension" } } })).toBe(false);
		expect(
			validate({ schemaVersion: 1, resources: { x: { kind: "extension", entry: "/e.ts", alwaysOn: true } } }),
		).toBe(true);
	});

	it("schema-valid catalogs load through the runtime parsers", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "pi-profile-schema-"));
		try {
			await writeFile(
				path.join(dir, "profiles.json"),
				await readFile(path.resolve("examples/profiles.json"), "utf8"),
			);
			await writeFile(
				path.join(dir, "resources.json"),
				await readFile(path.resolve("examples/resources.json"), "utf8"),
			);
			const catalog = await ProfileCatalog.load(dir);
			expect(catalog.resolve("review")?.definition.label).toBe("Code review");
			const registry = await ResourceRegistry.load(dir);
			expect(registry.get("mcp-adapter")?.entry).toContain("pi-mcp-adapter");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
