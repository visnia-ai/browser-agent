# AGENTS.md

## Architecture

- Keep reusable `src/core/` APIs configurable through explicit typed inputs and dependency injection. Do not make core entrypoints depend on YAML files, CLI arguments, or implicit environment configuration.
- Keep CLI YAML parsing and validation centralized in `src/utils.ts` (`loadConfig`).
- Expose new public core surfaces through `src/core/index.ts` and `src/core/types.ts`.
- Route provider execution through `src/agents/providers/ai-sdk.ts`; do not add provider-specific router implementations.
- Put runtime-configurable flags in `src/config-feature-flags.ts` and internal static flags in `src/featureFlags.ts`.

## Model and Projection Contracts

- The harness uses only the canonical semantic projection from `src/browser/semantic-projection.ts`; do not add alternate semantic serializers or simplified-DOM fallbacks.
- Actions targeting page elements must use opaque `ref` values from the current canonical semantic projection and resolve them through the semantic ref registry.
- Keep the standalone simplified-DOM library isolated under `src/browser/simplify-dom.ts` and `src/browser/simplify-dom-utils/`. Canonical harness code in `src/agents/`, `src/core/`, and `src/auth/` must not import it or depend on its identifiers.
- Changes to semantic projection structure must preserve ref extraction, action resolution, projection-history reconstruction, and prompt contracts.

## Authentication Safety

- Treat changes to auth runtime, executor integration, prompts, config parsing, or auth input handling as security-sensitive.
- Never expose real credentials to a model, prompt payload, screenshot, semantic projection, history, logs, thrown errors, or serialized results.
- Match the current URL to a configured auth domain before decrypting its identifier or password. Keep domain, identifier, and password encrypted independently.
- Plaintext credentials are allowed only at direct runtime entrypoints and must be encrypted immediately. YAML configuration must accept encrypted credentials only.
- Models may inspect only the redacted semantic projection to identify auth controls. Credential lookup, entry, and submission must remain in runtime code.
- Keep protected auth refs redacted and suppress screenshots while sensitive values may be present.
- When automated auth cannot proceed safely, return it as unhandled and use manual takeover only when enabled.
- Cover auth behavior changes with unit tests and maintain or extend the local fixture/e2e coverage.

## Verification and Dependencies

- Run semantic projection and action-resolution tests after canonical projection changes. Run the isolated simplified-DOM tests after changes to that library.
- For planner or executor contract changes, run focused unit tests and relevant e2e coverage.
