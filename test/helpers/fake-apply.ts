import type { LiveResources, ResolvedSelection } from "../../src/profile-resolver.ts";
import type { ApplySurface } from "../../src/switching/apply-profile.ts";

/** A fake ApplySurface recording every call; unit tests never need a real Pi. */
export interface FakeApplyOptions {
	toolNames?: string[];
	findModel?: boolean;
	hasAuth?: boolean;
	setModelOk?: boolean;
}

export interface FakeApplyCalls {
	activeTools: string[][];
	models: unknown[];
	thinking: string[];
	emitted: Array<{ channel: string; data: unknown }>;
}

export function fakeApplySurface(options: FakeApplyOptions = {}): {
	surface: ApplySurface;
	calls: FakeApplyCalls;
} {
	const calls: FakeApplyCalls = {
		activeTools: [],
		models: [],
		thinking: [],
		emitted: [],
	};
	const surface: ApplySurface = {
		getAllTools: () => (options.toolNames ?? ["read", "grep"]).map((name) => ({ name })),
		setActiveTools: (names) => {
			calls.activeTools.push(names);
		},
		modelRegistry: {
			find: (provider, id) => (options.findModel === false ? undefined : { provider, id }),
			hasConfiguredAuth: () => options.hasAuth !== false,
		},
		setModel: async (model) => {
			calls.models.push(model);
			return options.setModelOk !== false;
		},
		setThinkingLevel: (level) => {
			calls.thinking.push(level);
		},
		events: {
			emit: (channel, data) => {
				calls.emitted.push({ channel, data });
			},
		},
	};
	return { surface, calls };
}

export function selection(overrides: Partial<ResolvedSelection> = {}): ResolvedSelection {
	return {
		name: "review",
		source: "global",
		pendingTools: [],
		warnings: { skillsUnresolved: [], skillsUnmatched: [], mcpUnmatched: [], toolsUnmatched: [] },
		...overrides,
	};
}

export function liveResources(overrides: Partial<LiveResources> = {}): LiveResources {
	return {
		skills: [
			{ name: "git-commit", filePath: "/skills/git-commit/SKILL.md" },
			{ name: "code-review", filePath: "/skills/code-review/SKILL.md" },
		],
		toolNames: ["read", "bash", "grep"],
		mcp: { adapterPresent: true, servers: ["atlassian", "github"] },
		...overrides,
	};
}
