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
	const agentDir = getAgentDir();
	// Fails before spawning when the profile is unknown or cannot activate.
	// --approve/--no-approve are consumed here as a one-run trust input.
	const { plan, discovery, projectSettings } = await resolveInitialProfile(args.profile, {
		agentDir,
		cwd: process.cwd(),
		trustOverride: args.trustOverride,
	});
	const generated = await generateRuntimeDir(plan, { agentDir, discovery, projectSettings });
	process.exitCode = await spawnPi({
		generated,
		piArgs: args.piArgs,
		// Only the default profile keeps trust behavior native (flag re-applied);
		// named profiles never forward it — the resolver is the trust gatekeeper.
		trustOverride: plan.filter === "none" ? args.trustOverride : undefined,
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
