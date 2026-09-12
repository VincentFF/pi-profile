/**
 * Tool reference expansion against Pi's LIVE tool registry.
 *
 * Pre-spawn, the resolver expands tool globs against built-in names only
 * (extension tools are unknowable before extension code runs). Post session
 * start, the extension re-expands the raw references against
 * `pi.getAllTools()`, which includes extension- and MCP-provided names.
 * Literal references that match nothing are reported, not silently dropped
 * (Pi's setActiveTools ignores unknown names).
 */

import { minimatch } from "minimatch";

export interface ToolExpansion {
	expanded: string[];
	/** Literal references no live tool provides. */
	droppedLiterals: string[];
}

export function expandToolReferences(references: string[], liveToolNames: string[]): ToolExpansion {
	const live = new Set(liveToolNames);
	const expanded = new Set<string>();
	const droppedLiterals: string[] = [];
	for (const reference of references) {
		if (reference.includes("*") || reference.includes("?")) {
			for (const name of liveToolNames) {
				if (minimatch(name, reference)) {
					expanded.add(name);
				}
			}
			continue;
		}
		if (live.has(reference)) {
			expanded.add(reference);
		} else {
			droppedLiterals.push(reference);
		}
	}
	return { expanded: [...expanded], droppedLiterals };
}
