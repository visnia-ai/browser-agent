import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BrowserAgentError } from "./errors.js";
import type { ResolvedOptions } from "./options.js";
import type { BrowserAgentTask } from "./types.js";

const execute = promisify(execFile);
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SUPPORTED_PLATFORMS = new Set([
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-x64",
	"win32-arm64",
	"win32-x64",
]);

export const platformKey = (
	platform: NodeJS.Platform = process.platform,
	architecture = process.arch,
) => `${platform}-${architecture}`;
export function bundledExecutable(
	platform: NodeJS.Platform = process.platform,
	architecture = process.arch,
): string {
	const suffix = platform === "win32" ? ".exe" : "";
	const key = platformKey(platform, architecture);
	if (!SUPPORTED_PLATFORMS.has(key)) return "";
	return path.join(PACKAGE_ROOT, "bin", `browser-agent${suffix}`);
}
export async function resolveExecutable(
	executable?: string,
	platform: NodeJS.Platform = process.platform,
	architecture = process.arch,
): Promise<string> {
	const resolved = executable ?? bundledExecutable(platform, architecture);
	try {
		await access(resolved, constants.X_OK);
		return resolved;
	} catch {
		if (!executable) {
			const key = platformKey(platform, architecture);
			throw new BrowserAgentError(
				"CLI_NOT_FOUND",
				SUPPORTED_PLATFORMS.has(key)
					? "The Browser Agent CLI was not installed. Reinstall '@visnia/browser-agent-sdk' with npm lifecycle scripts enabled."
					: `Browser Agent does not provide an executable for ${key}.`,
			);
		}
		throw new BrowserAgentError(
			"CLI_NOT_FOUND",
			`Bundled browser-agent executable is unavailable for ${platformKey()}.`,
		);
	}
}
export async function verifyExecutable(
	executable: string,
	verificationTimeoutMs = 5_000,
): Promise<void> {
	let stdout: string;
	try {
		({ stdout } = await execute(executable, ["--version-json"], {
			encoding: "utf8",
			timeout: verificationTimeoutMs,
		}));
	} catch (cause) {
		const code = (cause as NodeJS.ErrnoException).code;
		const timedOut = Boolean((cause as { killed?: boolean }).killed);
		throw new BrowserAgentError(
			code === "ENOENT" ? "CLI_NOT_FOUND" : "CLI_VERSION_INCOMPATIBLE",
			code === "ENOENT"
				? "Bundled browser-agent executable could not be started."
				: timedOut
					? "Bundled browser-agent version check timed out."
					: "Bundled browser-agent uses an incompatible RPC protocol.",
			{ cause },
		);
	}
	try {
		if (JSON.parse(stdout).rpcProtocolVersion !== 1) throw new Error();
	} catch {
		throw new BrowserAgentError(
			"CLI_VERSION_INCOMPATIBLE",
			"Bundled browser-agent uses an incompatible RPC protocol.",
		);
	}
}
export type ExecutableDependencies = {
	resolve(): Promise<string>;
	verify(executable: string): Promise<void>;
};
export const DEFAULT_EXECUTABLE_DEPENDENCIES = {
	resolve: resolveExecutable,
	verify: verifyExecutable,
} satisfies ExecutableDependencies;

export interface RuntimeFiles {
	configPath: string;
	internalPaths: string[];
	cleanup(): Promise<void>;
}
export async function createRuntimeFiles(
	options: ResolvedOptions,
	tasks: BrowserAgentTask[],
): Promise<RuntimeFiles> {
	const owned: string[] = [];
	try {
		const runtime = await mkdtemp(path.join(os.tmpdir(), "browser-agent-sdk-"));
		owned.push(runtime);
		await chmod(runtime, 0o700);
		const workspace =
			options.workspaceDirectory ??
			(await mkdtemp(path.join(process.cwd(), ".browser-agent-workspace-")));
		if (!options.workspaceDirectory) owned.push(workspace);
		await mkdir(options.downloadDirectory, { recursive: true });
		await mkdir(workspace, { recursive: true });
		const configPath = path.join(runtime, "config.yaml");
		const stageLLM = {
			provider: options.provider,
			model: options.model,
			reasoning_effort: options.reasoningEffort,
			max_model_len: options.maxModelLen,
			reserve_output_tokens: options.reserveOutputTokens,
			...(options.endpointUrl && { endpoint_url: options.endpointUrl }),
			...(options.openrouterProvider && {
				openrouter_provider: options.openrouterProvider,
			}),
		};
		const findTargetURLStageLLM = {
			...stageLLM,
			reasoning_effort: "none",
		};
		await writeFile(
			configPath,
			JSON.stringify({
				stage_llms: {
					findTargetURL: findTargetURLStageLLM,
					createChecklist: stageLLM,
					runAgent: stageLLM,
					verifySuccess: stageLLM,
					dataExtraction: stageLLM,
				},
				feature_flags: {
					workflow_orchestration: false,
					task_checklist: true,
					pre_step_screenshot_in_latest_user_prompt: false,
					user_takeover_tool: options.userTakeoverTool,
					auth_takeover: true,
					agent_takeover_tool: false,
					extract_data_whole_context: true,
					semantic_projection_history: "current",
					optimize_executor_step_delays: false,
					optimize_text_input: false,
				},
				headless: options.headless,
				...(options.executablePath && {
					executable_path: options.executablePath,
				}),
				download_dir: options.downloadDirectory,
				file_workspace_root: workspace,
				...(options.browserProfileDirectory && {
					browser_profiles: {
						mode: "seeded",
						seed_user_data_dir: options.browserProfileDirectory,
						per_worker_user_data_root: path.join(runtime, "browser-profiles"),
						reuse_existing_worker_profiles: false,
					},
				}),
				max_steps: options.maxSteps,
				concurrency: options.concurrency,
				task_runs: options.runsPerTask,
				task_run_retry_count: options.retryCount,
				validator_lifecycle: {
					mode: "retry",
					max_failures: 3,
					context: "full",
				},
				wait_between_tasks_ms: 0,
				save_steps_context: true,
				save_task_logs: true,
				step_messages_jsonl_path: path.join(runtime, "steps.jsonl"),
				tasks: tasks.map(({ task, url }) => ({
					task,
					...(url ? { url } : {}),
				})),
			}),
			{ mode: 0o600 },
		);
		const cleanup = () =>
			Promise.all(
				owned.map((item) => rm(item, { recursive: true, force: true })),
			).then(() => undefined);
		return { configPath, internalPaths: owned, cleanup };
	} catch (error) {
		await Promise.all(
			owned.map((item) => rm(item, { recursive: true, force: true })),
		);
		throw error;
	}
}
