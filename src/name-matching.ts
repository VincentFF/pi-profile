/**
 * NameMatching: the single implementation of literal/glob reference matching
 * and did-you-mean suggestions, shared by the resolver (selection) and the
 * prompt filter (visible skills).
 */

import { minimatch } from "minimatch";

export function isGlob(pattern: string): boolean {
	return pattern.includes("*") || pattern.includes("?") || pattern.includes("!");
}

export function matchesReference(pattern: string, candidate: string): boolean {
	return isGlob(pattern) ? minimatch(candidate, pattern) : candidate === pattern;
}

/** Levenshtein distance, used only for did-you-mean hints. */
function editDistance(a: string, b: string): number {
	const rows = a.length + 1;
	const cols = b.length + 1;
	let previous = Array.from({ length: cols }, (_, index) => index);
	for (let row = 1; row < rows; row++) {
		const current = [row];
		for (let col = 1; col < cols; col++) {
			const cost = a[row - 1] === b[col - 1] ? 0 : 1;
			current[col] = Math.min(current[col - 1] + 1, previous[col] + 1, previous[col - 1] + cost);
		}
		previous = current;
	}
	return previous[cols - 1];
}

/** Up to three near-name suggestions for a literal reference. */
export function suggestNames(reference: string, candidates: string[]): string[] {
	const lowered = reference.toLowerCase();
	const scored = candidates
		.map((candidate) => {
			const loweredCandidate = candidate.toLowerCase();
			const prefix = loweredCandidate.startsWith(lowered) || lowered.startsWith(loweredCandidate);
			const contains = loweredCandidate.includes(lowered) || lowered.includes(loweredCandidate);
			return { candidate, distance: editDistance(lowered, loweredCandidate), prefix, contains };
		})
		.filter((entry) => entry.prefix || entry.contains || entry.distance <= Math.max(2, Math.ceil(reference.length / 3)))
		.sort((a, b) => {
			if (a.prefix !== b.prefix) return a.prefix ? -1 : 1;
			if (a.contains !== b.contains) return a.contains ? -1 : 1;
			return a.distance - b.distance;
		});
	return scored.slice(0, 3).map((entry) => entry.candidate);
}
