/**
 * Launcher argument parsing for the `pi-profile` binary.
 *
 * Grammar: `pi-profile [profile] [-- <pi args>...]`
 * - Before the first `--`: at most one positional profile name. No launcher flags.
 * - After the first `--`: pi arguments. Only a small set is interpreted
 *   (`--mode`, `--model`); anything else fails fast so flags are never
 *   silently dropped.
 */

export type PiRunMode = "interactive" | "print" | "json" | "rpc";

export interface LauncherArgs {
	/** Positional profile name; undefined means "use the default profile". */
	profile: string | undefined;
	/** Pi run mode, from `--mode`. Defaults to interactive. */
	mode: PiRunMode;
	/** Raw `--model` value (provider/id[:thinking]); undefined = Pi's own default resolution. */
	model: string | undefined;
}

export class LauncherArgError extends Error {}

const RUN_MODES: readonly string[] = ["interactive", "print", "json", "rpc"];

export function parseLauncherArgs(argv: string[]): LauncherArgs {
	const separator = argv.indexOf("--");
	const launcherSegment = separator === -1 ? argv : argv.slice(0, separator);
	const piSegment = separator === -1 ? [] : argv.slice(separator + 1);

	const positional = launcherSegment.filter((arg) => !arg.startsWith("-"));
	if (positional.length > 1) {
		throw new LauncherArgError(`expected at most one profile name, got: ${positional.join(", ")}`);
	}
	const unsupported = launcherSegment.find((arg) => arg.startsWith("-"));
	if (unsupported) {
		throw new LauncherArgError(
			`unknown launcher argument: ${unsupported}; pi arguments go after \`--\`, e.g. pi-profile review -- --mode rpc`,
		);
	}

	const parsed: LauncherArgs = { profile: positional[0], mode: "interactive", model: undefined };

	for (let i = 0; i < piSegment.length; i++) {
		const arg = piSegment[i];
		if (arg === "--mode") {
			parsed.mode = parseMode(requireValue(piSegment, ++i, "--mode"));
		} else if (arg.startsWith("--mode=")) {
			parsed.mode = parseMode(arg.slice("--mode=".length));
		} else if (arg === "--model") {
			parsed.model = requireValue(piSegment, ++i, "--model");
		} else if (arg.startsWith("--model=")) {
			parsed.model = arg.slice("--model=".length);
		} else {
			throw new LauncherArgError(
				`unsupported pi argument: ${arg} (supported passthrough: --mode, --model)`,
			);
		}
	}

	return parsed;
}

function parseMode(value: string): PiRunMode {
	if (!RUN_MODES.includes(value)) {
		throw new LauncherArgError(`unknown --mode: ${value} (expected one of: ${RUN_MODES.join(", ")})`);
	}
	return value as PiRunMode;
}

function requireValue(args: string[], index: number, flag: string): string {
	const value = args[index];
	if (value === undefined || value.startsWith("--")) {
		throw new LauncherArgError(`${flag} requires a value`);
	}
	return value;
}
