# Browser Agent TypeScript SDK

TypeScript SDK for the Browser Agent CLI.

## Getting started

Requires Node.js 20 or newer, Chrome or a compatible Chromium installation,
and a provider API key unless using `vllm`.

```sh
npm install @visnia/browser-agent-sdk
```

```ts
import { BrowserAgent, type BrowserAgentTask } from "@visnia/browser-agent-sdk";

const agent = new BrowserAgent({
	provider: "openai",
	model: "gpt-5.4",
	downloadDirectory: "./downloads",
});

const task: BrowserAgentTask = {
	task: "Find the first five articles on the OpenAI blog.",
	url: "https://openai.com/news/",
};
```

## Agent configuration

```ts
interface BrowserAgentOptions {
	provider: Provider;
	model: string;
	downloadDirectory: string;
	reasoningEffort?: ReasoningEffort;
	apiKey?: string;
	endpointUrl?: string;
	openrouterProvider?: string;
	maxModelLen?: number;
	reserveOutputTokens?: number;
	headless?: boolean;
	executablePath?: string;
	workspaceDirectory?: string;
	browserProfileDirectory?: string;
	userTakeoverTool?: boolean;
	maxSteps?: number;
	concurrency?: number;
	runsPerTask?: number;
	retryCount?: number;
}
```

| Option                    | Default                       | Description                                                                      |
| ------------------------- | ----------------------------- | -------------------------------------------------------------------------------- |
| `provider`                | Required                      | Model provider.                                                                  |
| `model`                   | Required                      | Non-empty provider model identifier.                                             |
| `downloadDirectory`       | Required                      | Download directory; relative paths resolve from the current working directory.   |
| `reasoningEffort`         | Model-dependent               | Required when the SDK has no built-in capability information for the model.      |
| `apiKey`                  | Provider environment variable | API key for the model provider; whitespace-only values are ignored.              |
| `endpointUrl`             | —                             | Absolute HTTP(S) endpoint; required for `vllm`.                                  |
| `openrouterProvider`      | —                             | OpenRouter inference provider to require, with fallbacks disabled.               |
| `maxModelLen`             | `48000`                       | Positive model context limit used by prompt budgeting across every LLM stage.    |
| `reserveOutputTokens`     | `4000`                        | Positive output-token allowance reserved inside the model context limit.         |
| `headless`                | `false`                       | Run Chromium without a visible window.                                           |
| `executablePath`          | System Chromium               | Chrome or compatible Chromium executable.                                        |
| `workspaceDirectory`      | Temporary directory           | Agent file workspace; relative paths resolve from the current working directory. |
| `browserProfileDirectory` | —                             | Seed Chrome user-data directory copied into isolated worker profiles.            |
| `userTakeoverTool`        | `false`                       | Allow the agent to request user intervention.                                    |
| `maxSteps`                | `50`                          | Positive integer maximum step count.                                             |
| `concurrency`             | `8`                           | Positive integer maximum concurrent task count.                                  |
| `runsPerTask`             | `1`                           | Positive integer number of executions per task.                                  |
| `retryCount`              | `2`                           | Non-negative integer retry count per failed task execution.                      |

### Providers and reasoning

```ts
type Provider =
	| "openai"
	| "vllm"
	| "together"
	| "anthropic"
	| "google"
	| "openrouter";

type ReasoningEffort =
	| "none"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max"
	| "enabled";
```

| Provider and model                                                                             | API-key environment     | Reasoning values                                    | Default   |
| ---------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------- | --------- |
| OpenAI `gpt-5.4`, `gpt-5.4-mini`, or `gpt-5.5`                                                | `OPENAI_API_KEY`        | `none`, `minimal`, `low`, `medium`, `high`          | `low`     |
| OpenAI `gpt-5.6-luna`, `gpt-5.6-terra`, or `gpt-5.6-sol`                                      | `OPENAI_API_KEY`        | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | `low`     |
| Together `zai-org/GLM-5.2`                                                                     | `TOGETHER_API_KEY`      | `none`, `high`, `max`                               | `high`    |
| vLLM model containing `qwen`                                                                   | Optional `VLLM_API_KEY` | `none`, `enabled`                                   | `enabled` |
| vLLM model containing `glm`                                                                    | Optional `VLLM_API_KEY` | `none`, `high`, `max`                               | `high`    |
| Anthropic models                                                                               | `ANTHROPIC_API_KEY`     | Any `ReasoningEffort`                               | Required  |
| Google models                                                                                  | `GOOGLE_API_KEY`        | Any `ReasoningEffort`                               | Required  |
| OpenRouter models                                                                              | `OPENROUTER_API_KEY`    | `none`, `minimal`, `low`, `medium`, `high`, `xhigh` | Required  |

`vllm` additionally requires `endpointUrl`.

The SDK applies the selected model, endpoint, reasoning effort, and prompt budget
to every execution stage. Target-URL discovery uses `none` reasoning. The default
runtime profile enables checklist and whole-context extraction with full retry
verification, and disables workflow orchestration, incremental DOM history,
cookie dismissal and pre-step screenshots.

For OpenRouter, use its organization-prefixed model ID and provide an explicit reasoning effort:

```ts
const agent = new BrowserAgent({
	provider: "openrouter",
	model: "z-ai/glm-5.2",
	reasoningEffort: "xhigh",
	openrouterProvider: "baseten/fp8",
	downloadDirectory: "./downloads",
});
```

`openrouterProvider` is valid only with `provider: "openrouter"`. It restricts
OpenRouter routing to that provider and disables fallbacks.
Exact endpoint IDs such as `baseten/fp8` are passed through unchanged.

## Task configuration

```ts
type BrowserAgentTask = {
	task: string;
	url?: string;
	credentials?: readonly BrowserAgentCredential[];
};

type BrowserAgentCredential = {
	username: string;
	password: string;
	domain: string;
};
```

| Field         | Description                                                |
| ------------- | ---------------------------------------------------------- |
| `task`        | Required, non-empty natural-language instruction.          |
| `url`         | Optional starting URL.                                     |
| `credentials` | Optional website login credentials available to this task. |

Credentials are login details for a website the task may need to access. They
are distinct from `apiKey`, which authenticates with the model provider. Each
credential contains:

| Field      | Description                                                                           |
| ---------- | ------------------------------------------------------------------------------------- |
| `username` | Non-empty website account identifier, such as a username or email address.            |
| `password` | Non-empty password for the website account.                                           |
| `domain`   | Domain or origin the credential belongs to, used to scope it to the intended website. |

```ts
const task: BrowserAgentTask = {
	task: "Open my account.",
	url: "https://example.com",
	credentials: [
		{
			username: "person@example.com",
			password: process.env.EXAMPLE_PASSWORD!,
			domain: "https://example.com",
		},
	],
};
```

`BrowserAgent.run()` accepts one `BrowserAgentTask` or a non-empty readonly
array of tasks.
