# Browser Agent Python SDK

A powerful & efficient browser agent that automates any task on the web.

## Getting started

Requires Python 3.11 or newer, Chrome or a compatible Chromium installation,
and a provider API key unless using `vllm` or `codex`. Codex additionally
requires the [Codex CLI](https://github.com/openai/codex) on `PATH`.

```sh
pip install browser-agent-python-sdk
```

The distribution is named `browser-agent-python-sdk`; import it as
`browser_agent`.

The SDK downloads the matching Browser Agent CLI from its GitHub Release on
first use, verifies its SHA-256 checksum, and reuses it from the user cache.
Set `BROWSER_AGENT_CLI_PATH` to a preinstalled CLI executable for offline
environments, or `BROWSER_AGENT_CLI_CACHE_DIR` to choose the managed cache
location.

```python
from browser_agent import BrowserAgent, BrowserAgentTask

agent = BrowserAgent(
    provider="openai",
    model="gpt-5.4",
    download_directory="./downloads",
)

task = BrowserAgentTask(
    task="Find the first five articles on the OpenAI blog.",
    url="https://openai.com/news/",
)
```

## Agent configuration

All `BrowserAgent` constructor arguments are keyword-only.

| Option                      | Default                       | Description                                                                      |
| --------------------------- | ----------------------------- | -------------------------------------------------------------------------------- |
| `provider`                  | Required                      | Model provider.                                                                  |
| `model`                     | Required                      | Non-empty provider model identifier.                                             |
| `download_directory`        | Required                      | Download directory; relative paths resolve from the current working directory.   |
| `reasoning_effort`          | Model-dependent               | Required when the SDK has no built-in capability information for the model.      |
| `api_key`                   | Provider environment variable | API key for the model provider; forbidden for `codex`.                            |
| `endpoint_url`              | —                             | Absolute HTTP(S) endpoint; required for `vllm` and forbidden for `codex`.         |
| `openrouter_provider`       | —                             | OpenRouter inference provider to require, with fallbacks disabled.               |
| `max_model_len`             | `48000`                       | Positive model context limit used by prompt budgeting across every LLM stage.    |
| `reserve_output_tokens`     | `4000`                        | Positive output-token allowance reserved inside the model context limit.         |
| `headless`                  | `False`                       | Run Chromium without a visible window.                                           |
| `executable_path`           | System Chromium               | Chrome or compatible Chromium executable.                                        |
| `workspace_directory`       | Temporary directory           | Agent file workspace; relative paths resolve from the current working directory. |
| `browser_profile_directory` | —                             | Seed Chrome user-data directory copied into isolated worker profiles.            |
| `user_takeover_tool`        | `False`                       | Allow the agent to request user intervention.                                    |
| `max_steps`                 | `50`                          | Positive integer maximum step count.                                             |
| `concurrency`               | `8`                           | Positive integer maximum concurrent task count.                                  |
| `runs_per_task`             | `1`                           | Positive integer number of executions per task.                                  |
| `retry_count`               | `2`                           | Non-negative integer retry count per failed task execution.                      |

### Providers and reasoning

```python
Provider: TypeAlias = Literal[
    "openai", "vllm", "together", "anthropic", "google", "codex", "openrouter"
]

ReasoningEffort: TypeAlias = Literal[
    "none", "minimal", "low", "medium", "high", "xhigh", "max", "enabled"
]
```

| Provider and model                                                                             | API-key environment     | Reasoning values                                    | Default   |
| ---------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------- | --------- |
| OpenAI `gpt-5.4`, `gpt-5.4-mini`, or `gpt-5.5`                                                | `OPENAI_API_KEY`        | `none`, `minimal`, `low`, `medium`, `high`          | `low`     |
| OpenAI `gpt-5.6-luna`, `gpt-5.6-terra`, or `gpt-5.6-sol`                                      | `OPENAI_API_KEY`        | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | `low`     |
| Codex `gpt-5.4`, `gpt-5.4-mini`, or `gpt-5.5`                                                | Codex CLI OAuth         | `none`, `minimal`, `low`, `medium`, `high`          | `low`     |
| Codex `gpt-5.6-luna`, `gpt-5.6-terra`, or `gpt-5.6-sol`                                      | Codex CLI OAuth         | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | `low`     |
| Together `zai-org/GLM-5.2`                                                                     | `TOGETHER_API_KEY`      | `none`, `high`, `max`                               | `high`    |
| vLLM model containing `qwen`                                                                   | Optional `VLLM_API_KEY` | `none`, `enabled`                                   | `enabled` |
| vLLM model containing `glm`                                                                    | Optional `VLLM_API_KEY` | `none`, `high`, `max`                               | `high`    |
| Anthropic models                                                                               | `ANTHROPIC_API_KEY`     | Any `ReasoningEffort`                               | Required  |
| Google models                                                                                  | `GOOGLE_API_KEY`        | Any `ReasoningEffort`                               | Required  |
| OpenRouter models                                                                              | `OPENROUTER_API_KEY`    | `none`, `minimal`, `low`, `medium`, `high`, `xhigh` | Required  |

`vllm` additionally requires `endpoint_url`. Codex rejects `api_key` and
`endpoint_url`; it always uses the Codex CLI login and fixed ChatGPT backend.

Install the Codex CLI with `npm install -g @openai/codex`, then configure the
agent without an API key:

```python
agent = BrowserAgent(
    provider="codex",
    model="gpt-5.6-luna",
    reasoning_effort="xhigh",
    download_directory="./downloads",
)
```

Before launching several Codex-backed runs concurrently, perform one login
gate and relay its status messages:

```python
from browser_agent import ensure_codex_login

await ensure_codex_login(on_log=lambda entry: print(entry.message))
```

To check the same stored session without starting OAuth:

```python
from browser_agent import check_codex_login

if not await check_codex_login():
    raise RuntimeError("Run the interactive login command first")
```

If the user is not logged in, the SDK forwards the CLI's OAuth URL through the
existing `on_log` stderr events. Open the URL and complete login; the callback
resumes the run. `PATH` and `CODEX_HOME` are preserved for the child process.
Codex requests use `https://chatgpt.com/backend-api/codex/responses`, a private,
unstable backend contract that may change without notice.

The SDK applies the selected model, endpoint, reasoning effort, and prompt budget
to every execution stage. Target-URL discovery uses `none` reasoning. The default
runtime profile enables checklist and whole-context extraction with full retry
verification, and disables workflow orchestration, incremental DOM history,
cookie dismissal and pre-step screenshots.

For OpenRouter, use its organization-prefixed model ID and provide an explicit reasoning effort:

```python
agent = BrowserAgent(
    provider="openrouter",
    model="z-ai/glm-5.2",
    reasoning_effort="xhigh",
    openrouter_provider="baseten/fp8",
    download_directory="./downloads",
)
```

`openrouter_provider` is valid only with `provider="openrouter"`. It restricts
OpenRouter routing to that provider and disables fallbacks.
Exact endpoint IDs such as `baseten/fp8` are passed through unchanged.

## Task configuration

```python
@dataclass(frozen=True, slots=True)
class BrowserAgentTask:
    task: str
    url: str | None = None
    credentials: Sequence[BrowserAgentCredential] = ()


@dataclass(frozen=True, slots=True)
class BrowserAgentCredential:
    username: str
    password: str
    domain: str
```

| Field         | Description                                                |
| ------------- | ---------------------------------------------------------- |
| `task`        | Required, non-empty natural-language instruction.          |
| `url`         | Optional starting URL.                                     |
| `credentials` | Optional website login credentials available to this task. |

Credentials are login details for a website the task may need to access. They
are distinct from `api_key`, which authenticates with the model provider. Each
credential contains:

| Field      | Description                                                                           |
| ---------- | ------------------------------------------------------------------------------------- |
| `username` | Non-empty website account identifier, such as a username or email address.            |
| `password` | Non-empty password for the website account.                                           |
| `domain`   | Domain or origin the credential belongs to, used to scope it to the intended website. |

```python
import os

from browser_agent import BrowserAgentCredential, BrowserAgentTask

task = BrowserAgentTask(
    task="Open my account.",
    url="https://example.com",
    credentials=(
        BrowserAgentCredential(
            username="person@example.com",
            password=os.environ["EXAMPLE_PASSWORD"],
            domain="https://example.com",
        ),
    ),
)
```

`BrowserAgent.run()` accepts one `BrowserAgentTask` or a non-empty sequence of
tasks.
