import { describe, expect, it } from "vitest";

import { UnknownProfileError, resolveInitialProfile } from "../src/launcher/initial-profile.ts";

describe("resolveInitialProfile", () => {
	it("resolves no argument to the built-in default profile", () => {
		expect(resolveInitialProfile(undefined)).toEqual({ profile: "default", filter: "none" });
	});

	it("resolves an explicit default profile", () => {
		expect(resolveInitialProfile("default").profile).toBe("default");
	});

	it("rejects any other profile name because catalogs do not exist yet", () => {
		expect(() => resolveInitialProfile("review")).toThrow(UnknownProfileError);
		expect(() => resolveInitialProfile("review")).toThrow(/unknown profile: review/);
	});
});
