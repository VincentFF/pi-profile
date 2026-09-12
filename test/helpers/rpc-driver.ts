import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

/**
 * Minimal JSON-RPC driver for a spawned `pi --mode rpc` subprocess.
 * Used by integration tests to introspect a real pi session (commands,
 * state) without a TUI or model calls.
 */

export interface RpcResponse {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: Record<string, unknown> & { commands?: Array<{ name: string; source: string; path?: string }> };
	error?: string;
}

export class RpcDriver {
	private child: ChildProcess;
	private pending = new Map<string, (response: RpcResponse) => void>();
	private seq = 0;
	readonly stderr: string[] = [];

	constructor(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
		this.child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stderr?.on("data", (chunk) => this.stderr.push(String(chunk)));
		const rl = readline.createInterface({ input: this.child.stdout! });
		rl.on("line", (line) => {
			let message: RpcResponse;
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}
			if (message.type === "response" && message.id && this.pending.has(message.id)) {
				this.pending.get(message.id)!(message);
				this.pending.delete(message.id);
			}
		});
	}

	send(command: Record<string, unknown>, timeoutMs = 20_000): Promise<RpcResponse> {
		const id = `req-${++this.seq}`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, resolve);
			setTimeout(() => reject(new Error(`timeout waiting for ${String(command.type)}`)), timeoutMs);
			this.child.stdin!.write(JSON.stringify({ id, ...command }) + "\n");
		});
	}

	async skillCommandNames(): Promise<string[]> {
		const response = await this.send({ type: "get_commands" });
		return (response.data?.commands ?? [])
			.filter((command) => command.source === "skill")
			.map((command) => command.name)
			.sort();
	}

	async close(): Promise<void> {
		this.child.kill("SIGTERM");
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
}
