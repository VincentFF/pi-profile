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

const Ajv2020 = Ajv2020Module.default;

// ajv/dist/2020: draft 2020-12 support (propertyNames + const).
// Fresh instance per use — compile() registers $id and refuses duplicates.
const newAjv = () => new Ajv2020({ strict: true });

async function loadSchema(name: string) {
	return JSON.parse(await readFile(path.resolve("schemas", name), "utf8"));
}

describe("shipped JSON schemas", () => {
	it("profiles schema validates the shipped example", async () => {
		const profiles = await loadSchema("profiles.schema.json");
		const profilesExample = JSON.parse(await readFile(path.resolve("examples/profiles.json"), "utf8"));

		const ajv = newAjv();
		expect(ajv.validate(profiles, profilesExample), JSON.stringify(ajv.errors)).toBe(true);
	});

	it("the profiles schema rejects the built-in name, inheritance keys, and wrong types", async () => {
		const validate = newAjv().compile(await loadSchema("profiles.schema.json"));

		expect(validate({ schemaVersion: 1, profiles: { default: {} } })).toBe(false);
		expect(validate({ schemaVersion: 1, profiles: { review: { extends: "base" } } })).toBe(false);
		expect(validate({ schemaVersion: 1, profiles: { review: { skills: "oops" } } })).toBe(false);
		expect(validate({ schemaVersion: 2, profiles: {} })).toBe(false);
	});

	it("schema-valid catalogs load through the runtime parsers", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "pi-profile-schema-"));
		try {
			await writeFile(
				path.join(dir, "profiles.json"),
				await readFile(path.resolve("examples/profiles.json"), "utf8"),
			);
			const catalog = await ProfileCatalog.load(dir);
			expect(catalog.resolve("review")?.definition.label).toBe("Code review");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
