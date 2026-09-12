#!/usr/bin/env node
/**
 * pi-profile launcher.
 *
 * Resolves the initial profile before the Pi runtime exists (ADR-0001), then
 * hosts Pi through a controlled resource loader. Everything after the first
 * `--` is passed through to Pi.
 *
 * Usage:
 *   pi-profile                    # default profile, interactive
 *   pi-profile review             # named profile (once catalogs land)
 *   pi-profile review -- --model openai/gpt-5.4 --mode rpc
 */
import { LauncherArgError, parseLauncherArgs } from "../src/launcher/args.ts";
import { UnknownProfileError } from "../src/launcher/initial-profile.ts";
import { startProfileHost } from "../src/profile-host.ts";

try {
	const args = parseLauncherArgs(process.argv.slice(2));
	process.exitCode = await startProfileHost(args, { cwd: process.cwd() });
} catch (error) {
	if (error instanceof LauncherArgError || error instanceof UnknownProfileError) {
		console.error(`pi-profile: ${error.message}`);
		process.exitCode = 2;
	} else {
		console.error(error);
		process.exitCode = 1;
	}
}
