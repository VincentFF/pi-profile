#!/usr/bin/env node
/**
 * pi-profile launcher (ADR-0005).
 *
 * Resolves the initial profile, materializes it as a generated runtime
 * directory (settings + symlinks + env + flags), and spawns the real `pi`
 * binary with user arguments passed through verbatim.
 *
 * Usage:
 *   pi-profile                          # default profile
 *   pi-profile review                   # named profile (once catalogs land)
 *   pi-profile review -- --mode rpc --model openai/gpt-5.4
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { parseLauncherArgs } from "../src/launcher/args.ts";
import { UnknownProfileError, resolveInitialProfile } from "../src/launcher/initial-profile.ts";
import { spawnPi } from "../src/launcher/spawn.ts";
import { generateRuntimeDir } from "../src/settings-generator.ts";

try {
	const args = parseLauncherArgs(process.argv.slice(2));
	// Fails before spawning when the profile is unknown.
	const plan = resolveInitialProfile(args.profile);
	const generated = await generateRuntimeDir(plan, { agentDir: getAgentDir() });
	process.exitCode = await spawnPi({
		generated,
		piArgs: args.piArgs,
		trustOverride: args.trustOverride,
	});
} catch (error) {
	if (error instanceof UnknownProfileError) {
		console.error(`pi-profile: ${error.message}`);
		process.exitCode = 2;
	} else {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
