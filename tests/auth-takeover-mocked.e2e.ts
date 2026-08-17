import * as fs from "node:fs";
import * as path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { assert } from "chai";
import { after, before, describe, it } from "mocha";
import { __setProviderOverrideForTests } from "../src/agents/providers/ai-sdk.js";
import type { LLMOptions } from "../src/agents/types.js";
import {
	configFeatureFlags,
	mergeConfigFeatureFlags,
	setConfigFeatureFlags,
	type ConfigFeatureFlags,
} from "../src/config-feature-flags.js";
import { createDefaultCoreDeps } from "../src/core/deps.js";
import { closeSession, runAgent } from "../src/core/index.js";
import { createAuthCredentialCallbacksFromInput } from "../src/auth/crypto.js";
import {
	currentAuthEncryptionKeyOrThrow,
	withAuthEncryptionKey,
} from "./helpers/auth-test-utils.js";
import {
	assertNoSecretLeaksInCapturedCalls,
	createCapturedOpenAIClient,
	extractPromptTextFromOpenAIInput,
} from "./helpers/auth-prompt-capture.js";

const ACCEPTED_USERNAME = "operator@example.com";
const ACCEPTED_PASSWORD = "correct-horse-battery-staple";
const HTML_FILE = "auth-takeover-fixture.html";
const JS_FILE = "auth-takeover-fixture.js";

function randomPort(seed: number): number {
	return 20000 + seed + Math.floor(Math.random() * 10000);
}

function snapshotConfigFlags(): ConfigFeatureFlags {
	return { ...configFeatureFlags };
}

function readAsset(name: string): string {
	const assetPath = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"assets",
		name,
	);
	return fs.readFileSync(assetPath, "utf-8");
}

async function startFixtureServer(): Promise<{
	server: Server;
	baseUrl: string;
}> {
	const html = readAsset(HTML_FILE);
	const js = readAsset(JS_FILE);
	const server = createServer((req, res) => {
		const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
		const pathname = requestUrl.pathname;

		if (pathname === `/${HTML_FILE}`) {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(html);
			return;
		}

		if (pathname === `/${JS_FILE}`) {
			res.writeHead(200, {
				"content-type": "application/javascript; charset=utf-8",
			});
			res.end(js);
			return;
		}

		if (pathname === "/favicon.ico") {
			res.writeHead(204);
			res.end();
			return;
		}

		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("not found");
	});

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address() as AddressInfo;
	return {
		server,
		baseUrl: `http://127.0.0.1:${address.port}`,
	};
}

