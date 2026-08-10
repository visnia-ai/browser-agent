import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it } from "mocha";
import { encryptAuthField } from "../src/auth/crypto.js";
import { configFeatureFlags } from "../src/config-feature-flags.js";
import { createDefaultCoreDeps } from "../src/core/deps.js";
import { featureFlags } from "../src/featureFlags.js";
import { loadConfig, parseArgs } from "../src/utils.js";
import { withAuthEncryptionKey } from "./helpers/auth-test-utils.js";

function writeTempConfig(
	content: string,
	withDefaultReasoningEffort = true,
): string {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "load-config-"));
	const configPath = path.join(tempDir, "config.yaml");
	const registeredModelContent = content
		.replaceAll("gpt-5.2-mini", "gpt-5.4-mini")
		.replaceAll("gpt-5.2-nano", "gpt-5.4-mini")
		.replaceAll("gpt-5.2", "gpt-5.4")
		.replaceAll("zai-org/GLM-5\n", "zai-org/GLM-5.2\n");
	const migratedContent =
		withDefaultReasoningEffort &&
		!/^reasoning_effort:/m.test(registeredModelContent) &&
		!/^reasoningEffort:/m.test(registeredModelContent)
			? `reasoning_effort: none\n${registeredModelContent}`
			: registeredModelContent;
	fs.writeFileSync(configPath, migratedContent, "utf-8");
	return configPath;
}

function captureLoadConfigFailure(
	content: string,
	withDefaultReasoningEffort = true,
): string {
	const configPath = writeTempConfig(content, withDefaultReasoningEffort);
	const originalExit = process.exit;
	const originalError = console.error;
	const errors: string[] = [];

	process.exit = ((code?: number) => {
		throw new Error(`process.exit:${code ?? 0}`);
	}) as typeof process.exit;
	console.error = ((...args: unknown[]) => {
		errors.push(args.map((value) => String(value)).join(" "));
	}) as typeof console.error;

	try {
		assert.throws(() => loadConfig(configPath), /process\.exit:1/);
		return errors.join("\n");
	} finally {
		process.exit = originalExit;
		console.error = originalError;
	}
}

