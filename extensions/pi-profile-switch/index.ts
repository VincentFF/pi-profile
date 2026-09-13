import {
	getAgentDir,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { discoverAdapterServerNames } from "../../src/mcp-config.ts";
import { probeAdapterPresence } from "../../src/mcp-coordination.ts";
import { readSessionChoices } from "../../src/model-selection.ts";
import { buildProfileBadge, PROFILE_STATUS_KEY, renderProfileBadge } from "../../src/profile-badge.ts";
import type { ProfileDefinition } from "../../src/profile-catalog.ts";
import {
	formatSelectionWarnings,
	type LiveResources,
	type ResolvedSelection,
} from "../../src/profile-resolver.ts";
import { RuntimeStateStore, overlayNarrows, stateDirFor, type RuntimeOverlay } from "../../src/runtime-state-store.ts";
import {
	applySkillsFilter,
	formatInstructionsBlock,
	type SkillsFilterOutcome,
} from "../../src/skill-selection.ts";
import {
	detectExplicitDeclarations,
	readProfileFlag,
	registerProfileFlag,
	resolveStartupProfile,
} from "../../src/startup-selection.ts";
import { retryPendingTools, type ApplySurface } from "../../src/switching/apply-profile.ts";
import {
	activateProfile,
	type ActivationDeps,
	type ActivationResult,
} from "../../src/switching/activate-profile.ts";
import { CUSTOMIZE_USAGE, customizeOverlay, parseCustomizeArgs, resetOverlay } from "../../src/switching/customize.ts";
import { formatProfileList, listProfiles, type ProfileListEntry } from "../../src/switching/list-profiles.ts";
import { setMcpServerEnabled } from "../../src/switching/mcp-toggle.ts";
import {
	createProfile,
	deleteProfile,
	duplicateProfile,
	editProfile,
	readCatalogScope,
	type CatalogInput,
} from "../../src/switching/profile-crud.ts";
import {
	runProfileCreateWizard,
	runProfileDuplicateWizard,
	runProfileEditWizard,
} from "../../src/switching/profile-wizard.ts";
import { buildStatusReport, formatStatusMarkdown } from "../../src/switching/status.ts";

/**
 * pi-profile-switch extension entry (ADR-0007).
 *
 * Installed like any other Pi package: no launcher, no environment override,
 * no generated settings. The agent dir stays Pi's own, so sessions,
 * extension configuration, packages, project trust, and context files are
 * all native.
 *
 * Responsibilities:
 * - `session_start`: resolve the startup profile (`--profile <flag>`, else
 *   the saved selection, else `default`), then apply the runtime parts of
 *   the selection — model preset, active tools, MCP allowlist. A failed
 *   activation applies nothing and reports loudly.
 * - `before_agent_start`: rebuild the system prompt each turn — replace the
 *   skills section with the profile's visible set and append the profile's
 *   instructions. Unselected skills stay loaded and `/skill:`-invocable.
 * - `/profile …` command family and `/mcp enable|disable`.
 * - Retry pending tool literals each turn until MCP/extension tools register.
 * - Footer badge: `profile: <name>` (plus `*` for a runtime overlay) in Pi's
 *   footer status line while a non-`default` profile is active.
 */

type ContextWithOptions = ExtensionContext & { getSystemPromptOptions?: () => BuildSystemPromptOptions };

/** The active profile in this runtime and the last prompt-filter result. */
interface Activation {
	selection: ResolvedSelection;
	skillsOutcome?: SkillsFilterOutcome;
	/** The overlay this runtime was activated with, when one is in effect. */
	overlay?: RuntimeOverlay;
}

/** Maps an activation result onto the runtime state `current` mirrors. */
function activationOf(result: ActivationResult): Activation {
	return { selection: result.selection, ...(result.overlay === undefined ? {} : { overlay: result.overlay }) };
}

/** Subcommands that mutate a catalog; they need dialog-capable UI. */
const CRUD_SUBCOMMANDS = ["create", "duplicate", "edit", "delete"] as const;
const SUBCOMMANDS = ["use", "list", "status", "customize", "reset", ...CRUD_SUBCOMMANDS] as const;
const REQUIRED_ARGUMENT: Readonly<Record<string, string>> = { use: "<name>", edit: "<name>", delete: "<name>" };
const PROFILE_USAGE = [
	"/profile [picker]",
	"/profile use <name>",
	"/profile list | /profile status",
	CUSTOMIZE_USAGE,
	"/profile reset",
	"/profile create | /profile duplicate",
	"/profile edit <name> | /profile delete <name>",
].join(" · ");

export default function piProfileExtension(pi: ExtensionAPI): void {
	registerProfileFlag(pi);
	const explicit = detectExplicitDeclarations(process.argv.slice(2));
	let current: Activation | undefined;
	let filterWarningShown = false;
	/** The last badge written to the footer, so a refresh only talks to Pi
	 *  when the rendering actually changed. */
	let badgeText: string | undefined;

	/** The only writer of `current`'s profile identity (`selection.name` and
	 *  `overlay`) and of the footer badge. Both mirror the selection this
	 *  runtime applied, so a failed activation (which throws before reaching
	 *  here) never claims to be active. The per-turn updates (`pendingTools`,
	 *  `skillsOutcome`) leave the identity and the badge untouched. */
	function setCurrent(ctx: ExtensionContext, next: Activation | undefined): void {
		current = next;
		refreshBadge(ctx);
	}

	/** Re-renders the badge from `current`. `default` and an unapplied profile
	 *  render no badge, which removes Pi's footer status line entirely. */
	function refreshBadge(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const badge =
			current === undefined
				? undefined
				: buildProfileBadge(current.selection.name, { overlay: overlayNarrows(current.overlay) });
		const text = badge === undefined ? undefined : renderProfileBadge(badge, ctx.ui.theme);
		if (text === badgeText) return;
		badgeText = text;
		ctx.ui.setStatus(PROFILE_STATUS_KEY, text);
	}

	const surface = (ctx: ExtensionContext): ApplySurface => ({
		getAllTools: () => pi.getAllTools(),
		setActiveTools: (names) => pi.setActiveTools(names),
		modelRegistry: ctx.modelRegistry,
		// The package does not export Pi's ThinkingLevel type, so the surface
		// takes the API's own parameter types at the wiring boundary.
		setModel: (model) => pi.setModel(model as Parameters<ExtensionAPI["setModel"]>[0]),
		setThinkingLevel: (level) =>
			pi.setThinkingLevel(level as Parameters<ExtensionAPI["setThinkingLevel"]>[0]),
		events: pi.events,
	});

	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
		ctx.ui.notify(message, level);
	}

	function reportWarnings(ctx: ExtensionContext, warnings: string[]): void {
		for (const warning of warnings) notify(ctx, warning, "warning");
	}

	async function loadLive(ctx: ExtensionContext, projectTrusted: boolean): Promise<LiveResources> {
		const options = (ctx as ContextWithOptions).getSystemPromptOptions?.();
		const skills = (options?.skills ?? []).map((skill) => ({ name: skill.name, filePath: skill.filePath }));
		const adapterPresent = probeAdapterPresence(pi.events);
		let servers: string[] = [];
		if (adapterPresent) {
			try {
				servers = await discoverAdapterServerNames(getAgentDir(), projectTrusted ? ctx.cwd : undefined);
			} catch (error) {
				notify(ctx, error instanceof Error ? error.message : String(error), "warning");
			}
		}
		return { skills, toolNames: pi.getAllTools().map((tool) => tool.name), mcp: { adapterPresent, servers } };
	}

	/** Builds the dependencies for one activation. `force` marks an explicit
	 *  user choice (`/profile use`, picker, CRUD reactivation): the profile's
	 *  model and tool declarations then outrank the session state and the
	 *  CLI flags. */
	async function activationDeps(ctx: ExtensionContext, force: boolean): Promise<ActivationDeps> {
		const projectTrusted = ctx.isProjectTrusted();
		return {
			agentDir: getAgentDir(),
			cwd: ctx.cwd,
			projectTrusted,
			live: await loadLive(ctx, projectTrusted),
			surface: surface(ctx),
			presetInputs: { explicit, session: readSessionChoices(ctx.sessionManager.getEntries()), force },
		};
	}

	/** Resolves, validates, persists and applies one profile, then records it
	 *  as the active selection and reports its warnings. */
	async function activate(
		ctx: ExtensionContext,
		name: string,
		options?: { force?: boolean; overlay?: RuntimeOverlay | null; persist?: boolean },
	): Promise<ActivationResult> {
		const deps = await activationDeps(ctx, options?.force ?? false);
		const result = await activateProfile(name, deps, {
			overlay: options?.overlay ?? null,
			persist: options?.persist ?? true,
		});
		setCurrent(ctx, activationOf(result));
		reportWarnings(ctx, formatSelectionWarnings(result.selection));
		return result;
	}

	async function profileEntries(ctx: ExtensionContext): Promise<ProfileListEntry[]> {
		return listProfiles({
			realAgentDir: getAgentDir(),
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
		});
	}

	function sendListMessage(entries: ProfileListEntry[]): void {
		pi.sendMessage({
			customType: "pi-profile-switch",
			content: formatProfileList(entries, current?.selection.name),
			display: true,
			details: { kind: "list", profiles: entries },
		});
	}

	/** Bare `/profile`: the interactive picker, with a list fallback for
	 *  modes without dialogs. */
	async function runPicker(ctx: ExtensionCommandContext, entries: ProfileListEntry[]): Promise<void> {
		if (!ctx.hasUI) {
			sendListMessage(entries);
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
		const chosen = entries.find((entry) => choice.startsWith(`${entry.name} [`));
		if (chosen === undefined || chosen.name === current?.selection.name) return;
		const result = await activate(ctx, chosen.name, { force: true, overlay: null, persist: true });
		notify(ctx, `profile active: ${result.selection.name}`, "info");
	}

	/** `/profile create|duplicate|edit|delete`: TUI-only catalog CRUD. */
	async function runCatalogCrud(
		ctx: ExtensionCommandContext,
		subcommand: string,
		rest: string[],
		scopeInput: CatalogInput,
	): Promise<void> {
		if (subcommand === "create") {
			const wizard = await runProfileCreateWizard(ctx.ui, { projectTrusted: scopeInput.projectTrusted });
			if (wizard === undefined) return;
			await createProfile(scopeInput, wizard.scope, wizard.name, wizard.definition);
			notify(ctx, `created profile "${wizard.name}" (${wizard.scope}) — activate with /profile use ${wizard.name}`, "info");
			return;
		}
		if (subcommand === "duplicate") {
			const entries = await profileEntries(ctx);
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
			notify(ctx, `duplicated "${wizard.sourceName}" → "${wizard.newName}" (${wizard.scope})`, "info");
			return;
		}

		const name = rest[0] as string;
		const entries = await profileEntries(ctx);
		const existing = entries.find((entry) => entry.name === name);
		if (existing === undefined || existing.source === "builtin") {
			notify(ctx, `profile "${name}" not found in a writable catalog`, "error");
			return;
		}
		if (subcommand === "edit") {
			const definition = (await readCatalogScope(scopeInput, existing.source)).get(name);
			if (definition === undefined) {
				notify(ctx, `profile "${name}" not found in the ${existing.source} catalog`, "error");
				return;
			}
			const wizard = await runProfileEditWizard(ctx.ui, {
				existing: { name, source: existing.source, definition },
			});
			if (wizard === undefined) return;
			await editProfile(scopeInput, wizard.scope, wizard.name, wizard.definition);
			if (current !== undefined && name === current.selection.name) {
				await activate(ctx, name, { persist: true });
				notify(ctx, `saved and reactivated profile "${name}"`, "info");
			} else {
				notify(ctx, `saved profile "${name}" (inactive — runtime untouched)`, "info");
			}
			return;
		}

		// delete: choose the scope when both catalogs hold the name, and the
		// replacement when the active profile disappears for good.
		let scope = existing.source as "global" | "project";
		const projectCatalog = await readCatalogScope(scopeInput, "project");
		const globalCatalog = await readCatalogScope(scopeInput, "global");
		if (projectCatalog.has(name) && globalCatalog.has(name)) {
			const chosen = await ctx.ui.select(`delete "${name}" from which catalog?`, ["global", "project"]);
			if (chosen === undefined) return;
			scope = chosen as "global" | "project";
		}
		const survivesElsewhere =
			(scope === "project" && globalCatalog.has(name)) || (scope === "global" && projectCatalog.has(name));
		const isActive = current !== undefined && name === current.selection.name;
		let replacement: string | undefined;
		if (isActive && !survivesElsewhere) {
			const survivors = entries.filter((entry) => entry.name !== name);
			const chosen = await ctx.ui.select(
				`"${name}" is active — switch to which profile?`,
				survivors.map((entry) => `${entry.name} [${entry.source}]`),
			);
			if (chosen === undefined) return;
			replacement = survivors.find((entry) => chosen.startsWith(`${entry.name} [`))?.name;
			if (replacement === undefined) return;
		}
		await deleteProfile(scopeInput, scope, name, {
			...(isActive ? { activeProfile: name } : {}),
			...(replacement !== undefined ? { replacement } : {}),
		});
		if (isActive) {
			const result = await activate(ctx, replacement ?? name, { force: replacement !== undefined, persist: true });
			notify(ctx, `deleted "${name}" (${scope}); profile active: ${result.selection.name}`, "info");
		} else {
			notify(ctx, `deleted profile "${name}" (${scope})`, "info");
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		setCurrent(ctx, undefined);
		filterWarningShown = false;
		const agentDir = getAgentDir();
		const projectTrusted = ctx.isProjectTrusted();
		const requested = readProfileFlag(pi);
		let startup;
		try {
			startup = await resolveStartupProfile({
				agentDir,
				cwd: ctx.cwd,
				projectTrusted,
				...(requested !== undefined ? { requested } : {}),
			});
		} catch (error) {
			notify(ctx, error instanceof Error ? error.message : String(error), "error");
			return;
		}
		try {
			// Startup activation never persists (a `--profile` selection is for
			// this run only) and never applies a stored overlay.
			await activate(ctx, startup.name, { persist: false, overlay: null });
			reportWarnings(ctx, startup.warnings);
		} catch (error) {
			notify(ctx, error instanceof Error ? error.message : String(error), "error");
			reportWarnings(ctx, startup.warnings);
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (current === undefined) return;
		// Retry tool literals that were not registered at activation time;
		// once all of them resolve, retrying stops so a native manual toggle
		// is never clobbered.
		const retry = retryPendingTools({ selection: current.selection, surface: surface(ctx) });
		if (retry.applied) {
			current = {
				...current,
				selection: {
					...current.selection,
					pendingTools: retry.pendingTools,
					...(retry.active !== undefined ? { tools: retry.active } : {}),
				},
			};
		}
		// Pi has no extension-visible theme-change event and footer statuses are
		// stored as finished strings, so re-render once per turn: a `/theme`
		// switch is picked up without waiting for the next profile change.
		// `refreshBadge` dedupes, so an unchanged badge sends nothing.
		refreshBadge(ctx);
		const filtered = applySkillsFilter({
			systemPrompt: event.systemPrompt,
			options: event.systemPromptOptions,
			filter: current.selection.skills,
		});
		if (
			current.selection.skills !== undefined &&
			(filtered.outcome === "section-missing" || filtered.outcome === "no-read-tool") &&
			!filterWarningShown
		) {
			filterWarningShown = true;
			const cause =
				filtered.outcome === "no-read-tool"
					? "neither the read nor the bash tool is active"
					: "the system prompt carries no skills section";
			notify(
				ctx,
				`pi-profile-switch: ${cause} — profile "${current.selection.name}" skills are not narrowed this session`,
				"warning",
			);
		}
		current = { ...current, skillsOutcome: filtered.outcome };
		let systemPrompt = filtered.systemPrompt;
		if (current.selection.instructions !== undefined) {
			systemPrompt += formatInstructionsBlock(current.selection.name, current.selection.instructions);
		}
		if (systemPrompt === event.systemPrompt) return;
		return { systemPrompt };
	});

	pi.registerCommand("profile", {
		description: `pi-profile-switch: ${PROFILE_USAGE}`,
		handler: async (args, ctx) => {
			const [subcommandRaw, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = subcommandRaw ?? "";
			if (subcommand !== "" && !(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
				notify(ctx, PROFILE_USAGE, "error");
				return;
			}
			const required = REQUIRED_ARGUMENT[subcommand];
			if (required !== undefined && rest[0] === undefined) {
				notify(ctx, `usage: /profile ${subcommand} ${required}`, "error");
				return;
			}
			if ((CRUD_SUBCOMMANDS as readonly string[]).includes(subcommand) && ctx.mode !== "tui") {
				notify(ctx, `/profile ${subcommand} requires TUI mode (current mode: ${ctx.mode})`, "error");
				return;
			}
			try {
				switch (subcommand) {
					case "": {
						await runPicker(ctx, await profileEntries(ctx));
						return;
					}
					case "use": {
						const result = await activate(ctx, rest[0] as string, { force: true, overlay: null, persist: true });
						notify(ctx, `profile active: ${result.selection.name}`, "info");
						return;
					}
					case "customize": {
						if (current === undefined) {
							notify(ctx, "no active profile — nothing to customize", "error");
							return;
						}
						const deps = await activationDeps(ctx, false);
						const target = { profile: { name: current.selection.name, source: current.selection.source } };
						const result = await customizeOverlay({ ...deps, ...target }, parseCustomizeArgs(rest.join(" ")));
						setCurrent(ctx, activationOf(result));
						notify(ctx, `overlay updated: ${result.selection.name}`, "info");
						return;
					}
					case "reset": {
						if (current === undefined) {
							notify(ctx, "no active profile — nothing to reset", "error");
							return;
						}
						const deps = await activationDeps(ctx, false);
						const target = { profile: { name: current.selection.name, source: current.selection.source } };
						const result = await resetOverlay({ ...deps, ...target });
						setCurrent(ctx, activationOf(result));
						notify(ctx, `overlay cleared: ${result.selection.name}`, "info");
						return;
					}
					case "list": {
						sendListMessage(await profileEntries(ctx));
						return;
					}
					case "status": {
						await sendStatus(pi, ctx, current);
						return;
					}
					default: {
						await runCatalogCrud(ctx, subcommand, rest, {
							realAgentDir: getAgentDir(),
							cwd: ctx.cwd,
							projectTrusted: ctx.isProjectTrusted(),
						});
					}
				}
			} catch (error) {
				notify(ctx, error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("mcp", {
		description: "pi-profile-switch: /mcp enable <server> | /mcp disable <server>",
		handler: async (args, ctx) => {
			const [action, server] = args.trim().split(/\s+/).filter(Boolean);
			if (!["enable", "disable"].includes(action ?? "") || server === undefined) {
				notify(ctx, "usage: /mcp enable <server> | /mcp disable <server>", "error");
				return;
			}
			if (current === undefined) {
				notify(ctx, "no active profile — /mcp enable|disable edits the active profile's catalog entry", "error");
				return;
			}
			try {
				if (!probeAdapterPresence(pi.events)) {
					throw new Error("pi-mcp-adapter is not active in this session — /mcp enable|disable requires it");
				}
				const agentDir = getAgentDir();
				const projectTrusted = ctx.isProjectTrusted();
				const profile = { name: current.selection.name, source: current.selection.source };
				const result = await setMcpServerEnabled(
					{ realAgentDir: agentDir, cwd: ctx.cwd, projectTrusted, profile },
					server,
					action === "enable",
				);
				if (!result.changed) {
					notify(ctx, `MCP server "${server}" is already ${action}d in profile "${profile.name}"`, "info");
					return;
				}
				// Re-activate so the runtime allowlist matches the edited
				// catalog; the stored overlay is preserved.
				const overlay = (await new RuntimeStateStore(stateDirFor(profile.source, { agentDir, cwd: ctx.cwd })).read())
					.overlay;
				await activate(ctx, profile.name, { overlay: overlay ?? null, persist: true });
				notify(
					ctx,
					`${action}d MCP server "${server}" in profile "${profile.name}" (mcp: [${result.mcp.join(", ")}])`,
					"info",
				);
			} catch (error) {
				notify(ctx, error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

/** `/profile status`: the active selection against the live view. */
async function sendStatus(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	current: Activation | undefined,
): Promise<void> {
	if (current === undefined) {
		pi.sendMessage({
			customType: "pi-profile-switch",
			content: "no active profile (activation failed or nothing was resolved — a plain Pi session)",
			display: true,
			details: { kind: "status", report: undefined },
		});
		return;
	}
	const options = ctx.getSystemPromptOptions();
	const allSkills = (options.skills ?? []).map((skill) => ({ name: skill.name, filePath: skill.filePath }));
	let discovered: string[] = [];
	try {
		discovered = await discoverAdapterServerNames(getAgentDir(), ctx.isProjectTrusted() ? ctx.cwd : undefined);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
	}
	const overlay = (
		await new RuntimeStateStore(
			stateDirFor(current.selection.source, { agentDir: getAgentDir(), cwd: ctx.cwd }),
		).read()
	).overlay;
	const report = {
		...buildStatusReport({
			selection: current.selection,
			allSkills,
			discoveredMcpServers: discovered,
			...(current.skillsOutcome !== undefined ? { filterOutcome: current.skillsOutcome } : {}),
		}),
		...(overlay !== undefined ? { overlay } : {}),
	};
	pi.sendMessage({
		customType: "pi-profile-switch",
		content: formatStatusMarkdown(report),
		display: true,
		details: { kind: "status", report },
	});
}
