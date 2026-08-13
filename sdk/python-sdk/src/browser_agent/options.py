from __future__ import annotations

import os
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from .errors import BrowserAgentError
from .models import (
    BrowserAgentCredential, BrowserAgentLogEntry, BrowserAgentTask, Provider,
    ReasoningEffort,
    ValidatorLifecycleMode,
)

PROVIDER_ENV: dict[Provider, str | None] = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "google": "GOOGLE_API_KEY",
    "together": "TOGETHER_API_KEY",
    "vllm": "VLLM_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "codex": None,
}
OPENROUTER_REASONING_EFFORTS = (
    "none", "minimal", "low", "medium", "high", "xhigh",
)
OPENAI = (
    "gpt-5.4", "gpt-5.4-mini", "gpt-5.5",
)
GPT_5_6 = (
    "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol",
)
CAPABILITIES = [
    *(("openai", model, False, ("none", "minimal", "low", "medium", "high"), "low")
      for model in OPENAI),
    *((
        "openai", model, False,
        ("none", "minimal", "low", "medium", "high", "xhigh", "max"), "low",
    ) for model in GPT_5_6),
    *(("codex", model, False, ("none", "minimal", "low", "medium", "high"), "low")
      for model in OPENAI),
    *((
        "codex", model, False,
        ("none", "minimal", "low", "medium", "high", "xhigh", "max"), "low",
    ) for model in GPT_5_6),
    ("together", "zai-org/GLM-5.2", False, ("none", "high", "max"), "high"),
    (
        "together", "deepseek-ai/DeepSeek-V4-Flash-0731", False,
        ("none", "low", "high", "max"), "high",
    ),
    ("vllm", "qwen", True, ("none", "enabled"), "enabled"),
    ("vllm", "glm", True, ("none", "high", "max"), "high"),
    (
        "vllm", "deepseek-ai/DeepSeek-V4-Flash-0731", False,
        ("none", "low", "high", "max"), "high",
    ),
]
@dataclass(frozen=True, slots=True)
class ResolvedOptions:
    provider: Provider
    model: str
    reasoning_effort: ReasoningEffort
    api_key: str | None
    api_key_environment: str | None
    endpoint_url: str | None
    openrouter_provider: str | None
    max_model_len: int
    reserve_output_tokens: int
    headless: bool
    executable_path: str | None
    download_directory: str
    workspace_directory: str | None
    browser_profile_directory: str | None
    user_takeover_tool: bool
    max_steps: int
    concurrency: int
    runs_per_task: int
    retry_count: int
    validator_lifecycle: ValidatorLifecycleMode
    on_log: Callable[[BrowserAgentLogEntry], None] | None
def invalid(message: str):
    raise BrowserAgentError("CONFIG_INVALID", message)
def positive(value: int | None, default: int) -> int:
    value = default if value is None else value
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        invalid("Execution limits must be positive integers.")
    return value
def reasoning(provider: Provider, model: str, effort: ReasoningEffort | None):
    capability = next(
        (item for item in CAPABILITIES if item[0] == provider and
         (item[1].lower() in model.lower() if item[2] else item[1] == model)),
        None,
    )
    if capability is None and provider in ("openai", "codex", "together", "vllm"):
        invalid(f"Unknown model '{model}' for '{provider}'.")
    resolved = effort or (capability[4] if capability else None)
    if resolved is None:
        invalid("reasoning_effort is required for this model.")
    if provider == "openrouter" and resolved not in OPENROUTER_REASONING_EFFORTS:
        invalid(f"Unsupported reasoning_effort '{resolved}' for OpenRouter.")
    if capability and resolved not in capability[3]:
        invalid(f"Unsupported reasoning_effort '{resolved}' for this model.")
    return resolved
