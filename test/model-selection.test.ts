import { describe, expect, it } from "vitest";

import { decidePreset, readSessionChoices } from "../src/model-selection.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const preset = { provider: "openai", id: "gpt-5.4", thinkingLevel: "high" };
const noExplicit = { model: false, thinking: false, tools: false };
const noSession = { hasRecordedModel: false, hasRecordedThinking: false };

describe("readSessionChoices", () => {
	it("reports no recorded choice for a fresh session", () => {
		expect(readSessionChoices([])).toEqual({ hasRecordedModel: false, hasRecordedThinking: false });
	});

	it("sees recorded model and thinking changes", () => {
		const entries = [
			{ type: "model_change", provider: "openai", modelId: "x" },
			{ type: "thinking_level_change", thinkingLevel: "low" },
		] as unknown as SessionEntry[];

		expect(readSessionChoices(entries)).toEqual({ hasRecordedModel: true, hasRecordedThinking: true });
	});
});

describe("decidePreset", () => {
	it("applies nothing when the profile declares no model", () => {
		expect(decidePreset({ model: undefined, explicit: noExplicit, session: noSession, force: true })).toEqual({
			model: false,
			thinking: false,
		});
	});

	it("applies the preset when nothing else states a choice", () => {
		expect(decidePreset({ model: preset, explicit: noExplicit, session: noSession, force: false })).toEqual({
			model: true,
			thinking: true,
		});
	});

	it("yields to an explicit --model flag", () => {
		expect(
			decidePreset({
				model: preset,
				explicit: { ...noExplicit, model: true },
				session: noSession,
				force: false,
			}),
		).toEqual({ model: false, thinking: true });
	});

	it("yields to an explicit --thinking flag", () => {
		expect(
			decidePreset({
				model: preset,
				explicit: { ...noExplicit, thinking: true },
				session: noSession,
				force: false,
			}),
		).toEqual({ model: true, thinking: false });
	});

	it("yields to a model recorded in the session history (resume)", () => {
		expect(
			decidePreset({
				model: preset,
				explicit: noExplicit,
				session: { hasRecordedModel: true, hasRecordedThinking: true },
				force: false,
			}),
		).toEqual({ model: false, thinking: false });
	});

	it("applies over both when the user explicitly switches profile", () => {
		expect(
			decidePreset({
				model: preset,
				explicit: { model: true, thinking: true, tools: true },
				session: { hasRecordedModel: true, hasRecordedThinking: true },
				force: true,
			}),
		).toEqual({ model: true, thinking: true });
	});
});
