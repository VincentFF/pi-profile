/**
 * RuntimeCleanup: sweeps stale per-launch runtime directories at startup.
 *
 * The generated agent dirs under `<agentDir>/pi-profile/runtime/launch-*`
 * (ADR-0005) would otherwise accumulate forever. Startup sweep is the ONLY
 * cleanup mechanism by design: any exit — graceful, signal, SIGKILL, power
 * loss — kills the child pid, so the next launch's sweep converges. There is
 * no exit-time deletion; it would only buy immediacy at the cost of deletion
 * logic on the signal path.
 *
 * Liveness token: a `pid` file written by spawnPi into the runtime dir.
 * (Naming the dir after the pid is impossible — the pid does not exist
 * before spawn, and the running process's PI_CODING_AGENT_DIR path is
 * frozen.) Rules per launch-* dir:
 * - pid file parses and the process is alive (or EPERM) → keep;
 *   ESRCH → delete.
 * - no/unparsable pid file → delete only when the dir mtime is older than
 *   NO_PID_GRACE_MS. The grace window guards the concurrent-launch race (a
 *   second launcher between mkdtemp and its pid write must not be reaped);
 *   it also covers pre-feature dirs and post-mkdtemp crashes.
 * PID reuse needs no /proc check: a wrong keep only delays cleanup and
 * self-heals once the reused pid dies.
 *
 * Everything is best-effort: sweep errors never block a launch.
 */

import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

/** Grace period for launch dirs without a (parseable) pid file. */
export const NO_PID_GRACE_MS = 10 * 60 * 1000;

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but is not signal-able by us: keep.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function runtimeRootOf(agentDir: string): string {
	return path.join(agentDir, "pi-profile", "runtime");
}

async function sweepEntry(dir: string): Promise<void> {
	let pid: number | undefined;
	try {
		const raw = await readFile(path.join(dir, "pid"), "utf8");
		const parsed = Number.parseInt(raw.trim(), 10);
		if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
	} catch {
		// No pid file (or unreadable): fall through to the mtime guard.
	}

	if (pid !== undefined) {
		if (!isProcessAlive(pid)) await rm(dir, { recursive: true, force: true });
		return;
	}

	const info = await stat(dir);
	if (Date.now() - info.mtimeMs > NO_PID_GRACE_MS) {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Deletes stale launch dirs under the agent dir's runtime root. Never throws. */
export async function sweepStaleRuntimeDirs(agentDir: string): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(runtimeRootOf(agentDir));
	} catch {
		return; // No runtime root yet: nothing to sweep.
	}
	for (const entry of entries) {
		if (!entry.startsWith("launch-")) continue;
		const dir = path.join(runtimeRootOf(agentDir), entry);
		try {
			if ((await stat(dir)).isDirectory()) await sweepEntry(dir);
		} catch {
			// Best-effort: one bad entry must not stop the sweep or the launch.
		}
	}
}
