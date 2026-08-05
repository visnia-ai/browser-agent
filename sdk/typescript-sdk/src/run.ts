import { randomUUID } from "node:crypto";
import { ReplayEvents } from "./events.js";
import { asBrowserAgentError, BrowserAgentError } from "./errors.js";
import {
	consumeLogs,
	requestRun,
	startAgentProcess,
	terminateProcess,
} from "./protocol.js";
import type { AgentProcess } from "./protocol.js";
import { RpcState } from "./rpc.js";
import {
	createRuntimeFiles,
	DEFAULT_EXECUTABLE_DEPENDENCIES,
} from "./runtime.js";
import type { ExecutableDependencies, RuntimeFiles } from "./runtime.js";
import { childEnvironment, normalizeTasks, resolveOptions } from "./options.js";
import type { ResolvedOptions } from "./options.js";
import type * as API from "./types.js";

type Outcome = "completed" | "cancelled";
export class BrowserAgent {
	readonly #options: ResolvedOptions;
	#executable?: Promise<string>;
	constructor(options: API.BrowserAgentOptions);
	constructor(
		options: API.BrowserAgentOptions,
		private readonly dependencies: ExecutableDependencies = DEFAULT_EXECUTABLE_DEPENDENCIES,
	) {
		this.#options = Object.freeze(resolveOptions(options));
	}
	run(
		input: API.BrowserAgentTask | readonly API.BrowserAgentTask[],
		options: API.BrowserAgentRunOptions = {},
	): API.BrowserAgentRun {
		const tasks = normalizeTasks(input);
		this.#executable ??= this.dependencies
			.resolve()
			.then(async (executable) => {
				await this.dependencies.verify(executable);
				return executable;
			});
		return new BrowserAgentRunImpl(
			randomUUID(),
			this.#options,
			tasks,
			options,
			this.#executable,
		);
	}
}

export class BrowserAgentRunImpl implements API.BrowserAgentRun {
	readonly result: Promise<API.BrowserAgentResult>;
	readonly #stream = new ReplayEvents<API.BrowserAgentEvent>();
	#rpc?: RpcState;
	#process?: AgentProcess;
	#cancelRequested = false;
	#settle?: (value: Outcome | BrowserAgentError) => void;
	constructor(
		readonly id: string,
		private readonly options: ResolvedOptions,
		private readonly tasks: API.BrowserAgentTask[],
		private readonly runOptions: API.BrowserAgentRunOptions,
		executable: Promise<string>,
		private readonly createFiles = createRuntimeFiles,
	) {
		this.result = this.#execute(executable);
	}

	events(): AsyncIterable<API.BrowserAgentEvent> {
		return this.#stream.iterate();
	}

	async cancel(): Promise<void> {
		this.#cancelRequested = true;
		this.#settle?.("cancelled");
		if (this.#process) await terminateProcess(this.#process);
		await this.result.catch(() => undefined);
	}
	#publish(event: API.BrowserAgentEvent): void {
		this.#stream.publish(event);
		try {
			this.runOptions.onEvent?.(event);
		} catch {}
	}
	#complete(status: API.BrowserAgentResult["status"], startedAt: Date) {
		const result: API.BrowserAgentResult = {
			runId: this.id,
			status,
			tasks: this.#rpc?.results ?? [],
			startedAt,
			finishedAt: new Date(),
		};
		this.#publish({ type: "run_completed", runId: this.id, result });
		this.#stream.close();
		return result;
	}
	async #terminal(process: AgentProcess): Promise<Outcome> {
		return new Promise((resolve, reject) => {
			let settled = false;
			this.#settle = (value) => {
				if (settled) return;
				settled = true;
				value instanceof BrowserAgentError
					? reject(value)
					: resolve(value);
			};
			void (async () => {
				try {
					for await (const message of process.messages) {
						const event = this.#rpc!.handle(message);
						if (event === "complete") this.#settle?.("completed");
						else if (event) this.#publish(event);
					}
				} catch (error) {
					this.#settle?.(
						asBrowserAgentError(error, "PROTOCOL_ERROR", [], []),
					);
				}
			})();
			void process.exit.then(
				() =>
					this.#settle?.(
						this.#cancelRequested
							? "cancelled"
							: new BrowserAgentError(
									"PROCESS_EXITED",
									"browser-agent exited early.",
								),
					),
				(error) =>
					this.#settle?.(
						asBrowserAgentError(error, "PROCESS_EXITED", [], []),
					),
			);
		});
	}
	async #execute(
		executablePromise: Promise<string>,
	): Promise<API.BrowserAgentResult> {
		const startedAt = new Date();
		const secrets = [
			...(this.options.apiKey ? [this.options.apiKey] : []),
			...this.tasks.flatMap((task) =>
				(task.credentials ?? []).flatMap((credential) => [
					credential.username,
					credential.password,
					credential.domain,
				]),
			),
		];
		let files: RuntimeFiles | undefined;
		try {
			const executable = await executablePromise;
			if (this.#cancelRequested)
				return this.#complete("cancelled", startedAt);
			files = await this.createFiles(this.options, this.tasks);
			if (this.#cancelRequested) {
				await files.cleanup();
				files = undefined;
				return this.#complete("cancelled", startedAt);
			}
			this.#process = startAgentProcess(
				executable,
				files.configPath,
				childEnvironment(this.options),
			);
			this.#rpc = new RpcState(this.id, secrets, files.internalPaths);
			const logs = consumeLogs(
				this.#process,
				this.id,
				this.options.onLog,
				secrets,
				files.internalPaths,
			);
			const terminal = this.#terminal(this.#process);
			requestRun(this.#process, this.tasks);
			const outcome = await terminal;
			if (outcome === "cancelled") {
				await terminateProcess(this.#process);
			} else {
				const exit = await this.#process.exit;
				if (exit.code !== 0)
					throw new BrowserAgentError(
						"PROCESS_EXITED",
						"browser-agent exited unsuccessfully.",
					);
				if (this.#rpc.results.length !== this.tasks.length)
					throw new BrowserAgentError(
						"PROTOCOL_ERROR",
						"browser-agent completed without all task results.",
					);
			}
			await logs;
			await files.cleanup();
			files = undefined;
			const status =
				outcome === "cancelled"
					? "cancelled"
					: this.#rpc.results.some((task) => task.status === "failed")
						? "failed"
						: "completed";
			return this.#complete(status, startedAt);
		} catch (error) {
			if (this.#process) await terminateProcess(this.#process);
			if (files) await files.cleanup().catch(() => undefined);
			const normalized = asBrowserAgentError(
				error,
				"PROCESS_EXITED",
				secrets,
				files?.internalPaths ?? [],
			);
			this.#publish({ type: "error", runId: this.id, error: normalized });
			this.#stream.close();
			throw normalized;
		} finally {
			this.#settle = undefined;
		}
	}
}
