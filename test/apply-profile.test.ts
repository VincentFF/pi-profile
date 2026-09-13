import { describe, expect, it } from "vitest";

import type { PresetDecisions } from "../src/model-selection.ts";
import { applySelection, retryPendingTools, validateSelection } from "../src/switching/apply-profile.ts";
import { fakeApplySurface, selection } from "./helpers/fake-apply.ts";

const bothPreset: PresetDecisions = { model: true, thinking: true };

describe("validateSelection", () => {
	it("passes when the profile declares no model", () => {
		const { surface } = fakeApplySurface();
		expect(validateSelection(selection(), surface, bothPreset)).toBeUndefined();
	});

	it("reports an unknown model", () => {
		const { surface } = fakeApplySurface({ findModel: false });
		expect(
			validateSelection(selection({ model: { provider: "openai", id: "ghost" } }), surface, bothPreset),
		).toMatch(/declared model openai\/ghost not found/);
	});

	it("reports a model without configured auth", () => {
		const { surface } = fakeApplySurface({ hasAuth: false });
		expect(
			validateSelection(selection({ model: { provider: "openai", id: "gpt" } }), surface, bothPreset),
		).toMatch(/has no configured auth/);
	});

	it("skips model validation when the preset does not apply", () => {
		const { surface } = fakeApplySurface({ findModel: false });
		expect(
			validateSelection(selection({ model: { provider: "openai", id: "ghost" } }), surface, {
				model: false,
				thinking: false,
			}),
		).toBeUndefined();
	});
});

describe("applySelection", () => {
	it("applies model, thinking, tools, then the MCP allowlist", async () => {
		const { surface, calls } = fakeApplySurface();
		const result = await applySelection({
			selection: selection({
				model: { provider: "openai", id: "gpt", thinkingLevel: "high" },
				tools: ["read"],
				mcp: ["atlassian"],
			}),
			surface,
			preset: bothPreset,
		});

		expect(result.applied).toBe(true);
		expect(calls.models).toEqual([{ provider: "openai", id: "gpt" }]);
		expect(calls.thinking).toEqual(["high"]);
		expect(calls.activeTools).toEqual([["read"]]);
		expect(calls.emitted).toEqual([
			{
				channel: "pi-profile:mcp-allowlist:v1",
				data: { version: 1, profile: "review", servers: ["atlassian"] },
			},
		]);
	});

	it("applies nothing when validation fails", async () => {
		const { surface, calls } = fakeApplySurface({ hasAuth: false });
		const result = await applySelection({
			selection: selection({ model: { provider: "openai", id: "gpt" }, tools: ["read"] }),
			surface,
			preset: bothPreset,
		});

		expect(result.applied).toBe(false);
		expect(result.error).toMatch(/no configured auth/);
		expect(calls.models).toEqual([]);
		expect(calls.activeTools).toEqual([]);
	});

	it("applies nothing else when setModel fails", async () => {
		const { surface, calls } = fakeApplySurface({ setModelOk: false });
		const result = await applySelection({
			selection: selection({ model: { provider: "openai", id: "gpt" }, tools: ["read"], mcp: ["atlassian"] }),
			surface,
			preset: bothPreset,
		});

		expect(result.applied).toBe(false);
		expect(calls.activeTools).toEqual([]);
		expect(calls.emitted).toEqual([]);
	});

	it("applies tools and MCP even when the model preset is suppressed", async () => {
		const { surface, calls } = fakeApplySurface();
		const result = await applySelection({
			selection: selection({ model: { provider: "openai", id: "gpt" }, tools: ["read"], mcp: ["atlassian"] }),
			surface,
			preset: { model: false, thinking: false },
		});

		expect(result.applied).toBe(true);
		expect(calls.models).toEqual([]);
		expect(calls.activeTools).toEqual([["read"]]);
		expect(calls.emitted).toHaveLength(1);
	});
});

describe("retryPendingTools", () => {
	it("does nothing without pending tools", () => {
		const { surface, calls } = fakeApplySurface();
		expect(retryPendingTools({ selection: selection(), surface })).toEqual({ pendingTools: [], applied: false });
		expect(calls.activeTools).toEqual([]);
	});

	it("does nothing while no literal resolves", () => {
		const { surface, calls } = fakeApplySurface({ toolNames: ["read"] });
		const result = retryPendingTools({
			selection: selection({ tools: ["read", "mcp_tool"], pendingTools: ["mcp_tool"] }),
			surface,
		});

		expect(result).toEqual({ pendingTools: ["mcp_tool"], applied: false });
		expect(calls.activeTools).toEqual([]);
	});

	it("activates newly registered tools and clears resolved pending entries", () => {
		const { surface, calls } = fakeApplySurface({ toolNames: ["read", "mcp_tool"] });
		const result = retryPendingTools({
			selection: selection({ tools: ["read", "mcp_tool", "other"], pendingTools: ["mcp_tool", "other"] }),
			surface,
		});

		expect(result.pendingTools).toEqual(["other"]);
		expect(result.active).toEqual(["read", "mcp_tool", "other"]);
		expect(calls.activeTools).toEqual([["read", "mcp_tool", "other"]]);
	});
});
