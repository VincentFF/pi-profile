/**
 * Converts an ActivationPlan into Pi SDK resource-loader options.
 *
 * This is the controlled-loader seam (ADR-0001): the ProfileHost always builds
 * the Pi runtime through these options, so a profile can only ever expose what
 * its plan resolved. The default profile passes no overrides, which exposes
 * Pi's full discoverable resource set — identical to native `pi`.
 */

import type { CreateAgentSessionServicesOptions } from "@earendil-works/pi-coding-agent";

import type { ActivationPlan } from "./launcher/initial-profile.ts";

export type ControlledResourceLoaderOptions = NonNullable<
	CreateAgentSessionServicesOptions["resourceLoaderOptions"]
>;

export function createResourceLoaderOptions(plan: ActivationPlan): ControlledResourceLoaderOptions {
	if (plan.filter !== "none") {
		throw new Error(`unsupported resource filter: ${String(plan.filter)}`);
	}
	return {};
}
