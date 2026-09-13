/**
 * McpOverlayFile: the only writer of the generated MCP overlay.
 *
 * Invariants:
 * - Atomic (temporary file + rename) so a reader never sees a half-written
 *   document.
 * - Written only when the bytes change: a profile switch that does not move
 *   the MCP selection produces no write and therefore no reload.
 * - Mode 0600: the overlay carries the Pi-global slot's definitions verbatim
 *   when the user keeps servers there, and those definitions may embed
 *   credentials even though the overlay itself never introduces any.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Current bytes, or undefined when the file is missing/unreadable. */
export function readMcpOverlaySync(overlayPath: string): string | undefined {
	try {
		return readFileSync(overlayPath, "utf8");
	} catch {
		return undefined;
	}
}

/** Writes `content` when it differs from what is on disk. Returns true when
 *  the file changed. */
export function writeMcpOverlayIfChangedSync(overlayPath: string, content: string): boolean {
	if (readMcpOverlaySync(overlayPath) === content) return false;
	mkdirSync(path.dirname(overlayPath), { recursive: true });
	const temporary = `${overlayPath}.tmp-${process.pid}`;
	writeFileSync(temporary, content, { mode: 0o600 });
	renameSync(temporary, overlayPath);
	return true;
}
