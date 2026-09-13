/**
 * AdapterPresence: a cheap, deterministic "is pi-mcp-adapter installed?"
 * check that does not depend on extension load order.
 *
 * The overlay mechanism only exists to serve the adapter; when the adapter is
 * absent the extension must not register the `mcp-config` flag default and
 * must not write anything. Signals, in order of reliability:
 *
 * 1. Pi's npm package root (`<agentDir>/npm/node_modules/pi-mcp-adapter`).
 * 2. The command line (`-e <path>` / `--extension <path>`).
 * 3. Pi settings `packages` entries.
 * 4. The adapter's own event-bus presence probe, when it answered during
 *    extension loading (only reliable when the adapter loaded first).
 *
 * Any failure reads as "absent": a false negative only disables the overlay,
 * while a false positive could hide the user's own Pi-global slot file.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { isRecord } from "./json-file.ts";

const ADAPTER_PACKAGE = "pi-mcp-adapter";

export interface AdapterPresenceInput {
	agentDir: string;
	argv: readonly string[];
	/** Result of the adapter's event-bus probe, when the caller ran one. */
	probeAnswered?: boolean;
}

export function adapterPresent(input: AdapterPresenceInput): boolean {
	if (input.probeAnswered === true) return true;
	try {
		for (const candidate of [
			path.join(input.agentDir, "npm", "node_modules", ADAPTER_PACKAGE),
			path.join(input.agentDir, "node_modules", ADAPTER_PACKAGE),
		]) {
			if (existsSync(candidate)) return true;
		}
		return argvMentionsAdapter(input.argv) || settingsListAdapter(input.agentDir);
	} catch {
		return false;
	}
}

function argvMentionsAdapter(argv: readonly string[]): boolean {
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index] ?? "";
		if (token.includes(ADAPTER_PACKAGE)) return true;
		if ((token === "-e" || token === "--extension") && (argv[index + 1] ?? "").includes(ADAPTER_PACKAGE)) {
			return true;
		}
	}
	return false;
}

function settingsListAdapter(agentDir: string): boolean {
	try {
		const raw: unknown = JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8"));
		if (!isRecord(raw) || !Array.isArray(raw.packages)) return false;
		return raw.packages.some((entry) => {
			const source =
				typeof entry === "string"
					? entry
					: isRecord(entry) && typeof entry.source === "string"
						? entry.source
						: undefined;
			return source !== undefined && source.includes(ADAPTER_PACKAGE);
		});
	} catch {
		return false;
	}
}
