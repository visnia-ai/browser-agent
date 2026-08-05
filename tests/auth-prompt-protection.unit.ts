import { assert } from "chai";
import { describe, it } from "mocha";
import { createSession, step } from "../src/core/index.js";
import {
	createAuthCredentialCallbacksFromInput,
	createSessionAuthTakeoverState,
} from "../src/auth/crypto.js";
import { createMockCoreDeps } from "./helpers/core-deps-fixtures.js";
import {
	currentAuthEncryptionKeyOrThrow,
	withAuthEncryptionKey,
} from "./helpers/auth-test-utils.js";
import { assertNoSecretLeaksInText } from "./helpers/auth-prompt-capture.js";

describe("auth prompt protection", () => {
	it("redacts managed auth refs and suppresses screenshots on protected auth pages", async () => {
		await withAuthEncryptionKey(async () => {
			const domOptions: Array<Record<string, unknown>> = [];
			let screenshotCalls = 0;
			const deps = createMockCoreDeps({
				getCurrentURL: async () => "https://login.example.com/sign-in",
				getPageProjection: async (_browser, options) => {
					domOptions.push({ ...(options ?? {}) });
					return 'input ref="u1" value="[REDACTED]"';
				},
				capturePreStepScreenshotDataUrl: async () => {
					screenshotCalls += 1;
					return "data:image/jpeg;base64,AAAA";
				},
			});
			await createSession(deps, { port: 9222, headless: true });

			const authTakeover = createSessionAuthTakeoverState({
				enabled: true,
				...createAuthCredentialCallbacksFromInput({
					credentials: {
						mode: "plaintext",
						domainUrl: "https://app.example.com/login",
						username: "user@example.com",
						password: "real-password",
					},
				}),
			})!;
			authTakeover.protectedRefs.add("u1");
			authTakeover.protectedRefs.add("p1");
			authTakeover.suppressScreenshots = true;
			deps.registry.get(9222)!.authTakeover = authTakeover;

			await step(deps, {
				mode: "create_prompt_for_step",
				port: 9222,
				userTask: "Log in safely",
				stepsHistory: [],
			});

			assert.deepEqual(domOptions, [
				{
					omitHrefs: true,
					redactInputRefs: ["u1", "p1"],
					redactPasswordInputs: true,
				},
			]);
			assert.strictEqual(screenshotCalls, 0);
		});
	});

	it("keeps auth secrets out of prompt payloads and replayed history after auth takeover state is active", async () => {
		await withAuthEncryptionKey(async () => {
			const secretDomain =
				"https://app.example.com/login?tenant=private-workspace";
			const secrets = [
				"ultra-secret-password",
				secretDomain,
				"private-workspace",
				currentAuthEncryptionKeyOrThrow(),
			];
			const deps = createMockCoreDeps({
				getCurrentURL: async () => "https://app.example.com/dashboard",
				getPageProjection: async () =>
					'input ref="u1" value="[REDACTED]"\ninput ref="p1" value="[REDACTED]"\ndiv: "Dashboard Ready"',
			});
			await createSession(deps, { port: 9222, headless: true });

			const authTakeover = createSessionAuthTakeoverState({
				enabled: true,
				...createAuthCredentialCallbacksFromInput({
					credentials: {
						mode: "plaintext",
						domainUrl: secretDomain,
						username: "secret-user@example.com",
						password: "ultra-secret-password",
					},
				}),
			})!;
			authTakeover.protectedRefs.add("u1");
			authTakeover.protectedRefs.add("p1");
			authTakeover.suppressScreenshots = true;
			deps.registry.get(9222)!.authTakeover = authTakeover;

			const result = await step(deps, {
				mode: "create_prompt_for_step",
				port: 9222,
				userTask: "Confirm the dashboard is ready",
				stepsHistory: [
					{
						payload: {
							currentURL: "https://app.example.com/login",
						},
						assistant: {
							thinking: "Authentication was completed securely.",
							actions: [],
							done: false,
						},
					},
				],
			});

			const promptText = JSON.stringify(result.prompt.messages);
			const payloadText = JSON.stringify(result.prompt.payload);
			const historyText = JSON.stringify(result.prompt.messages.slice(0, -1));
			assert.include(promptText, "secret-user@example.com");
			assert.strictEqual(
				(
					result.prompt.payload.authContext as
						{ usernameOrEmail?: string } | undefined
				)?.usernameOrEmail,
				"secret-user@example.com",
			);
			assertNoSecretLeaksInText(promptText, secrets);
			assertNoSecretLeaksInText(payloadText, secrets);
			assertNoSecretLeaksInText(historyText, secrets);
			assert.include(promptText, "[REDACTED]");
			assert.notInclude(promptText, 'value="secret-user@example.com"');
		});
	});
});
