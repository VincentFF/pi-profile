import { describe, expect, it } from "vitest";

import { resolveInitialProfile } from "../src/launcher/initial-profile.ts";
import { createResourceLoaderOptions } from "../src/resource-filter-adapter.ts";

describe("createResourceLoaderOptions", () => {
	it("applies no overrides for the default profile, exposing the full discoverable resource set", () => {
		expect(createResourceLoaderOptions(resolveInitialProfile(undefined))).toEqual({});
	});

	it("does not install skills or extensions overrides for the default profile", () => {
		const options = createResourceLoaderOptions(resolveInitialProfile("default"));
		expect(options.skillsOverride).toBeUndefined();
		expect(options.extensionsOverride).toBeUndefined();
	});
});
