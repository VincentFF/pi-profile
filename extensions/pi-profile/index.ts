import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-profile extension entry.
 *
 * Loads with the package so the in-session seam exists from the first ticket;
 * the `/profile` command family (switch, status, CRUD wizards) registers here
 * in the switching/CRUD tickets.
 */
export default function piProfileExtension(_pi: ExtensionAPI): void {
	// Intentionally empty for now: command surface lands in later tickets.
}
