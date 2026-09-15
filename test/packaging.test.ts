/**
 * Packaging contract (ticket 12): `npm pack` ships every artifact the
 * runtime needs — the binary, the extension, the src graph both import,
 * the schemas, the examples — and nothing from the dev surface.
 */

import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";

function packList(): Promise<string[]> {
	return new Promise((resolve, reject) => {
		execFile(
			"npm",
			["pack", "--dry-run", "--json"],
			{
				cwd: process.cwd(),
				env: { ...process.env, npm_config_progress: "false", npm_config_loglevel: "error" },
				maxBuffer: 16 * 1024 * 1024,
			},
			(error, stdout) => {
				if (error) return reject(error);
				// Shape: { "pi-profile": { files: [{path}] } } (keyed by name).
				const parsed = JSON.parse(stdout) as Record<string, { files: Array<{ path: string }> }>;
				const entry = parsed["pi-profile"] ?? Object.values(parsed)[0];
				resolve(entry?.files.map((file) => file.path) ?? []);
			},
		);
	});
}

describe("npm pack contents", () => {
	it("ships bin, extension, src, schemas, examples; excludes dev surfaces", async () => {
		const files = await packList();

		for (const required of [
			"bin/pi-profile.ts",
			"extensions/pi-profile/index.ts",
			"src/profile-resolver.ts",
			"schemas/profiles.schema.json",
			"examples/profiles.json",
			"README.md",
			"package.json",
		]) {
			expect(files, required).toContain(required);
		}

		// The extension and bin import src/** — every src module must ship.
		expect(files.some((file) => file.startsWith("src/switching/"))).toBe(true);

		for (const excluded of ["test/", "docs/", "node_modules/", ".agents/"]) {
			expect(files.some((file) => file.startsWith(excluded)), excluded).toBe(false);
		}
	}, 60_000);
});
