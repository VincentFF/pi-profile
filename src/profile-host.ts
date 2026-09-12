/**
 * ProfileHost: owns the Pi SDK runtime for one `pi-profile` launch.
 *
 * The host resolves the initial ActivationPlan BEFORE the Pi runtime is
 * created (ADR-0001) and builds every session through the controlled
 * resource-loader seam, so the model can only ever see what the plan
 * resolved. It never writes runtime state; persistence arrives with the
 * state-store ticket.
 */

import path from "node:path";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	InteractiveMode,
	ModelRuntime,
	resolveCliModel,
	runPrintMode,
	runRpcMode,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

import type { LauncherArgs } from "./launcher/args.ts";
import { type ActivationPlan, resolveInitialProfile } from "./launcher/initial-profile.ts";
import { createResourceLoaderOptions } from "./resource-filter-adapter.ts";

export interface ProfileHostOptions {
	cwd: string;
	/** Explicit agent dir (tests); production defaults to Pi's agent dir. */
	agentDir?: string;
	/** Explicit session manager (tests); production continues the most recent session. */
	sessionManager?: SessionManager;
}

export interface ProfileRuntime {
	runtime: AgentSessionRuntime;
	plan: ActivationPlan;
}

export async function createProfileRuntime(
	args: LauncherArgs,
	options: ProfileHostOptions,
): Promise<ProfileRuntime> {
	// Fails before any runtime exists when the profile is unknown.
	const plan = resolveInitialProfile(args.profile);
	const cwd = options.cwd;
	const agentDir = options.agentDir ?? getAgentDir();

	const modelRuntime = await ModelRuntime.create({
		authPath: path.join(agentDir, "auth.json"),
		modelsPath: path.join(agentDir, "models.json"),
		modelsStorePath: path.join(agentDir, "models-store.json"),
	});

	const cliModel = args.model === undefined ? undefined : resolveCliModel({ cliModel: args.model, modelRuntime });
	if (cliModel?.error) {
		throw new Error(cliModel.error);
	}

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd: runtimeCwd,
		sessionManager,
		sessionStartEvent,
	}) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd,
			agentDir,
			modelRuntime,
			resourceLoaderOptions: createResourceLoaderOptions(plan),
		});
		const sessionResult = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: cliModel?.model,
			thinkingLevel: cliModel?.thinkingLevel,
		});
		const result: CreateAgentSessionRuntimeResult = {
			...sessionResult,
			services,
			diagnostics: services.diagnostics,
		};
		return result;
	};

	const sessionManager = options.sessionManager ?? SessionManager.continueRecent(cwd);
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });
	return { runtime, plan };
}

export async function startProfileHost(args: LauncherArgs, options: ProfileHostOptions): Promise<number> {
	const { runtime } = await createProfileRuntime(args, options);

	switch (args.mode) {
		case "rpc":
			await runRpcMode(runtime); // Promise<never>: the process exits inside RPC mode
			return 0;
		case "print":
			return runPrintMode(runtime, { mode: "text" });
		case "json":
			return runPrintMode(runtime, { mode: "json" });
		case "interactive": {
			const interactive = new InteractiveMode(runtime, {
				modelFallbackMessage: runtime.modelFallbackMessage,
			});
			await interactive.run();
			return 0;
		}
	}
}
