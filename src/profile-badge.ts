/**
 * Profile badge: the persistent, one-line answer to "which profile is this
 * session running?".
 *
 * Presentation only — no state, no I/O, no activation. The extension decides
 * when a badge is written (after an activation that succeeded, via
 * `ctx.ui.setStatus(PROFILE_STATUS_KEY, …)`), so the badge can never claim a
 * selection that was not applied.
 *
 * One canonical rendering, shared with the `/profile status` heading
 * (`profile: <name>`), plus `*` when a runtime overlay is in effect — the only
 * runtime difference the catalog does not show.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";

import { DEFAULT_PROFILE_NAME } from "./profile-catalog.ts";

/**
 * Status key in Pi's footer. Pi joins all extension statuses into one line and
 * truncates it from the right, ordered by key, so `profile` sorts before `mcp`
 * and `pi-…`: a narrow terminal drops this badge last, not first.
 */
export const PROFILE_STATUS_KEY = "profile";

/** The label prefix, matching the `/profile status` heading. */
export const PROFILE_BADGE_LABEL = "profile";

/**
 * Display columns reserved for the name before it is elided. The footer is a
 * shared, fixed-width line: profile names are unbounded user input, so an
 * unelided name would evict the statuses of other extensions.
 */
export const PROFILE_BADGE_NAME_COLUMNS = 16;

const ELLIPSIS = "…";

export interface ProfileBadge {
	/** The name `/profile use` accepts (never the display `label`). */
	name: string;
	/** A runtime overlay is in effect: this runtime differs from the catalog. */
	overlay: boolean;
}

/** The minimum theme surface the badge needs; `ctx.ui.theme` satisfies it. */
export interface BadgeTheme {
	fg(color: ThemeColor, text: string): string;
}

export interface BadgeOptions {
	overlay: boolean;
	/** Override the name budget (tests, future width awareness). */
	nameColumns?: number;
}

/**
 * Builds the badge for a resolved profile, or `undefined` when there must be
 * no badge at all.
 *
 * `default` is Pi's native baseline — it declares nothing — so it must not
 * change the footer either: a plain Pi session shows no badge, and the footer
 * status line only exists while some extension status is set.
 */
export function buildProfileBadge(name: string, options: BadgeOptions): ProfileBadge | undefined {
	if (name === DEFAULT_PROFILE_NAME) return undefined;
	return {
		name: truncateToColumns(name, options.nameColumns ?? PROFILE_BADGE_NAME_COLUMNS),
		overlay: options.overlay,
	};
}

/**
 * Renders the badge. Colors come from the caller's theme at render time: Pi
 * stores footer statuses as finished strings, so the extension re-renders on
 * profile changes and on each turn (there is no extension-visible theme-change
 * event).
 */
export function renderProfileBadge(badge: ProfileBadge, theme: BadgeTheme): string {
	const label = theme.fg("dim", `${PROFILE_BADGE_LABEL}: `);
	const name = theme.fg("dim", badge.name);
	return badge.overlay ? `${label}${name}${theme.fg("warning", "*")}` : `${label}${name}`;
}

/* -------------------------------------------------------------------------- */
/* Display width                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Width of one code point in terminal columns: 2 for East Asian wide and
 * fullwidth code points, 1 otherwise. Zero-width joiners and combining marks
 * are counted as 1 — an approximation that only over-reserves space for
 * exotic names.
 */
export function codePointWidth(codePoint: number): number {
	return isWide(codePoint) ? 2 : 1;
}

/** Display width of `text` in terminal columns. */
export function displayWidth(text: string): number {
	let width = 0;
	for (const character of text) width += codePointWidth(character.codePointAt(0)!);
	return width;
}

/**
 * Truncates `text` to at most `columns` terminal columns, appending `…` when
 * something was dropped. The ellipsis is part of the budget, so the result
 * never exceeds `columns`.
 */
export function truncateToColumns(text: string, columns: number, ellipsis = ELLIPSIS): string {
	if (columns <= 0) return "";
	if (displayWidth(text) <= columns) return text;
	const budget = columns - displayWidth(ellipsis);
	let result = "";
	let width = 0;
	for (const character of text) {
		const next = width + codePointWidth(character.codePointAt(0)!);
		if (next > budget) break;
		result += character;
		width = next;
	}
	return budget < 0 ? "" : `${result}${ellipsis}`;
}

function isWide(codePoint: number): boolean {
	return (
		(codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
		(codePoint >= 0x2e80 && codePoint <= 0x303e) || // CJK radicals, Kangxi, CJK symbols
		(codePoint >= 0x3041 && codePoint <= 0x33ff) || // kana, CJK compatibility, CJK punctuation
		(codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK unified ideographs extension A
		(codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK unified ideographs
		(codePoint >= 0xa000 && codePoint <= 0xa4cf) || // Yi syllables
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul syllables
		(codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compatibility ideographs
		(codePoint >= 0xfe30 && codePoint <= 0xfe6f) || // CJK compatibility forms
		(codePoint >= 0xff00 && codePoint <= 0xff60) || // fullwidth forms
		(codePoint >= 0xffe0 && codePoint <= 0xffe6) || // fullwidth signs
		(codePoint >= 0x1f300 && codePoint <= 0x1faff) || // emoji, pictographs
		(codePoint >= 0x20000 && codePoint <= 0x3fffd) // CJK unified ideographs extension B+
	);
}
