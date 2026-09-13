/**
 * The shipped JSON schema validates the shipped example and agrees with the
 * runtime parser's loadable surface.
 */

import Ajv2020Module from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const Ajv2020 = Ajv2020Module.default;

// ajv/dist/2020: draft 2020-12 support (propertyNames + const).
// Fresh instance per use — compile() registers $id and refuses duplicates.
const newAjv = () => new Ajv2020({ strict: true });

async function loadSchema(name: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path.resolve("schemas", name), "utf8")) as Record<string, unknown>;
}

describe("profiles.schema.json", () => {
	it("accepts the published example", async () => {
		const validate = newAjv().compile(await loadSchema("profiles.schema.json"));
		const example = JSON.parse(await readFile(path.resolve("examples/profiles.json"), "utf8"));

		expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
	});

	it("rejects a profile redefining the built-in default", async () => {
		const validate = newAjv().compile(await loadSchema("profiles.schema.json"));

		expect(validate({ schemaVersion: 2, profiles: { default: {} } })).toBe(false);
	});

	it("accepts a version 1 catalog with the deprecated extensions field", async () => {
		const validate = newAjv().compile(await loadSchema("profiles.schema.json"));

		expect(
			validate({
				schemaVersion: 1,
				profiles: { review: { skills: ["git-commit"], extensions: ["pi-plan-build"] } },
			}),
			JSON.stringify(validate.errors),
		).toBe(true);
	});

	it("rejects an unknown profile field (no inheritance)", async () => {
		const validate = newAjv().compile(await loadSchema("profiles.schema.json"));

		expect(validate({ schemaVersion: 2, profiles: { review: { extends: "base" } } })).toBe(false);
	});
});
