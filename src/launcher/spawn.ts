/**
 * Spawns the real `pi` binary as a subprocess (ADR-0005).
 *
 * The spawned pi gets: the pi-profile extension via `-e`, any generated
 * flags, and the user's arguments verbatim. stdio is inherited so interactive
 * TUI, RPC, and print modes all behave natively; exit codes and signals
 * propagate.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { GeneratedRuntime } from "../settings-generator.ts";

export interface SpawnPiOptions {
	/** Generated runtime dir + env + flags. */
	generated: GeneratedRuntime;
	/** User arguments, forwarded verbatim. */
	piArgs: string[];
	/** Trust override recorded by the launcher; re-applied natively for the default profile. */
	trustOverride: boolean | undefined;
}

const EXTENSION_ENTRY = fileURLToPath(new URL("../../extensions/pi-profile/index.ts", import.meta.url));

/** Pure argv construction for the spawned pi: extension entry, generated
 *  flags, trust re-application, then user args verbatim. */
export function buildPiArgs(options: SpawnPiOptions): string[] {
	const args = ["-e", EXTENSION_ENTRY, ...options.generated.flags];
	// default profile keeps trust behavior native: re-apply the recorded flag.
	if (options.trustOverride === true) args.push("--approve");
	if (options.trustOverride === false) args.push("--no-approve");
	args.push(...options.piArgs);
	return args;
}

export async function spawnPi(options: SpawnPiOptions): Promise<number> {
	const child = spawn("pi", buildPiArgs(options), {
		stdio: "inherit",
		env: { ...process.env, ...options.generated.env },
	});

	const onSigint = () => child.kill("SIGINT");
	const onSigterm = () => child.kill("SIGTERM");
	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);

	try {
		return await new Promise<number>((resolve, reject) => {
			child.on("error", (error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") {
					reject(new Error(`pi binary not found on PATH`));
				} else {
					reject(error);
				}
			});
			child.on("exit", (code, signal) => {
				if (code !== null) resolve(code);
				else resolve(signal === "SIGINT" ? 130 : 1);
			});
		});
	} finally {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
	}
}