async function stopServer(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

async function readFixtureState(browser: {
	Runtime: {
		evaluate: (input: {
			expression: string;
			returnByValue?: boolean;
		}) => Promise<{ result: { value?: unknown } }>;
	};
}): Promise<{
	page?: string;
	authStep?: string;
	loginSuccess?: boolean;
	manualStepRequired?: boolean;
	submittedCount?: number;
	invalidCredentialCount?: number;
	lastAuthOutcome?: string;
	bodyText?: string;
}> {
	const { result } = await browser.Runtime.evaluate({
		expression: `(() => ({
			...(window.__authFixtureState || {}),
			bodyText: document.body ? document.body.innerText || "" : "",
		}))()`,
		returnByValue: true,
	});
	return (result.value ?? {}) as {
		page?: string;
		authStep?: string;
		loginSuccess?: boolean;
		manualStepRequired?: boolean;
		submittedCount?: number;
		invalidCredentialCount?: number;
		lastAuthOutcome?: string;
		bodyText?: string;
	};
}

function makeOpenAIStageLLM(): LLMOptions {
	return {
		provider: "openai",
		model: "gpt-auth-test",
		reasoningEffort: "low",
	};
}

function extractProbeRef(promptText: string, pattern: RegExp): string | null {
	return promptText.match(pattern)?.[1] ?? null;
}

function captureConsoleLogs(): {
	logs: string[];
	restore: () => void;
} {
	const logs: string[] = [];
	const originalConsoleLog = console.log;
	console.log = (...args: unknown[]) => {
		logs.push(args.map((value) => String(value)).join(" "));
	};
	return {
		logs,
		restore: () => {
			console.log = originalConsoleLog;
		},
	};
}

function extractLatestUserPromptText(input: unknown): string {
	if (typeof input === "string") {
		const userSections = input
			.split(/\n\n(?=(?:SYSTEM|USER|ASSISTANT):\n)/)
			.filter((section) => section.startsWith("USER:\n"));
		return userSections.at(-1)?.slice("USER:\n".length) ?? input;
	}
	if (!Array.isArray(input)) {
		return extractPromptTextFromOpenAIInput(input);
	}
	const latestUserMessage = [...input]
		.reverse()
		.find(
			(message) =>
				message !== null &&
				typeof message === "object" &&
				(message as Record<string, unknown>).role === "user",
		) as Record<string, unknown> | undefined;
	return extractPromptTextFromOpenAIInput(latestUserMessage?.content ?? input);
}

function createResponder() {
	return (promptText: string, latestUserPromptText = promptText): string => {
		if (
			promptText.includes(
				"You analyze a redacted semantic projection for a login flow.",
			)
		) {
			const usernameRef =
				extractProbeRef(
					latestUserPromptText,
					/textbox ref="([^"]+)"[^\n]*name="(?:email|name@example\.com|username)[^"]*"/i,
				) ?? extractProbeRef(latestUserPromptText, /textbox ref="([^"]+)"/i);
			const passwordRef = extractProbeRef(
				latestUserPromptText,
				/textbox ref="([^"]+)"[^\n]*name="password"/i,
			);
			const continueRef = extractProbeRef(
				latestUserPromptText,
				/button ref="([^"]+)"[^\n]*(Continue|Next)/i,
			);
			const submitRef = extractProbeRef(
				latestUserPromptText,
				/button ref="([^"]+)"[^\n]*Sign in/i,
			);
			const hasPasswordField = passwordRef !== null;
			const hasContinueOnly = continueRef !== null && submitRef === null;

			if (usernameRef && hasContinueOnly && !hasPasswordField) {
				return `action: "advance_identifier_step"
usernameRef: "${usernameRef ?? ""}"
continueRef: "${continueRef ?? ""}"
reason: "email-first login step"`;
			}

			if (!usernameRef || !passwordRef || !submitRef) {
				return `action: "cannot_attempt"
reason: "the auth form is ambiguous or incomplete"`;
			}

			return `action: "submit_credentials"
usernameRef: "${usernameRef ?? ""}"
passwordRef: "${passwordRef ?? ""}"
submitRef: "${submitRef ?? ""}"
reason: "standard login form"`;
		}

		if (
			promptText.includes(
				"You classify the result of an attempted login after real credential submission.",
			)
		) {
			if (
				latestUserPromptText.includes("Invalid username or password") ||
				latestUserPromptText.includes("Invalid email or password")
			) {
				return `outcome: "invalid_credentials"
reason: "the page shows invalid username or password"`;
			}
			if (latestUserPromptText.includes("Dashboard Ready")) {
				return `outcome: "success_or_redirect"
reason: "the page shows the signed-in dashboard"`;
			}
			if (
				latestUserPromptText.includes("Manual takeover required") ||
				latestUserPromptText.includes("one-time code")
			) {
				return `outcome: "requires_user_takeover"
reason: "manual verification is required"`;
			}
			return `outcome: "unknown"
reason: "the page state is unclear"`;
		}

		if (latestUserPromptText.includes("Dashboard Ready")) {
			return latestUserPromptText.includes("memoryContent:")
				? `thinking: "Return the verified dashboard result."
actions:
  - type: "return_results"
    results:
      - link: "https://example.com/dashboard"
        summary: "Dashboard Ready"`
				: `thinking: "Read memory before returning the dashboard result."
actions:
  - type: "memory_read"`;
		}

		if (
			latestUserPromptText.includes("Manual takeover required") ||
			latestUserPromptText.includes("one-time code")
		) {
			return `thinking: "Manual verification is required."
actions:
  - type: "user_takeover"
    category: "otp"
    request: "Enter the OTP / 2FA one-time code from your authenticator app."
done: false`;
		}

		return `thinking: "The page needs secure login."
actions:
  - type: "user_takeover"
    category: "authentication"
    request: "Use secure authentication handling for the sign-in form."
done: false`;
	};
}

function installMockedOpenAIProvider(
	mock: ReturnType<typeof createCapturedOpenAIClient>,
): void {
	__setProviderOverrideForTests("openai", async (args) => {
		const response = await mock.client.responses.create({
			input: args.messages,
		});
		return {
			content: response.output_text,
			usage: {
				input_tokens: 0,
				cached_input_tokens: 0,
				output_tokens: 0,
				total_tokens: 0,
			},
			reasoning_tokens: "",
			responseMessages: [
				{ role: "assistant", content: response.output_text },
			],
		};
	});
}

