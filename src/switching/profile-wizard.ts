/**
 * ProfileWizard: the interactive create/edit/duplicate dialog for
 * `/profile create|edit|delete|duplicate` (ticket 09), UI-injected for
 * testability.
 *
 * Definitions are complete and self-contained — the wizard edits whole
 * fields, never inheritance or merge syntax. On edit, an empty answer
 * keeps the current value (prefill via placeholder); there is no
 * field-clearing gesture (delete + create instead). Any cancelled step
 * aborts the wizard — nothing is written.
 */

import type { ProfileDefinition } from "../profile-catalog.ts";
import type { CatalogScope } from "./profile-crud.ts";

export interface ProfileWizardUi {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
}

export interface ProfileWizardResult {
	scope: CatalogScope;
	name: string;
	definition: ProfileDefinition;
}

interface ExistingProfile {
	name: string;
	source: CatalogScope;
	definition: ProfileDefinition;
}

function parseList(raw: string): string[] {
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/** "provider/id[/thinkingLevel]" → ProfileModel; empty/undefined → none. */
function parseModel(raw: string): ProfileDefinition["model"] | undefined {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return undefined;
	const [provider, id, thinkingLevel] = trimmed.split("/").map((part) => part.trim());
	if (provider === undefined || provider.length === 0 || id === undefined || id.length === 0) {
		return undefined;
	}
	return thinkingLevel !== undefined && thinkingLevel.length > 0
		? { provider, id, thinkingLevel }
		: { provider, id };
}

async function captureDefinition(
	ui: ProfileWizardUi,
	existing?: ProfileDefinition,
): Promise<ProfileDefinition | undefined> {
	const definition: ProfileDefinition = {};

	const label = await ui.input("label (optional; empty keeps current)", existing?.label);
	if (label === undefined) return undefined;
	if (label.trim().length > 0) definition.label = label.trim();
	else if (existing?.label !== undefined) definition.label = existing.label;

	const description = await ui.input("description (optional; empty keeps current)", existing?.description);
	if (description === undefined) return undefined;
	if (description.trim().length > 0) definition.description = description.trim();
	else if (existing?.description !== undefined) definition.description = existing.description;

	const listFields = [
		["skills", "skills (comma-separated names or globs, empty = none)"],
		["extensions", "extensions (names or globs, empty = none)"],
		["mcp", "mcp servers (names or globs, empty = none)"],
		["tools", "tools (names or globs, empty = pi default set)"],
	] as const;
	for (const [field, prompt] of listFields) {
		const current = existing?.[field]?.join(", ");
		const raw = await ui.input(prompt, current);
		if (raw === undefined) return undefined;
		const parsed = parseList(raw);
		// Empty keeps the existing value on edit; on create it omits the field.
		if (parsed.length > 0) {
			definition[field] = parsed;
		} else if (current !== undefined) {
			definition[field] = existing?.[field];
		}
	}

	const instructions = await ui.input(
		"instructions (appended to the system prompt; empty keeps current)",
		existing?.instructions,
	);
	if (instructions === undefined) return undefined;
	if (instructions.trim().length > 0) definition.instructions = instructions;
	else if (existing?.instructions !== undefined) definition.instructions = existing.instructions;

	const currentModel =
		existing?.model !== undefined
			? `${existing.model.provider}/${existing.model.id}${existing.model.thinkingLevel !== undefined ? `/${existing.model.thinkingLevel}` : ""}`
			: undefined;
	const modelRaw = await ui.input("model provider/id[/thinking] (empty = none)", currentModel);
	if (modelRaw === undefined) return undefined;
	const model = parseModel(modelRaw);
	if (model !== undefined) {
		definition.model = model;
	} else if (existing?.model !== undefined && modelRaw.trim().length === 0) {
		definition.model = existing.model;
	}

	return definition;
}

/** Create: scope first (project only when trusted), then name, then fields. */
export async function runProfileCreateWizard(
	ui: ProfileWizardUi,
	input: { projectTrusted: boolean },
): Promise<ProfileWizardResult | undefined> {
	const scopeOptions = input.projectTrusted ? ["global", "project"] : ["global"];
	// A single available scope needs no dialog.
	const scope = scopeOptions.length === 1 ? scopeOptions[0] : await ui.select("write to which catalog?", scopeOptions);
	if (scope === undefined) return undefined;

	const name = await ui.input("profile name");
	if (name === undefined || name.trim().length === 0) return undefined;

	const definition = await captureDefinition(ui);
	if (definition === undefined) return undefined;

	return { scope: scope as CatalogScope, name: name.trim(), definition };
}

/** Edit: fields prefilled from the existing complete definition. */
export async function runProfileEditWizard(
	ui: ProfileWizardUi,
	input: { existing: ExistingProfile },
): Promise<ProfileWizardResult | undefined> {
	const definition = await captureDefinition(ui, input.existing.definition);
	if (definition === undefined) return undefined;
	return { scope: input.existing.source, name: input.existing.name, definition };
}

/** Duplicate: pick a source, name the copy — the only variant mechanism. */
export async function runProfileDuplicateWizard(
	ui: ProfileWizardUi,
	input: { candidates: ExistingProfile[] },
): Promise<{ scope: CatalogScope; sourceName: string; newName: string } | undefined> {
	if (input.candidates.length === 0) return undefined;
	const options = input.candidates.map(
		(candidate) => `${candidate.name} [${candidate.source}]${candidate.definition.label !== undefined ? ` — ${candidate.definition.label}` : ""}`,
	);
	const chosen = await ui.select("duplicate which profile?", options);
	if (chosen === undefined) return undefined;
	const source = input.candidates.find((candidate) => chosen.startsWith(`${candidate.name} [`));
	if (source === undefined) return undefined;

	const newName = await ui.input("new profile name");
	if (newName === undefined || newName.trim().length === 0) return undefined;

	return { scope: source.source, sourceName: source.name, newName: newName.trim() };
}