def resolve_options(**values) -> ResolvedOptions:
    provider, model = values["provider"], values["model"]
    downloads = values["download_directory"]
    if provider not in PROVIDER_ENV:
        invalid(f"Unsupported provider '{provider}'.")
    if not isinstance(model, str) or not model.strip():
        invalid("model must be a non-empty string.")
    if not isinstance(downloads, str) or not downloads.strip():
        invalid("download_directory must be a non-empty string.")
    endpoint = values["endpoint_url"]
    if provider == "codex" and values["api_key"] is not None:
        invalid("api_key cannot be used with Codex.")
    if provider == "codex" and endpoint is not None:
        invalid("endpoint_url cannot be used with Codex.")
    if endpoint:
        parsed = urlparse(endpoint)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            invalid("endpoint_url must be an absolute HTTP(S) URL.")
    if provider == "vllm" and not endpoint:
        invalid("endpoint_url is required for vllm.")
    openrouter_provider = values["openrouter_provider"]
    if openrouter_provider is not None:
        if not isinstance(openrouter_provider, str) or not openrouter_provider.strip():
            invalid("openrouter_provider must be a non-empty string.")
        if provider != "openrouter":
            invalid("openrouter_provider can only be used with OpenRouter.")
        openrouter_provider = openrouter_provider.strip()
    environment = PROVIDER_ENV[provider]
    api_key = ((values["api_key"] or "").strip() or os.environ.get(environment)
               if environment else None)
    if provider not in ("vllm", "codex") and not api_key:
        invalid(f"Missing API key for provider '{provider}'.")
    retry = values["retry_count"]
    if isinstance(retry, bool) or not isinstance(retry, int) or retry < 0:
        invalid("retry_count must be an integer greater than or equal to zero.")
    validator_lifecycle = values["validator_lifecycle"]
    if validator_lifecycle not in ("retry", "disabled"):
        invalid("validator_lifecycle must be retry or disabled.")
    absolute = lambda value: str(Path(value).resolve()) if value else None
    max_model_len = positive(values["max_model_len"], 48_000)
    reserve_output_tokens = positive(values["reserve_output_tokens"], 4_000)
    if reserve_output_tokens >= max_model_len:
        invalid("reserve_output_tokens must be smaller than max_model_len.")
    return ResolvedOptions(
        provider, model.strip(), reasoning(provider, model.strip(), values["reasoning_effort"]),
        api_key, environment, endpoint, openrouter_provider,
        max_model_len, reserve_output_tokens, values["headless"],
        absolute(values["executable_path"]),
        absolute(downloads) or "", absolute(values["workspace_directory"]),
        absolute(values["browser_profile_directory"]),
        values["user_takeover_tool"], positive(values["max_steps"], 50),
        positive(values["concurrency"], 8), positive(values["runs_per_task"], 1),
        retry, validator_lifecycle, values["on_log"],
    )
def normalize_tasks(value: BrowserAgentTask | Sequence[BrowserAgentTask]):
    tasks = [value] if isinstance(value, BrowserAgentTask) else list(value)
    if not tasks:
        invalid("At least one task is required.")
    for item in tasks:
        if not isinstance(item, BrowserAgentTask) or not item.task.strip():
            invalid("Each task must contain a non-empty task string.")
        if item.url is not None and not item.url.strip():
            invalid("Task URLs must be non-empty strings.")
        if not isinstance(item.credentials, Sequence) or isinstance(item.credentials, str):
            invalid("Task credentials must be a sequence.")
        for credential in item.credentials:
            if not isinstance(credential, BrowserAgentCredential):
                invalid("Each credential must be a BrowserAgentCredential.")
            if not credential.username.strip():
                invalid("Credential usernames must be non-empty strings.")
            if not credential.password:
                invalid("Credential passwords must be non-empty strings.")
            if not credential.domain.strip():
                invalid("Credential domains must be non-empty strings.")
    return [
        BrowserAgentTask(
            item.task.strip(), item.url.strip() if item.url else None,
            tuple(BrowserAgentCredential(
                credential.username.strip(), credential.password, credential.domain.strip()
            ) for credential in item.credentials),
        )
        for item in tasks
    ]
def child_environment(options: ResolvedOptions) -> dict[str, str]:
    environment = {key: value for key, value in os.environ.items()
                   if key not in {name for name in PROVIDER_ENV.values() if name}}
    if options.api_key and options.api_key_environment:
        environment[options.api_key_environment] = options.api_key
    return environment