describe("auth takeover e2e (mocked OpenAI provider)", function () {
	this.timeout(180_000);

	let server: Server | null = null;
	let baseUrl = "";

	before(async () => {
		const started = await startFixtureServer();
		server = started.server;
		baseUrl = started.baseUrl;
	});

	after(async () => {
		__setProviderOverrideForTests("openai", null);
		if (server) {
			await stopServer(server);
		}
	});

	it("keeps auth secrets out of every model prompt during automatic login success", async () => {
		await withAuthEncryptionKey(async () => {
			const originalFlags = snapshotConfigFlags();
			const port = randomPort(371);
			const fixtureUrl = `${baseUrl}/${HTML_FILE}?scenario=success-email-first`;
			const secretDomainUrl = `${baseUrl}/${HTML_FILE}?scenario=success-email-first&tenant=private-workspace`;
			const secrets = [
				ACCEPTED_PASSWORD,
				secretDomainUrl,
				"private-workspace",
				currentAuthEncryptionKeyOrThrow(),
			];
			const featureFlags = mergeConfigFeatureFlags(originalFlags, {
				preStepScreenshotInLatestUserPrompt: false,
				userTakeoverTool: true,
				authTakeover: true,
			});
			const deps = createDefaultCoreDeps({
				featureFlags,
				userActionBehavior: "return",
			});
			deps.findTargetURL = async () => {
				throw new Error(
					"findTargetURL must not run when session.url is provided for the auth takeover fixture",
				);
			};

			const mock = createCapturedOpenAIClient({
				respond: (call) =>
					createResponder()(
						call.promptText,
						extractLatestUserPromptText(call.body.input),
					),
			});
			installMockedOpenAIProvider(mock);

			try {
				const result = await runAgent(deps, {
					session: {
						port,
						headless: true,
						url: fixtureUrl,
						forceRestart: true,
					},
					task: 'Use the normal sign-in flow on this page. If the page requires sign-in credentials, use user_takeover with category "authentication". Do not finish until the page clearly shows the exact text "Dashboard Ready".',
					stageLLMs: {
						findTargetURL: makeOpenAIStageLLM(),
						createChecklist: makeOpenAIStageLLM(),
						runAgent: makeOpenAIStageLLM(),
						verifySuccess: makeOpenAIStageLLM(),
					},
					featureFlags,
					...createAuthCredentialCallbacksFromInput({
						credentials: {
							mode: "plaintext",
							domainUrl: secretDomainUrl,
							username: ACCEPTED_USERNAME,
							password: ACCEPTED_PASSWORD,
						},
					}),
					maxSteps: 10,
					keepSessionOpen: true,
					generateStep: async ({ promptPayload }) => {
						const html = String(promptPayload.html ?? "");
						if (html.includes("Dashboard Ready")) {
							return {
								data:
									typeof promptPayload.memoryContent === "string"
										? {
												thinking: "Return the verified dashboard result.",
												actions: [
													{
														type: "return_results",
														results: [
															{
																link: String(promptPayload.currentURL ?? ""),
																summary: "Dashboard Ready",
															},
														],
													},
												],
											}
										: {
												thinking:
													"Read memory before returning the dashboard result.",
												actions: [{ type: "memory_read" }],
											},
								usage: {
									input_tokens: 1,
									output_tokens: 1,
									total_tokens: 2,
								},
								reasoning_tokens: "",
							};
						}
						return {
							data: {
								thinking: "The page needs secure login.",
								actions: [
									{
										type: "user_takeover",
										category: "authentication",
										request:
											"Use secure authentication handling for the sign-in form.",
									},
								],
								done: false,
							},
							usage: {
								input_tokens: 1,
								output_tokens: 1,
								total_tokens: 2,
							},
							reasoning_tokens: "",
						};
					},
				});

				assert.isTrue(
					mock.calls.some((call) =>
						call.promptText.includes(
							"You analyze a redacted semantic projection for a login flow.",
						),
					),
					"missing auth form probe prompt",
				);
				assert.isTrue(
					mock.calls.some((call) =>
						call.promptText.includes(
							"You classify the result of an attempted login after real credential submission.",
						),
					),
					"missing auth result classification prompt",
				);
				assertNoSecretLeaksInCapturedCalls(mock.calls, secrets);
				assert.notInclude(JSON.stringify(result), ACCEPTED_PASSWORD);

				const session = deps.registry.get(port);
				assert.isDefined(session);
				const fixtureState = await readFixtureState(session!.browser);
				assert.strictEqual(fixtureState.page, "dashboard");
				assert.isTrue(fixtureState.loginSuccess);
				if (result.completed) {
					assert.isUndefined(result.userActionRequired);
				}
				assert.strictEqual(fixtureState.submittedCount, 2);
				assert.strictEqual(fixtureState.invalidCredentialCount, 0);
				assert.strictEqual(fixtureState.authStep, "credentials");
				assert.include(fixtureState.bodyText ?? "", "Dashboard Ready");
			} finally {
				__setProviderOverrideForTests("openai", null);
				if (deps.registry.get(port)) {
					await closeSession(deps, port);
				}
				setConfigFeatureFlags(originalFlags);
			}
		});
	});

	it("keeps auth secrets out of every model prompt during OTP fallback", async () => {
		await withAuthEncryptionKey(async () => {
			const originalFlags = snapshotConfigFlags();
			const port = randomPort(372);
			const fixtureUrl = `${baseUrl}/${HTML_FILE}?scenario=otp-email-first`;
			const secretDomainUrl = `${baseUrl}/${HTML_FILE}?scenario=otp-email-first&tenant=private-workspace`;
			const secrets = [
				ACCEPTED_PASSWORD,
				secretDomainUrl,
				"private-workspace",
				currentAuthEncryptionKeyOrThrow(),
			];
			const featureFlags = mergeConfigFeatureFlags(originalFlags, {
				preStepScreenshotInLatestUserPrompt: false,
				userTakeoverTool: true,
				authTakeover: true,
			});
			const deps = createDefaultCoreDeps({
				featureFlags,
				userActionBehavior: "return",
			});
			deps.findTargetURL = async () => {
				throw new Error(
					"findTargetURL must not run when session.url is provided for the auth takeover fixture",
				);
			};

			const mock = createCapturedOpenAIClient({
				respond: (call) =>
					createResponder()(
						call.promptText,
						extractLatestUserPromptText(call.body.input),
					),
			});
			installMockedOpenAIProvider(mock);

			try {
				const result = await runAgent(deps, {
					session: {
						port,
						headless: true,
						url: fixtureUrl,
						forceRestart: true,
					},
					task: 'Use the normal sign-in flow on this page. If the page requires sign-in credentials, use user_takeover with category "authentication". If a one-time code or manual verification appears, return control instead of guessing.',
					stageLLMs: {
						findTargetURL: makeOpenAIStageLLM(),
						createChecklist: makeOpenAIStageLLM(),
						runAgent: makeOpenAIStageLLM(),
						verifySuccess: makeOpenAIStageLLM(),
					},
					featureFlags,
					...createAuthCredentialCallbacksFromInput({
						credentials: {
							mode: "plaintext",
							domainUrl: secretDomainUrl,
							username: ACCEPTED_USERNAME,
							password: ACCEPTED_PASSWORD,
						},
					}),
					maxSteps: 10,
					keepSessionOpen: true,
					generateStep: async ({ promptPayload }) => {
						const html = String(promptPayload.html ?? "");
						if (
							html.includes("Manual takeover required") ||
							html.includes("one-time code")
						) {
							return {
								data: {
									thinking: "Manual verification is required.",
									actions: [
										{
											type: "user_takeover",
											category: "otp",
											request:
												"Enter the OTP / 2FA one-time code from your authenticator app.",
										},
									],
									done: false,
								},
								usage: {
									input_tokens: 1,
									output_tokens: 1,
									total_tokens: 2,
								},
								reasoning_tokens: "",
							};
						}
						return {
							data: {
								thinking: "The page needs secure login.",
								actions: [
									{
										type: "user_takeover",
										category: "authentication",
										request:
											"Use secure authentication handling for the sign-in form.",
									},
								],
								done: false,
							},
							usage: {
								input_tokens: 1,
								output_tokens: 1,
								total_tokens: 2,
							},
							reasoning_tokens: "",
						};
					},
				});

				assert.isFalse(result.completed);
				assert.strictEqual(
					result.userActionRequired?.kind,
					"browser_user_takeover",
				);
				assert.isTrue(
					mock.calls.some((call) =>
						call.promptText.includes(
							"You analyze a redacted semantic projection for a login flow.",
						),
					),
					"missing auth form probe prompt",
				);
				assert.isTrue(
					mock.calls.some((call) =>
						call.promptText.includes(
							"You classify the result of an attempted login after real credential submission.",
						),
					),
					"missing auth result classification prompt",
				);
				assertNoSecretLeaksInCapturedCalls(mock.calls, secrets);
				assert.notInclude(JSON.stringify(result), ACCEPTED_PASSWORD);

				const session = deps.registry.get(port);
				assert.isDefined(session);
				const fixtureState = await readFixtureState(session!.browser);
				assert.include(["otp", "login"], fixtureState.page ?? "");
				if (fixtureState.page === "otp") {
					assert.isTrue(fixtureState.manualStepRequired);
					assert.strictEqual(fixtureState.submittedCount, 2);
					assert.strictEqual(fixtureState.invalidCredentialCount, 0);
					assert.strictEqual(fixtureState.authStep, "credentials");
					assert.include(
						fixtureState.bodyText ?? "",
						"Manual takeover required",
					);
				} else {
					assert.notInclude(fixtureState.bodyText ?? "", "Dashboard Ready");
				}
			} finally {
				__setProviderOverrideForTests("openai", null);
				if (deps.registry.get(port)) {
					await closeSession(deps, port);
				}
				setConfigFeatureFlags(originalFlags);
			}
		});
	});
});
