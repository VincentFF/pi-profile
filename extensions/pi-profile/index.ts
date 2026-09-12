import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import path from "node:path";

import { readTrustInputs } from "../../src/launcher/initial-profile.ts";
import { discoverAdapterServerNames } from "../../src/mcp-config.ts";
import { RuntimeStateStore } from "../../src/runtime-state-store.ts";
import { applyLaunchPlan, readLaunchPlanFile } from "../../src/switching/apply-plan.ts";
import { CUSTOMIZE_USAGE, customizeOverlay, parseCustomizeArgs, resetOverlay } from "../../src/switching/customize.ts";
import { formatProfileList, listProfiles } from "../../src/switching/list-profiles.ts";
import { buildStatusReport, formatStatusMarkdown } from "../../src/switching/status.ts";
import { switchProfile, type SwitchDeps } from "../../src/switching/switch-profile.ts";

/**
 * pi-profile extension entry.
 *
 * Loaded into the spawned pi via `-e`. Responsibilities:
 * - Append the profile's declared instructions to Pi's fully built system
 *   prompt on every turn (`before_agent_start`), so the default prompt,
 *   AGENTS.md, and other extensions keep working.
 * - After every session start (startup/reload/new/resume/fork), apply the
 *   launch plan: re-expand tool references against Pi's live registry,
 *   set the declared model/thinking, publish the MCP allowlist, persist the
 *   selection + rollback anchor after switches, and produce the one-shot
 *   change summary injected into the next turn.
 * - `/profile use <name>` / `/profile reload`: in-session switching without
 *   restarting the Pi process (src/switching/switch-profile.ts).
 * - `/profile customize` / `/profile reset`: runtime overlay (ticket 06).
 * - `/profile` (selector), `/profile list`, `/profile status`:
 *   observability surface (ticket 07). Status combines the active launch
 *   plan, the stored overlay, fresh MCP discovery, and Pi's actual command
 *   registrations (the winner evidence for same-name conflicts).
 *
 * Pi re-executes this module on reload, so post-reload state is established
 * exclusively through `session_start` — nothing stale survives.
 */

