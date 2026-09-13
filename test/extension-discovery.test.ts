import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	discoverImplicitExtensions,
	packageNameFromSource,
	type ImplicitExtensionDiscovery,
} from "../src/extension-discovery.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

/** Creates a fake installed package under the fixture's npm root. */
async function addPackage(
	name: string,
	options: { extensions?: string[]; manifestName?: string },
): Promise<{ source: string; root: string }> {
	const root = path.join(fixture.agentDir, "npm", "node_modules", ...name.split("/"));
	await mkdir(root, { recursive: true });
	const manifest: Record<string, unknown> = {};
	if (options.manifestName !== undefined) manifest.name = options.manifestName;
	else manifest.name = name;
	if (options.extensions !== undefined) {
		manifest.pi = { extensions: options.extensions };
		for (const rel of options.extensions) {
			const file = path.join(root, rel);
			await mkdir(path.dirname(file), { recursive: true });
			await writeFile(file, "export default function () {}\n");
		}
	}
	await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
	return { source: `npm:${name}`, root };
}

async function addLoose(dir: string, name: string): Promise<string> {
	await mkdir(dir, { recursive: true });
	const file = path.join(dir, name);
	await writeFile(file, "export default function () {}\n");
	return file;
}

const EMPTY: ImplicitExtensionDiscovery = { packages: [], local: [], warnings: [] };

describe("packageNameFromSource", () => {
	it("strips prefixes and version specs", () => {
		expect(packageNameFromSource("npm:pi-mcp-adapter")).toBe("pi-mcp-adapter");
		expect(packageNameFromSource("npm:@janvitos/pi-plan-build")).toBe("@janvitos/pi-plan-build");
		expect(packageNameFromSource("npm:@scope/pkg@1.2.3")).toBe("@scope/pkg");
		expect(packageNameFromSource("npm:pkg@^2.0.0")).toBe("pkg");
		expect(packageNameFromSource("git:https://example.com/x.git")).toBe("https://example.com/x.git");
	});
});

describe("discoverImplicitExtensions", () => {
	it("discovers a package's declared pi.extensions entries", async () => {
		const pkg = await addPackage("pi-mcp-adapter", { extensions: ["./index.ts"] });

		const result = await discoverImplicitExtensions({ agentDir: fixture.agentDir, packages: [pkg] });

		expect(result.warnings).toEqual([]);
		expect(result.packages).toEqual([
			{
				name: "pi-mcp-adapter",
				source: "npm:pi-mcp-adapter",
				root: pkg.root,
				entries: [path.join(pkg.root, "index.ts")],
			},
		]);
	});

	it("lists every entry of a multi-entry package", async () => {
		const pkg = await addPackage("pi-multi", { extensions: ["./index.ts", "./panel.ts"] });

		const result = await discoverImplicitExtensions({ agentDir: fixture.agentDir, packages: [pkg] });

		expect(result.packages[0]?.entries).toHaveLength(2);
	});

	it("skips skills-only packages and packages without readable manifests", async () => {
		const skillsOnly = await addPackage("pi-skills", {});
		const notInstalled = { source: "npm:ghost", root: path.join(fixture.agentDir, "npm", "node_modules", "ghost") };

		const result = await discoverImplicitExtensions({
			agentDir: fixture.agentDir,
			packages: [skillsOnly, notInstalled, { source: "npm:unresolved", root: undefined }],
		});

		expect(result.packages).toEqual([]);
	});

	it("skips declared entries missing on disk", async () => {
		const pkg = await addPackage("pi-partial", { extensions: ["./index.ts"] });
		await rm(path.join(pkg.root, "index.ts"));

		const result = await discoverImplicitExtensions({ agentDir: fixture.agentDir, packages: [pkg] });

		expect(result.packages).toEqual([]);
	});

	it("falls back to the source-derived name when the manifest has none", async () => {
		const root = path.join(fixture.agentDir, "npm", "node_modules", "pi-noname");
		await mkdir(root, { recursive: true });
		await writeFile(path.join(root, "index.ts"), "export default function () {}\n");
		await writeFile(path.join(root, "package.json"), JSON.stringify({ pi: { extensions: ["./index.ts"] } }));

		const result = await discoverImplicitExtensions({
			agentDir: fixture.agentDir,
			packages: [{ source: "npm:pi-noname", root }],
		});

		expect(result.packages[0]?.name).toBe("pi-noname");
	});

	it("discovers loose files by filename stem, .ts preferred over a .js sibling", async () => {
		const dir = path.join(fixture.agentDir, "extensions");
		const tsFile = await addLoose(dir, "conventions.ts");
		await addLoose(dir, "conventions.js");
		const other = await addLoose(dir, "review-guard.js");

		const result = await discoverImplicitExtensions({ agentDir: fixture.agentDir, packages: [] });

		expect(result.local).toEqual([
			{ id: "conventions", entry: tsFile },
			{ id: "review-guard", entry: other },
		]);
		expect(result.warnings.some((warning) => warning.includes("conventions"))).toBe(true);
	});

	it("project loose files override same-stem global ones for trusted projects", async () => {
		await addLoose(path.join(fixture.agentDir, "extensions"), "shared.ts");
		const projectFile = await addLoose(path.join(fixture.cwd, ".pi", "extensions"), "shared.ts");

		const result = await discoverImplicitExtensions({
			agentDir: fixture.agentDir,
			packages: [],
			projectDir: fixture.cwd,
		});

		expect(result.local).toEqual([{ id: "shared", entry: projectFile }]);
	});

	it("never scans the project dir when it is not passed (untrusted)", async () => {
		await addLoose(path.join(fixture.cwd, ".pi", "extensions"), "secret.ts");

		const result = await discoverImplicitExtensions({ agentDir: fixture.agentDir, packages: [] });

		expect(result.local).toEqual([]);
	});

	it("an empty discovery result is a valid input", () => {
		expect(EMPTY.packages).toEqual([]);
	});
});