describe("load-config", () => {
	it("rejects unsupported providers", () => {
		const error = captureLoadConfigFailure(`
provider: unsupported
model: unsupported-model
concurrency: 1
tasks:
  - "test task"
`);

		assert.include(
			error,
			"Use one of: openai, codex, vllm, together, anthropic, google, openrouter.",
		);
	});

	it("parses Codex with OpenAI-equivalent reasoning defaults", () => {
		const configPath = writeTempConfig(
			`
provider: codex
model: gpt-5.6-luna
concurrency: 1
tasks:
  - "test task"
`,
			false,
		);

		const config = loadConfig(configPath);
		assert.equal(config.stageLLMs.runAgent.provider, "codex");
		assert.equal(config.stageLLMs.runAgent.reasoningEffort, "low");
		assert.isUndefined(config.stageLLMs.runAgent.endpointUrl);
		assert.equal(config.stageLLMs.dataExtraction.provider, "codex");
		assert.equal(config.stageLLMs.dataExtraction.model, "gpt-5.6-luna");
	});

	it("rejects endpoint overrides for Codex", () => {
		const error = captureLoadConfigFailure(
			`
provider: codex
model: gpt-5.6-luna
endpoint_url: https://proxy.test/v1
concurrency: 1
tasks:
  - "test task"
`,
			false,
		);

		assert.include(error, "Provider 'codex' uses a fixed endpoint");
	});

	it("supports a Codex stage without inheriting another provider's endpoint", () => {
		const configPath = writeTempConfig(
			`
provider: openai
model: gpt-5.4
endpoint_url: https://openai-proxy.test/v1
stage_llms:
  run_agent:
    provider: codex
    model: gpt-5.6-luna
concurrency: 1
tasks:
  - "test task"
`,
			false,
		);

		const config = loadConfig(configPath);
		assert.equal(config.stageLLMs.createChecklist.endpointUrl, "https://openai-proxy.test/v1");
		assert.equal(config.stageLLMs.runAgent.provider, "codex");
		assert.isUndefined(config.stageLLMs.runAgent.endpointUrl);
	});

	it("parses and inherits an OpenRouter provider constraint", () => {
		const configPath = writeTempConfig(`
provider: openrouter
model: z-ai/glm-5.2
reasoning_effort: xhigh
openrouter_provider: baseten/fp8
concurrency: 1
tasks:
  - "test task"
`);

		const config = loadConfig(configPath);

		assert.equal(
			config.stageLLMs.createChecklist.openrouterProvider,
			"baseten/fp8",
		);
		assert.equal(config.stageLLMs.runAgent.openrouterProvider, "baseten/fp8");
		assert.equal(
			config.stageLLMs.verifySuccess.openrouterProvider,
			"baseten/fp8",
		);
	});

	it("rejects openrouter_provider with another provider", () => {
		const error = captureLoadConfigFailure(`
provider: openai
model: gpt-5.2
openrouter_provider: baseten
concurrency: 1
tasks:
  - "test task"
`);

		assert.include(
			error,
			"openrouter_provider can only be used with provider 'openrouter'",
		);
	});

	it("parses stage_llms-only config with per-stage provider/model options", () => {
		const configPath = writeTempConfig(`
stage_llms:
  findTargetURL:
    provider: together
    model: zai-org/GLM-5
  createChecklist:
    provider: openai
    model: gpt-5.2-mini
  runAgent:
    provider: vllm
    model: Qwen/Qwen3-14B
    reasoning_effort: enabled
    endpoint_url: http://127.0.0.1:8000/v1
  data_extraction:
    provider: openai
    model: gpt-5.4-mini
  verifySuccess:
    provider: openai
    model: gpt-5.4-mini
concurrency: 1
tasks:
  - "test task"
`);

		const config = loadConfig(configPath);

		assert.deepEqual(config.stageLLMs.findTargetURL, {
			provider: "together",
			model: "zai-org/GLM-5.2",
			reasoningEffort: "none",
			endpointUrl: undefined,
		});
		assert.deepEqual(config.stageLLMs.createChecklist, {
			provider: "openai",
			model: "gpt-5.4-mini",
			reasoningEffort: "none",
			endpointUrl: undefined,
		});
		assert.deepEqual(config.stageLLMs.runAgent, {
			provider: "vllm",
			model: "Qwen/Qwen3-14B",
			reasoningEffort: "enabled",
			endpointUrl: "http://127.0.0.1:8000/v1",
		});
		assert.deepEqual(config.stageLLMs.dataExtraction, {
			provider: "openai",
			model: "gpt-5.4-mini",
			reasoningEffort: "none",
			endpointUrl: undefined,
		});
		assert.deepEqual(config.stageLLMs.verifySuccess, {
			provider: "openai",
			model: "gpt-5.4-mini",
			reasoningEffort: "none",
			endpointUrl: undefined,
		});
		assert.deepEqual(config.featureFlags, {
			taskChecklist: true,
			preStepScreenshotInLatestUserPrompt: false,
			userTakeoverTool: true,
			authTakeover: false,
			agentTakeoverTool: false,
			extractDataWholeContext: false,
			semanticProjectionHistory: "current",
			openAIEncryptedResponses: true,
			openAIExplicitPromptCaching: true,
			optimizeExecutorStepDelays: false,
			optimizeTextInput: false,
		});
		assert.deepEqual(config.validatorLifecycle, {
			mode: "retry",
			maxFailures: 3,
			context: "full",
		});
	});

	it("keeps backward compatibility with model string overrides", () => {
		const configPath = writeTempConfig(`
provider: openai
model: gpt-5.2
models:
  findTargetURL: gpt-5.2-mini
  runAgent: gpt-5.2
concurrency: 1
tasks:
  - "test task"
`);

		const config = loadConfig(configPath);

		assert.deepEqual(config.stageLLMs.findTargetURL, {
			provider: "openai",
			model: "gpt-5.4-mini",
			reasoningEffort: "none",
			endpointUrl: undefined,
		});
		assert.deepEqual(config.stageLLMs.runAgent, {
			provider: "openai",
			model: "gpt-5.4",
			reasoningEffort: "none",
			endpointUrl: undefined,
		});
		assert.deepEqual(config.stageLLMs.dataExtraction, {
			provider: "openai",
			model: "gpt-5.4-mini",
			reasoningEffort: "none",
			endpointUrl: undefined,
		});
		assert.deepEqual(config.stageLLMs.verifySuccess, {
			provider: "openai",
			model: "gpt-5.4",
			reasoningEffort: "none",
			endpointUrl: undefined,
		});
		assert.deepEqual(config.featureFlags, {
			taskChecklist: true,
			preStepScreenshotInLatestUserPrompt: false,
			userTakeoverTool: true,
			authTakeover: false,
			agentTakeoverTool: false,
			extractDataWholeContext: false,
			semanticProjectionHistory: "current",
			openAIEncryptedResponses: true,
			openAIExplicitPromptCaching: true,
			optimizeExecutorStepDelays: false,
			optimizeTextInput: false,
		});
	});

	it("parses concurrency from config", () => {
		const configPath = writeTempConfig(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  runAgent:
    provider: openai
    model: gpt-5.2
  verifySuccess:
    provider: openai
    model: gpt-5.2
concurrency: 3
tasks:
  - "test task"
`);

		const config = loadConfig(configPath);
		assert.strictEqual(config.concurrency, 3);
	});

	it("rejects legacy executeLoop stage keys in YAML", () => {
		const errorOutput = captureLoadConfigFailure(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  executeLoop:
    provider: openai
    model: gpt-5.2
  verifySuccess:
    provider: openai
    model: gpt-5.2
concurrency: 1
tasks:
  - "test task"
`);

		assert.include(errorOutput, "'executeLoop' has been renamed to 'runAgent'");
	});

	it("rejects missing concurrency", () => {
		const errorOutput = captureLoadConfigFailure(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  runAgent:
    provider: openai
    model: gpt-5.2
  verifySuccess:
    provider: openai
    model: gpt-5.2
tasks:
  - "test task"
`);

		assert.include(errorOutput, "Invalid concurrency in config");
	});

	it("rejects legacy ports config", () => {
		const errorOutput = captureLoadConfigFailure(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  runAgent:
    provider: openai
    model: gpt-5.2
  verifySuccess:
    provider: openai
    model: gpt-5.2
ports:
  - 9222
tasks:
  - "test task"
`);

		assert.include(errorOutput, "no longer accept 'port' or 'ports'");
	});

	it("parses an explicit verifySuccess stage override", () => {
		const configPath = writeTempConfig(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2-mini
  runAgent:
    provider: vllm
    model: Qwen/Qwen3-14B
    endpoint_url: http://127.0.0.1:8000/v1
  verifySuccess:
    provider: openai
    model: gpt-5.4-mini
    reasoning_effort: high
concurrency: 1
tasks:
  - "test task"
`);

		const config = loadConfig(configPath);

		assert.deepEqual(config.stageLLMs.verifySuccess, {
			provider: "openai",
			model: "gpt-5.4-mini",
			reasoningEffort: "high",
			endpointUrl: undefined,
		});
	});

	it("parses all reasoning effort values and top-level inheritance", () => {
		const configPath = writeTempConfig(`
provider: openai
model: gpt-5.2
reasoning_effort: none
stage_llms:
  runAgent:
    provider: vllm
    model: Qwen/Qwen3-14B
    reasoning_effort: enabled
    endpoint_url: http://127.0.0.1:8000/v1
  verifySuccess:
    provider: together
    model: zai-org/GLM-5.2
    reasoning_effort: max
concurrency: 1
tasks:
  - "test task"
`);

		const config = loadConfig(configPath);

		assert.equal(config.stageLLMs.findTargetURL.reasoningEffort, "none");
		assert.equal(config.stageLLMs.runAgent.reasoningEffort, "enabled");
		assert.equal(config.stageLLMs.verifySuccess.reasoningEffort, "max");
	});

	it("rejects a stage without a resolved reasoning effort", () => {
		const errorOutput = captureLoadConfigFailure(
			`
provider: anthropic
model: claude-custom
concurrency: 1
tasks:
  - "test task"
`,
			false,
		);

		assert.include(
			errorOutput,
			"Missing reasoning_effort for stage 'createChecklist'",
		);
	});

	it("uses registered model reasoning defaults", () => {
		const configPath = writeTempConfig(
			`
provider: together
model: zai-org/GLM-5.2
concurrency: 1
tasks:
  - "test task"
`,
			false,
		);

		const config = loadConfig(configPath);

		assert.equal(config.stageLLMs.runAgent.reasoningEffort, "high");
	});

	it("parses DeepSeek V4 Flash vLLM configuration", () => {
		const configPath = writeTempConfig(
			`
provider: vllm
model: deepseek-ai/DeepSeek-V4-Flash-0731
reasoning_effort: max
endpoint_url: http://38.147.81.21:8000/v1
concurrency: 1
tasks:
  - "test task"
`,
			false,
		);

		const config = loadConfig(configPath);

		assert.deepInclude(config.stageLLMs.runAgent, {
			provider: "vllm",
			model: "deepseek-ai/DeepSeek-V4-Flash-0731",
			reasoningEffort: "max",
			endpointUrl: "http://38.147.81.21:8000/v1",
		});
	});

	it("accepts low reasoning for DeepSeek V4 Flash on vLLM", () => {
		const configPath = writeTempConfig(
			`
provider: vllm
model: deepseek-ai/DeepSeek-V4-Flash-0731
reasoning_effort: low
endpoint_url: http://38.147.81.21:8000/v1
concurrency: 1
tasks:
  - "test task"
`,
			false,
		);

		const config = loadConfig(configPath);

		assert.equal(config.stageLLMs.runAgent.reasoningEffort, "low");
	});

	it("accepts DeepSeek V4 Flash on Together", () => {
		const configPath = writeTempConfig(
			`
provider: together
model: deepseek-ai/DeepSeek-V4-Flash-0731
reasoning_effort: low
concurrency: 1
tasks:
  - "test task"
`,
			false,
		);

		const config = loadConfig(configPath);

		assert.deepInclude(config.stageLLMs.runAgent, {
			provider: "together",
			model: "deepseek-ai/DeepSeek-V4-Flash-0731",
			reasoningEffort: "low",
		});
	});

	it("accepts arbitrary OpenRouter models with explicit reasoning", () => {
		const configPath = writeTempConfig(
			`
provider: openrouter
model: vendor/new-model
reasoning_effort: xhigh
concurrency: 1
tasks:
  - "test task"
`,
			false,
		);

		const config = loadConfig(configPath);

		assert.deepInclude(config.stageLLMs.runAgent, {
			provider: "openrouter",
			model: "vendor/new-model",
			reasoningEffort: "xhigh",
		});
	});

	it("rejects unknown and unsupported reasoning model configurations", () => {
		const unknownModelError = captureLoadConfigFailure(`
provider: openai
model: unknown-gpt
reasoning_effort: low
concurrency: 1
tasks:
  - "test task"
`);
		assert.include(
			unknownModelError,
			"Unknown reasoning model 'unknown-gpt' for provider 'openai'",
		);

		const unsupportedEffortError = captureLoadConfigFailure(`
provider: openai
model: gpt-5.4
reasoning_effort: enabled
concurrency: 1
tasks:
  - "test task"
`);
		assert.include(
			unsupportedEffortError,
			"Unsupported reasoning_effort 'enabled' for provider 'openai' model 'gpt-5.4'",
		);
		assert.include(
			unsupportedEffortError,
			"Allowed values: none, minimal, low, medium, high",
		);
	});

	it("uses low reasoning for the built-in data extraction fallback", () => {
		const configPath = writeTempConfig(
			`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.4
    reasoning_effort: none
  createChecklist:
    provider: openai
    model: gpt-5.4
    reasoning_effort: none
  runAgent:
    provider: openai
    model: gpt-5.4
    reasoning_effort: none
  verifySuccess:
    provider: openai
    model: gpt-5.4
    reasoning_effort: none
concurrency: 1
tasks:
  - "test task"
`,
			false,
		);

		const config = loadConfig(configPath);
		assert.deepEqual(config.stageLLMs.dataExtraction, {
			provider: "openai",
			model: "gpt-5.4-mini",
			reasoningEffort: "low",
			endpointUrl: undefined,
		});
	});

	it("parses optional prompt budget fields for a stage", () => {
		const configPath = writeTempConfig(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  runAgent:
    provider: vllm
    model: lukealonso/GLM-5.1-NVFP4
    endpoint_url: http://127.0.0.1:8001/v1
    max_model_len: 48000
    reserve_output_tokens: 4000
  verifySuccess:
    provider: openai
    model: gpt-5.2
concurrency: 1
tasks:
  - "test task"
`);

		const config = loadConfig(configPath);

		assert.deepInclude(config.stageLLMs.runAgent, {
			provider: "vllm",
			model: "lukealonso/GLM-5.1-NVFP4",
			endpointUrl: "http://127.0.0.1:8001/v1",
			maxModelLen: 48000,
			reserveOutputTokens: 4000,
		});
	});

	it("rejects partial prompt budget configuration", () => {
		const error = captureLoadConfigFailure(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  runAgent:
    provider: openai
    model: gpt-5.2
    max_model_len: 48000
  verifySuccess:
    provider: openai
    model: gpt-5.2
concurrency: 1
tasks:
  - "test task"
`);

		assert.include(
			error,
			"Provide max_model_len and reserve_output_tokens together",
		);
	});

	it("parses YAML-backed feature flags without mutating runtime config flags", () => {
		const originalTaskChecklist = configFeatureFlags.taskChecklist;
		const originalPreStepScreenshot =
			configFeatureFlags.preStepScreenshotInLatestUserPrompt;
		const originalUserTakeover = configFeatureFlags.userTakeoverTool;
		const originalAuthTakeover = configFeatureFlags.authTakeover;
		const originalAgentTakeover = configFeatureFlags.agentTakeoverTool;
		const originalExtractDataWholeContext =
			configFeatureFlags.extractDataWholeContext;
		const originalSemanticProjectionHistory =
			configFeatureFlags.semanticProjectionHistory;
		const originalOpenAIEncryptedResponses =
			configFeatureFlags.openAIEncryptedResponses;
		const originalOpenAIExplicitPromptCaching =
			configFeatureFlags.openAIExplicitPromptCaching;
		try {
			const configPath = writeTempConfig(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  runAgent:
    provider: openai
    model: gpt-5.2
  verifySuccess:
    provider: openai
    model: gpt-5.2
feature_flags:
  task_checklist: false
  pre_step_screenshot_in_latest_user_prompt: true
  user_takeover_tool: false
  auth_takeover: true
  agent_takeover_tool: true
  extract_data_whole_context: true
  semantic_projection_history: cumulative
  openai_encrypted_responses: false
  openai_explicit_prompt_caching: false
  optimize_executor_step_delays: true
  optimize_text_input: true
concurrency: 1
tasks:
  - "test task"
`);

			const config = loadConfig(configPath);

			assert.deepEqual(config.featureFlags, {
				taskChecklist: false,
				preStepScreenshotInLatestUserPrompt: true,
				userTakeoverTool: false,
				authTakeover: true,
				agentTakeoverTool: true,
				extractDataWholeContext: true,
				semanticProjectionHistory: "cumulative",
				openAIEncryptedResponses: false,
				openAIExplicitPromptCaching: false,
				optimizeExecutorStepDelays: true,
				optimizeTextInput: true,
			});
			assert.deepEqual(configFeatureFlags, {
				taskChecklist: originalTaskChecklist,
				preStepScreenshotInLatestUserPrompt: originalPreStepScreenshot,
				userTakeoverTool: originalUserTakeover,
				authTakeover: originalAuthTakeover,
				agentTakeoverTool: originalAgentTakeover,
				extractDataWholeContext: originalExtractDataWholeContext,
				semanticProjectionHistory: originalSemanticProjectionHistory,
				openAIEncryptedResponses: originalOpenAIEncryptedResponses,
				openAIExplicitPromptCaching:
					originalOpenAIExplicitPromptCaching,
				optimizeExecutorStepDelays: false,
				optimizeTextInput: false,
			});
		} finally {
			configFeatureFlags.taskChecklist = originalTaskChecklist;
			configFeatureFlags.preStepScreenshotInLatestUserPrompt =
				originalPreStepScreenshot;
			configFeatureFlags.userTakeoverTool = originalUserTakeover;
			configFeatureFlags.authTakeover = originalAuthTakeover;
			configFeatureFlags.agentTakeoverTool = originalAgentTakeover;
			configFeatureFlags.extractDataWholeContext =
				originalExtractDataWholeContext;
			configFeatureFlags.semanticProjectionHistory =
				originalSemanticProjectionHistory;
			configFeatureFlags.openAIEncryptedResponses =
				originalOpenAIEncryptedResponses;
			configFeatureFlags.openAIExplicitPromptCaching =
				originalOpenAIExplicitPromptCaching;
		}
	});

	for (const legacyFlag of [
		"openai_stateful_responses",
		"openAIStatefulResponses",
	]) {
		it(`rejects legacy OpenAI continuation flag ${legacyFlag}`, () => {
			const error = captureLoadConfigFailure(`
provider: openai
model: gpt-5.2
feature_flags:
  ${legacyFlag}: true
concurrency: 1
tasks:
  - "test task"
`);

			assert.include(error, "openai_encrypted_responses");
		});
	}

	for (const legacyFlag of [
		"disable_qwen_reasoning_for_run_agent",
		"disableQwenReasoningForRunAgent",
		"executor_reasoning",
		"executorReasoning",
		"adaptive_executor_reasoning",
		"adaptiveExecutorReasoning",
	]) {
		it(`rejects legacy YAML reasoning flag ${legacyFlag}`, () => {
			const errorOutput = captureLoadConfigFailure(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  runAgent:
    provider: openai
    model: gpt-5.2
  verifySuccess:
    provider: openai
    model: gpt-5.2
feature_flags:
  ${legacyFlag}: true
concurrency: 1
tasks:
  - "test task"
`);

			assert.include(
				errorOutput,
				`feature_flags.${legacyFlag} has been removed`,
			);
			assert.include(
				errorOutput,
				"Set reasoning_effort on the relevant stage_llms entry instead",
			);
		});
	}

	it("rejects YAML overrides for executor_action_context_fields", () => {
		const errorOutput = captureLoadConfigFailure(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  runAgent:
    provider: openai
    model: gpt-5.2
  verifySuccess:
    provider: openai
    model: gpt-5.2
feature_flags:
  executor_action_context_fields: false
concurrency: 1
tasks:
  - "test task"
`);

		assert.include(
			errorOutput,
			"feature_flags.executor_action_context_fields has been removed; executor action-context fields are derived from the executor model identity.",
		);
	});

	it("rejects removed executor thinking-field YAML flags", () => {
		for (const key of [
			"omit_executor_thinking_field",
			"omitExecutorThinkingField",
		]) {
			const errorOutput = captureLoadConfigFailure(`
provider: openai
model: gpt-5.2
reasoning_effort: low
feature_flags:
  ${key}: false
concurrency: 1
tasks:
  - "test task"
`);

			assert.include(errorOutput, `feature_flags.${key} has been removed`);
			assert.include(
				errorOutput,
				"the executor thinking field is always omitted",
			);
		}
	});

	it("parses encrypted auth credentials from YAML config", async () => {
		await withAuthEncryptionKey(async () => {
			const encryptedDomainUrl = encryptAuthField("https://app.example.com");
			const encryptedUsername = encryptAuthField("user@example.com");
			const encryptedPassword = encryptAuthField("secret-password");
			const configPath = writeTempConfig(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  runAgent:
    provider: openai
    model: gpt-5.2
  verifySuccess:
    provider: openai
    model: gpt-5.2
auth_credentials:
  mode: encrypted
  encrypted_domain_url: "${encryptedDomainUrl}"
  encrypted_username: "${encryptedUsername}"
  encrypted_password: "${encryptedPassword}"
concurrency: 1
tasks:
  - "test task"
`);

			const config = loadConfig(configPath);

			assert.deepEqual(config.authCredentials, {
				mode: "encrypted",
				encryptedDomainUrl,
				encryptedUsername,
				encryptedPassword,
			});
		});
	});

	it("parses multiple encrypted auth credentials from YAML config", async () => {
		await withAuthEncryptionKey(async () => {
			const firstEncryptedDomainUrl = encryptAuthField(
				"https://accounts.first.example/login",
			);
			const firstEncryptedUsername = encryptAuthField("first@example.com");
			const firstEncryptedPassword = encryptAuthField("first-secret");
			const secondEncryptedDomainUrl = encryptAuthField(
				"https://login.second.example/sign-in",
			);
			const secondEncryptedUsername = encryptAuthField("second@example.com");
			const secondEncryptedPassword = encryptAuthField("second-secret");
			const configPath = writeTempConfig(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  runAgent:
    provider: openai
    model: gpt-5.2
  verifySuccess:
    provider: openai
    model: gpt-5.2
auth_credentials:
  - mode: encrypted
    encrypted_domain_url: "${firstEncryptedDomainUrl}"
    encrypted_username: "${firstEncryptedUsername}"
    encrypted_password: "${firstEncryptedPassword}"
  - mode: encrypted
    encrypted_domain_url: "${secondEncryptedDomainUrl}"
    encrypted_username: "${secondEncryptedUsername}"
    encrypted_password: "${secondEncryptedPassword}"
concurrency: 1
tasks:
  - "test task"
`);

			const config = loadConfig(configPath);

			assert.deepEqual(config.authCredentials, [
				{
					mode: "encrypted",
					encryptedDomainUrl: firstEncryptedDomainUrl,
					encryptedUsername: firstEncryptedUsername,
					encryptedPassword: firstEncryptedPassword,
				},
				{
					mode: "encrypted",
					encryptedDomainUrl: secondEncryptedDomainUrl,
					encryptedUsername: secondEncryptedUsername,
					encryptedPassword: secondEncryptedPassword,
				},
			]);
		});
	});

	it("rejects plaintext auth credentials in YAML config", () => {
		const errorOutput = captureLoadConfigFailure(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  runAgent:
    provider: openai
    model: gpt-5.2
  verifySuccess:
    provider: openai
    model: gpt-5.2
auth_credentials:
  mode: plaintext
  domain_url: "https://app.example.com"
  username: "user@example.com"
  password: "secret"
concurrency: 1
tasks:
  - "test task"
`);

		assert.include(errorOutput, 'YAML config only supports mode: "encrypted"');
	});

	it("parses proxy_host and proxy_port together", () => {
		const configPath = writeTempConfig(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  runAgent:
    provider: openai
    model: gpt-5.2
  verifySuccess:
    provider: openai
    model: gpt-5.2
proxy_host: 127.0.0.1
proxy_port: 8080
concurrency: 1
tasks:
  - "test task"
`);

		const config = loadConfig(configPath);

		assert.deepEqual(config.proxy, {
			host: "127.0.0.1",
			port: 8080,
		});
	});

	it("parses max_steps from config", () => {
		const configPath = writeTempConfig(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  runAgent:
    provider: openai
    model: gpt-5.2
  verifySuccess:
    provider: openai
    model: gpt-5.2
max_steps: 17
concurrency: 1
tasks:
  - "test task"
`);

		const config = loadConfig(configPath);

		assert.strictEqual(config.maxSteps, 17);
	});

	it("parses validator retry lifecycle from config", () => {
		const configPath = writeTempConfig(`
stage_llms:
  findTargetURL: { provider: openai, model: gpt-5.2 }
  createChecklist: { provider: openai, model: gpt-5.2 }
  runAgent: { provider: openai, model: gpt-5.2 }
  verifySuccess: { provider: openai, model: gpt-5.2 }
validator_lifecycle:
  mode: retry
  max_failures: 2
  context: compact
concurrency: 1
tasks:
  - "test task"
`);

		const config = loadConfig(configPath);

		assert.deepEqual(config.validatorLifecycle, {
			mode: "retry",
			maxFailures: 2,
			context: "compact",
		});
	});

	it("resolves task checklist stage from global defaults", () => {
		const configPath = writeTempConfig(`
provider: openai
model: gpt-5.2
reasoning_effort: low
feature_flags:
  task_checklist: true
concurrency: 1
tasks:
  - "test task"
`);
		const config = loadConfig(configPath);
		assert.isTrue(config.featureFlags.taskChecklist);
		assert.strictEqual(config.stageLLMs.createChecklist.model, "gpt-5.4");
		assert.strictEqual(config.stageLLMs.createChecklist.reasoningEffort, "low");
	});

	it("rejects the removed createPlan stage", () => {
		const error = captureLoadConfigFailure(`
provider: openai
model: gpt-5.2
reasoning_effort: low
stage_llms:
  createPlan: { provider: openai, model: gpt-5.2 }
concurrency: 1
tasks:
  - "test task"
`);
		assert.include(error, "createPlan stage has been removed");
	});

	it("rejects the removed create_plan stage alias", () => {
		const error = captureLoadConfigFailure(`
provider: openai
model: gpt-5.2
reasoning_effort: low
stage_llms:
  create_plan: { provider: openai, model: gpt-5.2 }
concurrency: 1
tasks:
  - "test task"
`);
		assert.include(error, "stage LLM overrides.create_plan");
		assert.include(error, "createPlan stage has been removed");
	});

	for (const removedStage of [
		"dismissCookieBanner",
		"dismiss_cookie_banner",
	]) {
		it(`rejects the removed ${removedStage} stage`, () => {
			const error = captureLoadConfigFailure(`
provider: openai
model: gpt-5.2
reasoning_effort: low
stage_llms:
  ${removedStage}: { provider: openai, model: gpt-5.2 }
concurrency: 1
tasks:
  - "test task"
`);
			assert.include(error, `stage LLM overrides.${removedStage}`);
			assert.include(error, "dismissCookieBanner stage has been removed");
		});
	}

	for (const removedFlag of [
		"dismiss_cookie_banner",
		"dismissCookieBanner",
		"website_apification_tools",
		"websiteAPIficationTools",
	]) {
		it(`rejects the removed ${removedFlag} feature flag`, () => {
			const error = captureLoadConfigFailure(`
provider: openai
model: gpt-5.2
reasoning_effort: low
feature_flags:
  ${removedFlag}: false
concurrency: 1
tasks:
  - "test task"
`);
			assert.include(error, `feature_flags.${removedFlag} has been removed`);
			assert.include(error, "permanently disabled");
		});
	}

	it("rejects validator lifecycle limits above three", () => {
		const error = captureLoadConfigFailure(`
stage_llms:
  findTargetURL: { provider: openai, model: gpt-5.2 }
  createChecklist: { provider: openai, model: gpt-5.2 }
  runAgent: { provider: openai, model: gpt-5.2 }
  verifySuccess: { provider: openai, model: gpt-5.2 }
validator_lifecycle:
  mode: retry
  max_failures: 4
concurrency: 1
tasks:
  - "test task"
`);

		assert.include(error, "integer from 1 to 3");
	});

	it("parses task object URLs from config", () => {
		const configPath = writeTempConfig(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  runAgent:
    provider: openai
    model: gpt-5.2
  verifySuccess:
    provider: openai
    model: gpt-5.2
concurrency: 1
tasks:
  - task: "test task"
    url: about:blank
`);

		const config = loadConfig(configPath);

		assert.deepEqual(config.tasks, [{ task: "test task", url: "about:blank" }]);
	});

	it("keeps legacy string task entries supported", () => {
		const configPath = writeTempConfig(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  runAgent:
    provider: openai
    model: gpt-5.2
  verifySuccess:
    provider: openai
    model: gpt-5.2
concurrency: 1
tasks:
  - "test task"
`);

		const config = loadConfig(configPath);

		assert.deepEqual(config.tasks, [{ task: "test task" }]);
	});

	it("rejects top-level default_url from config", () => {
		const errorOutput = captureLoadConfigFailure(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  runAgent:
    provider: openai
    model: gpt-5.2
  verifySuccess:
    provider: openai
    model: gpt-5.2
default_url: about:blank
concurrency: 1
tasks:
  - "test task"
`);

		assert.include(errorOutput, "Invalid default_url");
	});

	it("rejects invalid task objects", () => {
		const errorOutput = captureLoadConfigFailure(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  runAgent:
    provider: openai
    model: gpt-5.2
  verifySuccess:
    provider: openai
    model: gpt-5.2
concurrency: 1
tasks:
  - url: about:blank
`);

		assert.include(errorOutput, "Invalid tasks[0].task");
	});

	it("rejects empty task URLs", () => {
		const errorOutput = captureLoadConfigFailure(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  runAgent:
    provider: openai
    model: gpt-5.2
  verifySuccess:
    provider: openai
    model: gpt-5.2
concurrency: 1
tasks:
  - task: "test task"
    url: ""
`);

		assert.include(errorOutput, "Invalid tasks[0].url");
	});

	it("parses an explicit file_workspace_root from config", () => {
		const configPath = writeTempConfig(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  runAgent:
    provider: openai
    model: gpt-5.2
  verifySuccess:
    provider: openai
    model: gpt-5.2
download_dir: /tmp/browser-downloads
file_workspace_root: /tmp/browser-workspace
executable_path: /tmp/browser-chrome
concurrency: 1
tasks:
  - "test task"
`);

		const config = loadConfig(configPath);

		assert.strictEqual(config.downloadDir, "/tmp/browser-downloads");
		assert.strictEqual(config.fileWorkspaceRoot, "/tmp/browser-workspace");
		assert.strictEqual(config.executablePath, "/tmp/browser-chrome");
	});

	it("falls back to download_dir as the file workspace root", () => {
		const configPath = writeTempConfig(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  runAgent:
    provider: openai
    model: gpt-5.2
  verifySuccess:
    provider: openai
    model: gpt-5.2
download_dir: /tmp/browser-workspace
concurrency: 1
tasks:
  - "test task"
`);

		const config = loadConfig(configPath);

		assert.strictEqual(config.downloadDir, "/tmp/browser-workspace");
		assert.strictEqual(config.fileWorkspaceRoot, "/tmp/browser-workspace");
	});

	it("defaults download_dir to a downloads subdirectory under file_workspace_root", () => {
		const configPath = writeTempConfig(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  runAgent:
    provider: openai
    model: gpt-5.2
  verifySuccess:
    provider: openai
    model: gpt-5.2
file_workspace_root: /tmp/browser-workspace
concurrency: 1
tasks:
  - "test task"
`);

		const config = loadConfig(configPath);

		assert.strictEqual(config.downloadDir, "/tmp/browser-workspace/downloads");
		assert.strictEqual(config.fileWorkspaceRoot, "/tmp/browser-workspace");
	});

	it("parses seeded browser profile config and resolves relative paths", () => {
		const configPath = writeTempConfig(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  runAgent:
    provider: openai
    model: gpt-5.2
  verifySuccess:
    provider: openai
    model: gpt-5.2
browser_profiles:
  mode: seeded
  seed_user_data_dir: ./seed-profile
  per_worker_user_data_root: ./worker-profiles
  reuse_existing_worker_profiles: true
concurrency: 1
tasks:
  - "test task"
`);

		const config = loadConfig(configPath);
		const configDir = path.dirname(configPath);

		assert.deepEqual(config.browserProfiles, {
			mode: "seeded",
			seedUserDataDir: path.join(configDir, "seed-profile"),
			perWorkerUserDataRoot: path.join(configDir, "worker-profiles"),
			reuseExistingWorkerProfiles: true,
		});
	});

	it("rejects unsupported browser profile modes", () => {
		const errorOutput = captureLoadConfigFailure(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  runAgent:
    provider: openai
    model: gpt-5.2
  verifySuccess:
    provider: openai
    model: gpt-5.2
browser_profiles:
  mode: shared
  seed_user_data_dir: ./seed-profile
  per_worker_user_data_root: ./worker-profiles
concurrency: 1
tasks:
  - "test task"
`);

		assert.include(errorOutput, 'Supported mode is "seeded"');
	});

	it("does not assume an unpublished default config", () => {
		const args = parseArgs(["node", "src/index.ts"]);
		assert.isUndefined(args.config);
		assert.isFalse(args.help);
		assert.isFalse(args.rpc);
		assert.isFalse(args.version);
		assert.isFalse(args.versionJson);
	});

	it("loads named configs from an external config directory", () => {
		const configPath = writeTempConfig(`
provider: openai
model: gpt-5.4
concurrency: 1
tasks:
  - "test task"
`);
		const originalConfigDir = process.env.BROWSER_AGENT_CONFIG_DIR;
		process.env.BROWSER_AGENT_CONFIG_DIR = path.dirname(configPath);

		try {
			const config = loadConfig("config");
			assert.deepEqual(config.tasks, [{ task: "test task" }]);
		} finally {
			if (originalConfigDir === undefined) {
				delete process.env.BROWSER_AGENT_CONFIG_DIR;
			} else {
				process.env.BROWSER_AGENT_CONFIG_DIR = originalConfigDir;
			}
		}
	});

	it("parses --rpc before or after the config path", () => {
		assert.deepEqual(
			parseArgs(["node", "src/cli.ts", "--rpc", "custom.yaml"]),
			{
				config: "custom.yaml",
				help: false,
				rpc: true,
				version: false,
				versionJson: false,
			},
		);
		assert.deepEqual(
			parseArgs(["node", "src/cli.ts", "custom.yaml", "--rpc"]),
			{
				config: "custom.yaml",
				help: false,
				rpc: true,
				version: false,
				versionJson: false,
			},
		);
	});

	it("parses --version-json without treating it as a config path", () => {
		assert.deepEqual(parseArgs(["node", "src/cli.ts", "--version-json"]), {
			config: undefined,
			help: false,
			rpc: false,
			version: false,
			versionJson: true,
		});
	});

	it("parses standard help and version options", () => {
		assert.isTrue(parseArgs(["node", "src/cli.ts", "--help"]).help);
		assert.isTrue(parseArgs(["node", "src/cli.ts", "-h"]).help);
		assert.isTrue(parseArgs(["node", "src/cli.ts", "--version"]).version);
		assert.isTrue(parseArgs(["node", "src/cli.ts", "-V"]).version);
	});

	it("parses the auth field encryption command", () => {
		assert.deepEqual(
			parseArgs(["node", "src/cli.ts", "encrypt", "value-to-encrypt"]),
			{
				encryptValue: "value-to-encrypt",
				help: false,
				rpc: false,
				version: false,
				versionJson: false,
			},
		);
		assert.throws(
			() => parseArgs(["node", "src/cli.ts", "encrypt"]),
			/expects exactly one value/,
		);
		assert.throws(
			() => parseArgs(["node", "src/cli.ts", "encrypt", "   "]),
			/requires a non-empty value/,
		);
		assert.throws(
			() => parseArgs(["node", "src/cli.ts", "encrypt", "first", "second"]),
			/expects exactly one value/,
		);
	});

	it("parses the Codex login command", () => {
		assert.deepEqual(parseArgs(["node", "src/cli.ts", "codex-login"]), {
			codexLogin: true,
			codexLoginCheck: false,
			help: false,
			rpc: false,
			version: false,
			versionJson: false,
		});
		assert.throws(
			() => parseArgs(["node", "src/cli.ts", "codex-login", "extra"]),
			/only accepts the optional --check flag/,
		);
		assert.deepEqual(
			parseArgs(["node", "src/cli.ts", "codex-login", "--check"]),
			{
				codexLogin: true,
				codexLoginCheck: true,
				help: false,
				rpc: false,
				version: false,
				versionJson: false,
			},
		);
	});

	it("parses the auth encryption key generation command", () => {
		assert.deepEqual(parseArgs(["node", "src/cli.ts", "generate-key"]), {
			generateKey: true,
			help: false,
			rpc: false,
			version: false,
			versionJson: false,
		});
		assert.throws(
			() => parseArgs(["node", "src/cli.ts", "generate-key", "extra"]),
			/does not accept arguments/,
		);
	});

	it("rejects unknown options and multiple config paths", () => {
		assert.throws(
			() => parseArgs(["node", "src/cli.ts", "--unknown"]),
			/Unknown option: --unknown/,
		);
		assert.throws(
			() => parseArgs(["node", "src/cli.ts", "one.yaml", "two.yaml"]),
			/Expected one config path/,
		);
	});

	it("parses retry-until-success task attempt limits", () => {
		const configPath = writeTempConfig(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  runAgent:
    provider: openai
    model: gpt-5.2
  verifySuccess:
    provider: openai
    model: gpt-5.2
task_until_success_max_attempts: 5
concurrency: 1
tasks:
  - "test task"
`);

		const config = loadConfig(configPath);
		assert.strictEqual(config.taskUntilSuccessMaxAttempts, 5);
		assert.strictEqual(config.taskRuns, 1);
	});

	it("rejects combining retry-until-success mode with task_runs > 1", () => {
		const errorOutput = captureLoadConfigFailure(`
stage_llms:
  findTargetURL:
    provider: openai
    model: gpt-5.2
  createChecklist:
    provider: openai
    model: gpt-5.2
  runAgent:
    provider: openai
    model: gpt-5.2
  verifySuccess:
    provider: openai
    model: gpt-5.2
task_runs: 3
task_until_success_max_attempts: 5
concurrency: 1
tasks:
  - "test task"
`);

		assert.include(
			errorOutput,
			"task_until_success_max_attempts cannot be combined with task_runs > 1",
		);
	});

	it("createDefaultCoreDeps applies config feature flags to runtime state", () => {
		const originalTaskChecklist = configFeatureFlags.taskChecklist;
		const originalPreStepScreenshot =
			configFeatureFlags.preStepScreenshotInLatestUserPrompt;
		const originalUserTakeover = configFeatureFlags.userTakeoverTool;
		const originalAuthTakeover = configFeatureFlags.authTakeover;
		const originalAgentTakeover = configFeatureFlags.agentTakeoverTool;
		const originalExtractDataWholeContext =
			configFeatureFlags.extractDataWholeContext;
		const originalSemanticProjectionHistory =
			configFeatureFlags.semanticProjectionHistory;
		const originalOpenAIEncryptedResponses =
			configFeatureFlags.openAIEncryptedResponses;
		const originalOpenAIExplicitPromptCaching =
			configFeatureFlags.openAIExplicitPromptCaching;
		try {
			const deps = createDefaultCoreDeps({
				featureFlags: {
					taskChecklist: false,
					preStepScreenshotInLatestUserPrompt: true,
					userTakeoverTool: false,
					authTakeover: true,
					agentTakeoverTool: true,
					extractDataWholeContext: true,
					semanticProjectionHistory: "current",
					openAIEncryptedResponses: false,
					openAIExplicitPromptCaching: false,
					optimizeExecutorStepDelays: false,
					optimizeTextInput: false,
				},
			});

			assert.deepEqual(deps.featureFlags, {
				taskChecklist: false,
				preStepScreenshotInLatestUserPrompt: true,
				userTakeoverTool: false,
				authTakeover: true,
				agentTakeoverTool: true,
				extractDataWholeContext: true,
				semanticProjectionHistory: "current",
				openAIEncryptedResponses: false,
				openAIExplicitPromptCaching: false,
				optimizeExecutorStepDelays: false,
				optimizeTextInput: false,
			});
			assert.deepEqual(configFeatureFlags, deps.featureFlags);
		} finally {
			configFeatureFlags.taskChecklist = originalTaskChecklist;
			configFeatureFlags.preStepScreenshotInLatestUserPrompt =
				originalPreStepScreenshot;
			configFeatureFlags.userTakeoverTool = originalUserTakeover;
			configFeatureFlags.authTakeover = originalAuthTakeover;
			configFeatureFlags.agentTakeoverTool = originalAgentTakeover;
			configFeatureFlags.extractDataWholeContext =
				originalExtractDataWholeContext;
			configFeatureFlags.semanticProjectionHistory =
				originalSemanticProjectionHistory;
			configFeatureFlags.openAIEncryptedResponses =
				originalOpenAIEncryptedResponses;
			configFeatureFlags.openAIExplicitPromptCaching =
				originalOpenAIExplicitPromptCaching;
		}
	});
});