export default function piProfileExtension(pi: ExtensionAPI): void {
	const runtimeDir = process.env.PI_CODING_AGENT_DIR;
	if (runtimeDir === undefined) return;

	let pendingSummary: string | undefined;

	pi.on("session_start", async (event, ctx) => {
		const result = await applyLaunchPlan({
			runtimeDir,
			cwd: ctx.cwd,
			reason: event.reason,
			surface: {
				getAllTools: () => pi.getAllTools(),
				setActiveTools: (names) => pi.setActiveTools(names),
				modelRegistry: ctx.modelRegistry,
				setModel: (model) => pi.setModel(model as Parameters<ExtensionAPI["setModel"]>[0]),
				setThinkingLevel: (level) =>
					pi.setThinkingLevel(level as Parameters<ExtensionAPI["setThinkingLevel"]>[0]),
				events: pi.events,
				notify: (message, level) => ctx.ui?.notify(message, level),
			},
		});
		pendingSummary = result.summary;
	});

	pi.on("before_agent_start", async (event) => {
		const plan = await readLaunchPlanFile(runtimeDir);
		const instructions = plan?.instructions;
		let systemPrompt = event.systemPrompt;
		if (instructions !== undefined && instructions.length > 0) {
			systemPrompt = `${systemPrompt}\n\n${instructions}`;
		}
		if (pendingSummary !== undefined) {
			systemPrompt = `${systemPrompt}\n\n[${pendingSummary}]`;
			pendingSummary = undefined;
		}
		return { systemPrompt };
	});

	pi.registerCommand("profile", {
		description: "pi-profile: /profile [use <name> | reload | customize ... | reset | list | status]",
		handler: async (args, ctx) => {
			const [subcommandRaw, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = subcommandRaw ?? ""; // bare /profile → selector
			const notify = (message: string, level: "info" | "warning" | "error") => ctx.ui?.notify(message, level);
			const usage = `usage: /profile [use <name> | reload | ${CUSTOMIZE_USAGE} | reset | list | status]`;
			if (subcommand === "use" && rest.length === 0) {
				notify("usage: /profile use <name>", "error");
				return;
			}
			if (subcommand !== "" && !["use", "reload", "customize", "reset", "list", "status"].includes(subcommand)) {
				notify(usage, "error");
				return;
			}
			try {
				const plan = await readLaunchPlanFile(runtimeDir);
				if (plan?.agentDir === undefined) {
					// Without the real agent dir the switch cannot reach catalogs,
					// trust state, or state files — fail loudly, never guess one.
					notify("cannot switch: the launch plan carries no real agent dir", "error");
					return;
				}
				const deps: SwitchDeps = {
					runtimeDir,
					realAgentDir: plan.agentDir,
					cwd: ctx.cwd,
					waitForIdle: () => ctx.waitForIdle(),
					reload: () => ctx.reload(),
					// A real reload invalidates this context (Pi re-executes
					// extensions); property access then throws. Interactive Pi
					// swallows reload refusals, so this probe is the switch's
					// proof that the reload actually ran.
					assertStale: () => {
						void ctx.cwd;
					},
				};
				if (subcommand === "use") {
					const result = await switchProfile(rest[0], deps, { clearOverlay: true });
					for (const warning of result.warnings) notify(warning, "warning");
					notify(`profile active: ${result.profile}`, "info");
					return;
				}
				if (subcommand === "reload") {
					const result = await switchProfile(undefined, deps, { reloadCurrent: true });
					for (const warning of result.warnings) notify(warning, "warning");
					notify(`profile reloaded: ${result.profile}`, "info");
					return;
				}
				if (subcommand === "customize") {
					const result = await customizeOverlay(deps, parseCustomizeArgs(rest.join(" ")));
					for (const warning of result.warnings) notify(warning, "warning");
					notify(`overlay updated: ${result.profile}`, "info");
					return;
				}
				if (subcommand === "reset") {
					const result = await resetOverlay(deps);
					for (const warning of result.warnings) notify(warning, "warning");
					notify(`overlay cleared: ${result.profile}`, "info");
					return;
				}
				// Observability surface (ticket 07): bare /profile opens the
				// selector; list/status render via a displayed custom message.
				const entries = await listProfiles({ realAgentDir: plan.agentDir, cwd: ctx.cwd });
				if (subcommand === "list") {
					pi.sendMessage({
						customType: "pi-profile",
						content: formatProfileList(entries, plan.profile),
						display: true,
					});
					return;
				}
				if (subcommand === "status") {
					const { projectTrusted } = await readTrustInputs({ agentDir: plan.agentDir, cwd: ctx.cwd });
					const stateDir = plan.source === "project" ? path.join(ctx.cwd, ".pi") : plan.agentDir;
					const state = await new RuntimeStateStore(stateDir).read();
					const report = buildStatusReport({
						plan,
						overlay: state.overlay,
						discoveredMcpServers: await discoverAdapterServerNames(
							plan.agentDir,
							projectTrusted ? ctx.cwd : undefined,
						),
						commands: pi.getCommands(),
						tools: pi.getAllTools(),
					});
					pi.sendMessage({
						customType: "pi-profile",
						content: formatStatusMarkdown(report),
						display: true,
					});
					return;
				}
				// Bare /profile: the interactive selector. Without dialog-capable
				// UI (print mode), fall back to the list.
				if (!ctx.hasUI) {
					pi.sendMessage({
						customType: "pi-profile",
						content: formatProfileList(entries, plan.profile),
						display: true,
					});
					return;
				}
				const choice = await ctx.ui.select(
					"select a profile",
						entries.map((entry) => {
						const label = entry.label ?? entry.description;
						return `${entry.name} [${entry.source}]${label !== undefined ? ` — ${label}` : ""}`;
					}),
				);
				if (choice === undefined) return; // cancelled
				const chosen = choice.split(" [")[0] ?? choice;
				if (chosen === plan.profile) return;
				const switched = await switchProfile(chosen, deps, { clearOverlay: true });
				for (const warning of switched.warnings) notify(warning, "warning");
			} catch (error) {
				notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
