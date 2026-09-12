/**
 * ResourceWizard: the interactive create/edit dialog for `/profile
 * resource` (ticket 08), UI-injected for testability.
 *
 * Captures logical ID, entry path, `dependsOn`, and `alwaysOn`. Scope
 * (global vs project registry) is chosen first; the project scope is
 * offered only when trusted. Any cancelled step aborts the whole wizard —
 * nothing is written.
 */

import type { RegistryEntryInput } from "../resource-registry-store.ts";
import type { RegistryListEntry, RegistryScope } from "./resource-crud.ts";

export interface WizardUi {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
}

export interface WizardResult {
	scope: RegistryScope;
	entry: RegistryEntryInput;
}

function parseDependsOn(raw: string): string[] {
	return raw
		.split(",")
		.map((dep) => dep.trim())
		.filter((dep) => dep.length > 0);
}

/**
 * Runs the create/edit wizard. `existing` (edit mode) prefills every step;
 * the ID is fixed on edit (rename = delete + create).
 */
export async function runResourceWizard(
	ui: WizardUi,
	input: { projectTrusted: boolean; existing?: RegistryListEntry },
): Promise<WizardResult | undefined> {
	let scope: RegistryScope;
	if (input.existing !== undefined) {
		scope = input.existing.source;
	} else {
		const scopeOptions = input.projectTrusted ? ["global", "project"] : ["global"];
		const chosen = await ui.select("registry scope", scopeOptions);
		if (chosen === undefined) return undefined;
		scope = chosen as RegistryScope;
	}

	let id: string;
	if (input.existing !== undefined) {
		id = input.existing.id;
	} else {
		const entered = await ui.input("logical resource id");
		if (entered === undefined || entered.trim().length === 0) return undefined;
		id = entered.trim();
	}

	const entry = await ui.input("extension entry path (absolute)", input.existing?.entry);
	if (entry === undefined || entry.trim().length === 0) return undefined;

	const dependsRaw = await ui.input(
		"dependsOn (comma-separated resource ids, empty = none)",
		input.existing?.dependsOn.join(", "),
	);
	if (dependsRaw === undefined) return undefined;

	const alwaysOn = await ui.confirm(
		"alwaysOn?",
		`load "${id}" in every profile${input.existing !== undefined ? ` (current: ${input.existing.alwaysOn ? "yes" : "no"})` : ""}`,
	);

	return {
		scope,
		entry: {
			id,
			entry: entry.trim(),
			...(parseDependsOn(dependsRaw).length > 0 ? { dependsOn: parseDependsOn(dependsRaw) } : {}),
			alwaysOn,
		},
	};
}
