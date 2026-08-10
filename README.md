# Browser Agent

A powerful & efficient browser agent that automates any task on the web.

---

## Table of contents

- [Requirements](#requirements)
- [Install & Use](#install--use)
  - [Providers](#providers)
- [Recommended model](#recommended-model)
- [SDKs](#sdks)
  - [TypeScript](#typescript)
  - [Python](#python)
- [Credentials](#credentials)
- [License](#license)



## Requirements

- Node.js (v20 or later) and npm
- Google Chrome or a compatible Chromium installation
- An API key for the configured model provider, except when using vLLM or Codex. Supported providers include OpenAI, OpenRouter, Anthropic, Google, Together, Codex, and vLLM-compatible endpoints.
- For `codex`, the [Codex CLI](https://github.com/openai/codex) installed on `PATH` (`npm install -g @openai/codex`). Browser Agent uses its ChatGPT OAuth session instead of an API key.

## Benchmarks

<table>
  <thead>
    <tr>
      <th rowspan="2">Metric</th>
      <th colspan="4">BrowserUse Bench</th>
      <th colspan="2">BrowseWebApp Bench</th>
    </tr>
    <tr>
      <th>Ours</th>
      <th>Browser-code</th>
      <th><a href="https://github.com/browser-use/benchmark/blob/main/official_results/BrowserUse_0.13.7_browser_BrowserUseCloud_model_gpt-5.6-luna.json">Browser Use</a></th>
      <th><a href="https://github.com/browser-use/benchmark/blob/main/official_results/BrowserUseCloudAPI_v4_browser_integrated_model_bu-v4-luna.json">Browser Cloud v4</a></th>
      <th>Ours</th>
      <th>Browser-code</th>
    </tr>
  </thead>
  <tbody>
    <tr><th>Model</th><td>gpt-5.6-luna</td><td>gpt-5.6-luna</td><td>gpt-5.6-luna</td><td>bu-v4-luna</td><td>gpt-5.6-luna</td><td>gpt-5.6-luna</td></tr>
    <tr><th>Reasoning effort</th><td>xhigh</td><td>xhigh</td><td>xhigh</td><td>-</td><td>high</td><td>high</td></tr>
    <tr><th>Success</th><td><strong>88%</strong></td><td>78%</td><td>31%</td><td>78%</td><td><strong>76%</strong></td><td>64%</td></tr>
    <tr><th>Duration (seconds)</th><td>32,694</td><td>47,970</td><td><strong>6,787</strong></td><td>24,505</td><td><strong>15,653</strong></td><td>32,036</td></tr>
    <tr><th>Cost</th><td><strong>$5.37</strong></td><td>$8.34</td><td>-</td><td>$6.31</td><td><strong>$3.73</strong></td><td>$7.45</td></tr>
    <tr><th>Successful tasks / $</th><td><strong>16.40</strong></td><td>9.35</td><td>-</td><td>12.37</td><td><strong>18.77</strong></td><td>8.86</td></tr>
  </tbody>
</table>

## Install & Use

Install the CLI globally with npm. This does not require cloning the repository; the installer downloads and verifies the matching binary for your platform.

```sh
npm install -g @visnia/browser-agent-sdk
```



### Providers

Set the environment variables for your selected model provider:


| Provider   | Environment variables |
| ---------- | --------------------- |
| OpenAI     | `OPENAI_API_KEY`      |
| Anthropic  | `ANTHROPIC_API_KEY`   |
| Google     | `GOOGLE_API_KEY`      |
| Together   | `TOGETHER_API_KEY`    |
| OpenRouter | `OPENROUTER_API_KEY`  |
| Codex      | Codex CLI OAuth login |
| vLLM       | `VLLM_BASE_URL`       |


Create a configuration file:

```yaml
provider: openai
model: gpt-5.6-sol
reasoning_effort: medium
tasks:
  - task: "Find the first five articles on the OpenAI blog."
    url: "https://openai.com/news/"
```

Set the required provider variables shown above, then run:

```sh
browser-agent path/to/config.yaml
```

To use your ChatGPT account through Codex, install the Codex CLI and select the
`codex` provider. No API key or endpoint override is accepted:

```yaml
provider: codex
model: gpt-5.6-luna
reasoning_effort: xhigh
tasks:
  - task: "Find the first five articles on the OpenAI blog."
    url: "https://openai.com/news/"
```

Browser Agent checks the Codex CLI login before starting the run. If login is
required, it prints an OAuth URL in the terminal; open it in a browser and
complete the flow, then the localhost callback resumes the run automatically.
Existing Codex credentials under `CODEX_HOME` (or `~/.codex`) are reused.
Orchestrators that will start several Browser Agent processes can run
`browser-agent codex-login` once first. The command performs authentication
without starting Chrome or a browser task.
Use `browser-agent codex-login --check` for a non-interactive status probe; it
prints `{"loggedIn":true}` or `{"loggedIn":false}` as JSON and never starts
OAuth.

The Codex provider sends requests to
`https://chatgpt.com/backend-api/codex/responses`. This is a private, unstable
ChatGPT backend contract and may change without notice.



## Recommended model

We recommend using GPT 5.6 Luna, with reasoning effort set to `xhigh`, through OpenAI directly:

```yaml
provider: openai
model: gpt-5.6-luna
reasoning_effort: xhigh
```

or OpenRouter:

```yaml
provider: openrouter
model: openai/gpt-5.6-luna
reasoning_effort: xhigh
```



## SDKs

Browser Agent provides TypeScript and Python SDKs for running browser automation tasks. Both SDKs install the matching CLI from the GitHub Release, verify its checksum, stream progress events, and return a final result.

Set the selected provider's API-key environment variable, such as `OPENAI_API_KEY` or `OPENROUTER_API_KEY`, or pass the API key directly when creating the agent. Codex instead uses the installed Codex CLI and its terminal OAuth flow.

### TypeScript

Requires Node.js 20 or newer.

```sh
npm install @visnia/browser-agent-sdk
```

```ts
import { BrowserAgent } from "@visnia/browser-agent-sdk";

const agent = new BrowserAgent({
	provider: "openai",
	model: "gpt-5.4",
	downloadDirectory: "./downloads",
});

const run = agent.run({
	task: "Find the first five articles on the OpenAI blog.",
	url: "https://openai.com/news/",
});

for await (const event of run.events()) {
	console.log(event);
}

const result = await run.result;
```

See the [TypeScript SDK documentation](./sdk/typescript-sdk/README.md).

### Python

Requires Python 3.11 or newer.

```sh
pip install browser-agent-python-sdk
```

```python
import asyncio

from browser_agent import BrowserAgent, BrowserAgentTask


async def main():
    agent = BrowserAgent(
        provider="openai",
        model="gpt-5.4",
        download_directory="./downloads",
    )

    run = agent.run(
        BrowserAgentTask(
            "Find the first five articles on the OpenAI blog.",
            "https://openai.com/news/",
        )
    )

    async for event in run.events():
        print(event)

    result = await run.result


asyncio.run(main())
```

See the [Python SDK documentation](./sdk/python-sdk/README.md).

## Credentials

For web tasks that require authentication, provide credentials in the YAML to allow the agent to login:

- The agent identifies the text boxes for email/username and password, and delegates entering credentials to a script, so that your credentials are never exposed to model providers
- Always encrypt credentials in the YAML config, so that your coding agents don't leak them to model providers.

Generate a base64-encoded 32-byte encryption key:

```sh
browser-agent generate-key
```

Keep this key secret and reuse the same value when encrypting and decrypting the credential fields.

After setting `BROWSER_AGENT_AUTH_ENCRYPTION_KEY`, encrypt a string with:

```sh
browser-agent encrypt "value-to-encrypt"
```

Run the command separately for the domain URL, username, and password, replacing `value-to-encrypt` each time.

```yaml
auth_credentials:
  mode: encrypted
  encrypted_domain_url: "bauth-v1:<encrypted-domain>"
  encrypted_username: "bauth-v1:<encrypted-username>"
  encrypted_password: "bauth-v1:<encrypted-password>"
```

For credentials passed through an SDK, see the task configuration sections in the [TypeScript SDK README](./sdk/typescript-sdk/README.md#task-configuration) and [Python SDK README](./sdk/python-sdk/README.md#task-configuration).

## License

[MIT](./LICENSE.md).
