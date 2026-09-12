import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import path from "node:path";

import { readTrustInputs } from "../../src/launcher/initial-profile.ts";
import { discoverAdapterServerNames } from "../../src/mcp-config.ts";
import { RuntimeStateStore } from "../../src/runtime-state-store.ts";
import { applyLaunchPlan, readLaunchPlanFile } from "../../src/switching/apply-plan.ts";
import { CUSTOMIZE_USAGE, customizeOverlay, parseCustomizeArgs, resetOverlay } from "../../src/switching/customize.ts";
import { formatProfileList, listProfiles } from "../../src/switching/list-profiles.ts";
import {
	createProfile,
	deleteProfile,
	duplicateProfile,
	editProfile,
	readCatalogScope,
} from "../../src/switching/profile-crud.ts";
import type { ProfileDefinition } from "../../src/profile-catalog.ts";
import {
	runProfileCreateWizard,
	runProfileDuplicateWizard,
	runProfileEditWizard,
} from "../../src/switching/profile-wizard.ts";
import { deleteRegistryEntry, listRegistryEntries, upsertRegistryEntry } from "../../src/switching/resource-crud.ts";
import { runResourceWizard } from "../../src/switching/resource-wizard.ts";
import { probeAdapterPresence } from "../../src/mcp-coordination.ts";
import { setMcpServerEnabled } from "../../src/switching/mcp-toggle.ts";
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
 * - `/profile create|edit|delete|duplicate` and `/profile resource
 *   create|edit|delete`: catalog/registry CRUD wizards (tickets 08/09).
 *   CRUD is TUI-only (ticket 11): gated on `ctx.mode === "tui"` with a
 *   mode-aware refusal. Mutations apply via the standard reload path;
 *   mutation success is notified BEFORE the reload — the command context
 *   is stale afterwards.
 * - list/status ship structured `details` payloads (`{kind, profiles}` /
 *   `{kind, report}`) for RPC consumers (ticket 11).
 * - `/mcp enable|disable <server>`: edit the active profile's mcp array in
 *   its owning catalog, then reload (ticket 10). Fails clearly with the
 *   adapter absent; notifies before the reload (stale context after).
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
		description: "pi-profile: /profile [use|reload|customize|reset|list|status|resource|create|edit|delete|duplicate]",
		handler: async (args, ctx) => {
			const [subcommandRaw, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = subcommandRaw ?? ""; // bare /profile → selector
			// Stale-tolerant: after a successful reload this command context is
			// invalidated and property access throws. Post-reload feedback is
			// the new instance's job (session_start summary), so swallowed
			// stale-ctx failures lose nothing the user would otherwise see.
			const notify = (message: string, level: "info" | "warning" | "error") => {
				try {
					ctx.ui?.notify(message, level);
				} catch {
					// stale context after reload — see above
				}
			};
			const usage = `usage: /profile [use <name> | reload | ${CUSTOMIZE_USAGE} | reset | list | status | resource ... | create | edit <name> | delete <name> | duplicate]`;
			if (subcommand === "use" && rest.length === 0) {
				notify("usage: /profile use <name>", "error");
				return;
			}
			if (
				subcommand !== "" &&
				![
					"use",
					"reload",
					"customize",
					"reset",
					"list",
					"status",
					"resource",
					"create",
					"edit",
					"delete",
					"duplicate",
				].includes(
					subcommand,
				)
			) {
				notify(usage, "error");
				return;
			}
			if (["edit", "delete"].includes(subcommand) && rest[0] === undefined) {
				notify(`usage: /profile ${subcommand} <name>`, "error");
				return;
			}
			if (subcommand === "resource" && !["list", "create", "edit", "delete"].includes(rest[0] ?? "")) {
				notify("usage: /profile resource list|create|edit <id>|delete <id>", "error");
				return;
			}
			if (subcommand === "resource" && ["edit", "delete"].includes(rest[0] ?? "") && rest[1] === undefined) {
				notify(`usage: /profile resource ${rest[0]} <id>`, "error");
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
				// Resource-registry CRUD (ticket 08): mutations land in the
				// chosen scope file, then apply through the standard
				// rewrite-settings-and-reload path.
				if (subcommand === "resource") {
					const [action, targetId] = rest as [string, string?];
					const listing = await listRegistryEntries({ realAgentDir: plan.agentDir, cwd: ctx.cwd });
					if (action === "list") {
						const lines = listing.map(
							(entry) =>
								`${entry.id} [${entry.source}]${entry.shadowsGlobal ? " (shadows global)" : ""} → ${entry.entry}` +
								`${entry.alwaysOn ? " alwaysOn" : ""}${entry.dependsOn.length > 0 ? ` dependsOn=[${entry.dependsOn.join(", ")}]` : ""}`,
						);
						pi.sendMessage({
							customType: "pi-profile",
							content: lines.length > 0 ? lines.join("\n") : "no resources registered",
							display: true,
						});
						return;
					}
					if (ctx.mode !== "tui") {
						notify(`/profile resource ${action} requires TUI mode (current mode: ${ctx.mode})`, "error");
						return;
					}
					if (action === "delete") {
						const id = targetId as string;
						const matches = listing.filter((entry) => entry.id === id);
						if (matches.length === 0) {
							notify(`resource "${id}" not found`, "error");
							return;
						}
						// An entry present in both scopes needs an explicit scope
						// choice — the project override and the global base are
						// independent records.
						const scope =
							matches.length === 1
								? matches[0]?.source
								: ((await ctx.ui.select(`delete "${id}" from which registry?`, ["global", "project"])) as
										| "global"
										| "project"
										| undefined);
						if (scope === undefined) return;
						const confirmed = await ctx.ui.confirm("delete resource?", `delete "${id}" from the ${scope} registry`);
						if (!confirmed) return;
						await deleteRegistryEntry({ realAgentDir: plan.agentDir, cwd: ctx.cwd }, scope, id);
						// Notify BEFORE the reload: this context is stale
						// afterwards, so post-reload messages never arrive.
						notify(`deleted resource "${id}" (${scope}); reloading`, "info");
						const result = await switchProfile(plan.profile, deps, { reloadCurrent: true });
						for (const warning of result.warnings) notify(warning, "warning");
						return;
					}
					// create | edit → wizard
					const existing =
						action === "edit" ? listing.find((entry) => entry.id === targetId) : undefined;
					if (action === "edit" && existing === undefined) {
						notify(`resource "${targetId ?? ""}" not found`, "error");
						return;
					}
					const { projectTrusted: trustedForWizard } = await readTrustInputs({ agentDir: plan.agentDir, cwd: ctx.cwd });
					const wizard = await runResourceWizard(ctx.ui, { projectTrusted: trustedForWizard, existing });
					if (wizard === undefined) return; // cancelled
					await upsertRegistryEntry({ realAgentDir: plan.agentDir, cwd: ctx.cwd }, wizard.scope, wizard.entry);
					notify(
						`${action === "create" ? "created" : "updated"} resource "${wizard.entry.id}" (${wizard.scope}); reloading`,
						"info",
					);
					const result = await switchProfile(plan.profile, deps, { reloadCurrent: true });
					for (const warning of result.warnings) notify(warning, "warning");
					return;
				}
				// Profile catalog CRUD (ticket 09): TUI-only wizards; mutations
				// land in the chosen scope file. Editing the active profile
				// reloads immediately; deleting the active profile requires a
				// replacement chosen up front, then switches to it.
				if (["create", "edit", "delete", "duplicate"].includes(subcommand)) {
					if (ctx.mode !== "tui") {
						notify(`/profile ${subcommand} requires TUI mode (current mode: ${ctx.mode})`, "error");
						return;
					}
					const scopeInput = { realAgentDir: plan.agentDir, cwd: ctx.cwd };
					if (subcommand === "create") {
						const { projectTrusted: canWriteProject } = await readTrustInputs({
							agentDir: plan.agentDir,
							cwd: ctx.cwd,
						});
						const wizard = await runProfileCreateWizard(ctx.ui, { projectTrusted: canWriteProject });
						if (wizard === undefined) return;
						await createProfile(scopeInput, wizard.scope, wizard.name, wizard.definition);
						notify(`created profile "${wizard.name}" (${wizard.scope}) — activate with /profile use ${wizard.name}`, "info");
						return;
					}
					if (subcommand === "duplicate") {
						const entries = await listProfiles(scopeInput);
						// Read each scope once (trust-gated — never reads an
						// untrusted project's catalog).
						const byScope = {
							global: await readCatalogScope(scopeInput, "global"),
							project: await readCatalogScope(scopeInput, "project"),
						};
						const candidates: Array<{ name: string; source: "global" | "project"; definition: ProfileDefinition }> = [];
						for (const entry of entries) {
							if (entry.source === "builtin") continue;
							const definition = byScope[entry.source].get(entry.name);
							if (definition !== undefined) {
								candidates.push({ name: entry.name, source: entry.source, definition });
							}
						}
						const wizard = await runProfileDuplicateWizard(ctx.ui, { candidates });
						if (wizard === undefined) return;
						await duplicateProfile(scopeInput, wizard.scope, wizard.sourceName, wizard.newName);
						notify(
							`duplicated "${wizard.sourceName}" → "${wizard.newName}" (${wizard.scope}) — the full definition was copied`,
							"info",
						);
						return;
					}
					const name = rest[0] as string;
					if (subcommand === "edit") {
						// Edit the WINNING definition in its source scope.
						const entries = await listProfiles(scopeInput);
						const existing = entries.find((entry) => entry.name === name);
						if (existing === undefined || existing.source === "builtin") {
							notify(`profile "${name}" not found in a writable catalog`, "error");
							return;
						}
						const definition = (await readCatalogScope(scopeInput, existing.source)).get(name);
						if (definition === undefined) {
							notify(`profile "${name}" not found in the ${existing.source} catalog`, "error");
							return;
						}
						const wizard = await runProfileEditWizard(ctx.ui, {
							existing: { name, source: existing.source, definition },
						});
						if (wizard === undefined) return;
						await editProfile(scopeInput, wizard.scope, wizard.name, wizard.definition);
						if (name === plan.profile) {
							notify(`saved profile "${name}"; reloading`, "info");
							await switchProfile(plan.profile, deps, { reloadCurrent: true });
						} else {
							notify(`saved profile "${name}" (inactive — runtime untouched)`, "info");
						}
						return;
					}
					// delete
					const entries = await listProfiles(scopeInput);
					const existing = entries.find((entry) => entry.name === name);
					if (existing === undefined || existing.source === "builtin") {
						notify(`profile "${name}" not found in a writable catalog`, "error");
						return;
					}
					// Both scopes hold the name: choose which record to delete.
					let scope = existing.source as "global" | "project";
					const projectCatalog = await readCatalogScope(scopeInput, "project");
					const globalCatalog = await readCatalogScope(scopeInput, "global");
					if (projectCatalog.has(name) && globalCatalog.has(name)) {
						const chosen = await ctx.ui.select(`delete "${name}" from which catalog?`, ["global", "project"]);
						if (chosen === undefined) return;
						scope = chosen as "global" | "project";
					}
					// If the OTHER scope keeps the name alive, deletion reveals
					// it and the session can stay on the revealed same-name
					// definition (symmetric: project→global and global→project).
					const survivesElsewhere =
						(scope === "project" && globalCatalog.has(name)) || (scope === "global" && projectCatalog.has(name));
					let replacement: string | undefined;
					if (name === plan.profile && !survivesElsewhere) {
						const survivors = entries.filter((entry) => entry.name !== name);
						const chosen = await ctx.ui.select(
							`"${name}" is active — switch to which profile?`,
							survivors.map((entry) => `${entry.name} [${entry.source}]`),
						);
						if (chosen === undefined) return;
						replacement = chosen.split(" [")[0];
					}
					await deleteProfile(scopeInput, scope, name, { activeProfile: plan.profile, replacement });
					if (name === plan.profile) {
						if (replacement !== undefined) {
							notify(`deleted "${name}" (${scope}); switching to ${replacement}`, "info");
							await switchProfile(replacement, deps, { clearOverlay: true });
						} else {
							notify(`deleted the ${scope} record of "${name}"; reloading the revealed definition`, "info");
							await switchProfile(plan.profile, deps, { reloadCurrent: true });
						}
					} else {
						notify(`deleted profile "${name}" (${scope})`, "info");
					}
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
						details: { kind: "list", profiles: entries },
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
						// Structured form for RPC consumers (ticket 11): the message
						// event carries the full report object in `details`.
						details: { kind: "status", report },
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

	// Persistent profile-scoped MCP toggles (ticket 10): edit the active
	// profile's mcp array in its owning catalog, then reload so the runtime
	// and the republished allowlist match. The adapter's own configuration
	// (mcp.json files) is never written.
	pi.registerCommand("mcp", {
		description: "pi-profile: /mcp enable <server> | /mcp disable <server>",
		handler: async (args, ctx) => {
			const notify = (message: string, level: "info" | "warning" | "error") => {
				try {
					ctx.ui?.notify(message, level);
				} catch {
					// stale context after reload — see /profile
				}
			};
			const [action, server] = args.trim().split(/\s+/).filter(Boolean);
			if (!["enable", "disable"].includes(action ?? "") || server === undefined) {
				notify("usage: /mcp enable <server> | /mcp disable <server>", "error");
				return;
			}
			try {
				const plan = await readLaunchPlanFile(runtimeDir);
				if (plan?.agentDir === undefined) {
					notify("pi-profile: launch plan is missing agentDir — cannot toggle MCP servers", "error");
					return;
				}
				if (!probeAdapterPresence(pi.events)) {
					throw new Error(
						"pi-mcp-adapter is not active in this session — /mcp enable|disable requires it " +
							"(select the adapter in the profile's extensions).",
					);
				}
				const result = await setMcpServerEnabled(
					{ realAgentDir: plan.agentDir, cwd: ctx.cwd, profile: { name: plan.profile, source: plan.source } },
					server,
					action === "enable",
				);
				if (!result.changed) {
					notify(`MCP server "${server}" is already ${action}d in profile "${plan.profile}"`, "info");
					return;
				}
				// Notify BEFORE the reload: this context is stale afterwards.
				notify(
					`${action}d MCP server "${server}" in profile "${plan.profile}" (mcp: [${result.mcp.join(", ")}]); reloading`,
					"info",
				);
				const switched = await switchProfile(plan.profile, {
					runtimeDir,
					realAgentDir: plan.agentDir,
					cwd: ctx.cwd,
					waitForIdle: () => ctx.waitForIdle(),
					reload: () => ctx.reload(),
					// Same staleness probe as /profile: interactive Pi
					// swallows reload refusals; a live context afterwards
					// means the reload never ran.
					assertStale: () => {
						void ctx.cwd;
					},
				}, { reloadCurrent: true });
				for (const warning of switched.warnings) notify(warning, "warning");
			} catch (error) {
				notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
