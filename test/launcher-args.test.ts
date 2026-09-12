import { describe, expect, it } from "vitest";

import { LauncherArgError, parseLauncherArgs } from "../src/launcher/args.ts";

describe("parseLauncherArgs", () => {
	it("defaults to the default profile in interactive mode with no args", () => {
		expect(parseLauncherArgs([])).toEqual({ profile: undefined, mode: "interactive", model: undefined });
	});

	it("takes an optional positional profile name", () => {
		expect(parseLauncherArgs(["review"]).profile).toBe("review");
	});

	it("rejects more than one positional argument", () => {
		expect(() => parseLauncherArgs(["review", "implement"])).toThrow(LauncherArgError);
	});

	it("rejects launcher flags before the -- separator", () => {
		expect(() => parseLauncherArgs(["--mode", "rpc"])).toThrow(/after `--`/);
	});

	it("parses --mode from the passthrough segment (space form)", () => {
		expect(parseLauncherArgs(["review", "--", "--mode", "rpc"]).mode).toBe("rpc");
	});

	it("parses --mode=value (equals form)", () => {
		expect(parseLauncherArgs(["--", "--mode=print"]).mode).toBe("print");
	});

	it("parses --model from the passthrough segment", () => {
		expect(parseLauncherArgs(["--", "--model", "openai/gpt-5.4"]).model).toBe("openai/gpt-5.4");
	});

	it("keeps a thinking-level suffix in --model verbatim", () => {
		expect(parseLauncherArgs(["--", "--model=anthropic/claude-sonnet-4-5:high"]).model).toBe(
			"anthropic/claude-sonnet-4-5:high",
		);
	});

	it("rejects an unsupported pi argument instead of silently dropping it", () => {
		expect(() => parseLauncherArgs(["--", "--verbose"])).toThrow(/--verbose/);
	});

	it("rejects an unknown mode value", () => {
		expect(() => parseLauncherArgs(["--", "--mode", "telepathic"])).toThrow(LauncherArgError);
	});
});
