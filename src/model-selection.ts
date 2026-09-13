/**
 * ModelSelection: when a profile's model preset may take effect.
 *
 * The profile model is a PRESET, not an override. Pi's own explicit choices
 * win:
 *
 * 1. `--model` / `--thinking` on the command line.
 * 2. A model or thinking level recorded in the session history (a resumed
 *    session restores the user's last choice).
 * 3. The profile's declaration.
 * 4. Pi's settings defaults.
 *
 * `/profile use` is the user choosing a profile deliberately, so it applies
 * the preset over 1 and 2.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { ProfileModel } from "./profile-catalog.ts";
import type { ExplicitDeclarations } from "./startup-selection.ts";

export interface SessionChoices {
	hasRecordedModel: boolean;
	hasRecordedThinking: boolean;
}

/** Reads whether the session history already states a model or thinking
 *  level. Process startup is always `reason: "startup"`, so the recorded
 *  entries — not the event reason — are what distinguishes a resumed
 *  session from a fresh one. */
export function readSessionChoices(entries: SessionEntry[]): SessionChoices {
	let hasRecordedModel = false;
	let hasRecordedThinking = false;
	for (const entry of entries) {
		if (entry.type === "model_change") hasRecordedModel = true;
		if (entry.type === "thinking_level_change") hasRecordedThinking = true;
	}
	return { hasRecordedModel, hasRecordedThinking };
}

export interface PresetDecisions {
	model: boolean;
	thinking: boolean;
}

/** Decides which halves of the preset may be applied. */
export function decidePreset(input: {
	model: ProfileModel | undefined;
	explicit: ExplicitDeclarations;
	session: SessionChoices;
	/** True for an explicit `/profile use` (overrides 1 and 2). */
	force: boolean;
}): PresetDecisions {
	if (input.model === undefined) {
		return { model: false, thinking: false };
	}
	if (input.force) {
		return { model: true, thinking: true };
	}
	return {
		model: !input.explicit.model && !input.session.hasRecordedModel,
		thinking: !input.explicit.thinking && !input.session.hasRecordedThinking,
	};
}
