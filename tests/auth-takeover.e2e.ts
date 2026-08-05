import * as fs from "node:fs";
import * as path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";
import { assert } from "chai";
import { after, before, describe, it } from "mocha";
import type { Action, LLMOptions } from "../src/agents/types.js";
import {
	configFeatureFlags,
	mergeConfigFeatureFlags,
	setConfigFeatureFlags,
	type ConfigFeatureFlags,
} from "../src/config-feature-flags.js";
import { createDefaultCoreDeps } from "../src/core/deps.js";
import { closeSession, runAgent } from "../src/core/index.js";
import { createAuthCredentialCallbacksFromInput } from "../src/auth/crypto.js";
import { withAuthEncryptionKey } from "./helpers/auth-test-utils.js";

loadEnv({
	path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"),
});

const ACCEPTED_USERNAME = "operator@example.com";
const ACCEPTED_PASSWORD = "correct-horse-battery-staple";
const HTML_FILE = "auth-takeover-fixture.html";
const JS_FILE = "auth-takeover-fixture.js";
const TOGETHER_MODEL = "zai-org/GLM-5.2";

function randomPort(seed: number): number {
	return 30000 + seed + Math.floor(Math.random() * 10000);
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

function makeTogetherStageLLM(): LLMOptions {
	return {
		provider: "together",
		model: TOGETHER_MODEL,
		reasoningEffort: "high",
	};
}

function stepUsedAuthenticationTakeover(actions: Action[]): boolean {
	return actions.some(
		(action) =>
			action.type === "user_takeover" && action.category === "authentication",
	);
}

describe("auth takeover e2e (Together + GLM-5.2)", function () {
	this.timeout(300_000);

	const togetherApiKey = process.env.TOGETHER_API_KEY;
	let server: Server | null = null;
	let baseUrl = "";

	before(async function () {
		if (!togetherApiKey) {
			this.skip();
		}
		const started = await startFixtureServer();
		server = started.server;
		baseUrl = started.baseUrl;
	});

	it("automatically logs in on the success fixture with the real Together provider", async () => {
		await withAuthEncryptionKey(async () => {
			const originalFlags = snapshotConfigFlags();
			const port = randomPort(271);
			const fixtureUrl = `${baseUrl}/${HTML_FILE}?scenario=success-email-first`;
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

			const stageLLM = makeTogetherStageLLM();

			try {
				const result = await runAgent(deps, {
					session: {
						port,
						headless: false,
						url: fixtureUrl,
						forceRestart: true,
					},
					task: 'Use the normal sign-in flow on this page. If the page requires sign-in credentials, use user_takeover with category "authentication". Do not finish until the page clearly shows the exact text "Dashboard Ready". Once the dashboard is visible, mark the task done and mention that the dashboard is ready.',
					stageLLMs: {
						findTargetURL: stageLLM,
						createChecklist: stageLLM,
						runAgent: stageLLM,
						verifySuccess: stageLLM,
					},
					featureFlags,
					...createAuthCredentialCallbacksFromInput({
						credentials: {
							mode: "plaintext",
							domainUrl: fixtureUrl,
							username: ACCEPTED_USERNAME,
							password: ACCEPTED_PASSWORD,
						},
					}),
					maxSteps: 10,
					keepSessionOpen: true,
				});

				assert.strictEqual(result.preprocess.target_url, fixtureUrl);
				assert.isAtLeast(result.steps.length, 1);

				const serializedResult = JSON.stringify(result);
				assert.notInclude(serializedResult, ACCEPTED_PASSWORD);

				const session = deps.registry.get(port);
				assert.isDefined(session);
				const fixtureState = await readFixtureState(session!.browser);
				if (result.completed) {
					assert.isUndefined(result.userActionRequired);
					const resultText = (result.result ?? "").toLowerCase();
					assert.include(resultText, "dashboard");
					assert.include(resultText, "ready");
					assert.strictEqual(fixtureState.page, "dashboard");
					assert.isTrue(fixtureState.loginSuccess);
					assert.isFalse(fixtureState.manualStepRequired);
					assert.strictEqual(fixtureState.submittedCount, 2);
					assert.strictEqual(fixtureState.invalidCredentialCount, 0);
					assert.strictEqual(fixtureState.authStep, "credentials");
					assert.strictEqual(fixtureState.lastAuthOutcome, "success");
					assert.include(fixtureState.bodyText ?? "", "Dashboard Ready");
				} else {
					assert.strictEqual(
						result.userActionRequired?.kind,
						"browser_user_takeover",
					);
					assert.include(
						["authentication", undefined],
						result.userActionRequired?.category,
					);
					assert.include(["login", "otp"], fixtureState.page ?? "");
					assert.notInclude(fixtureState.bodyText ?? "", "Dashboard Ready");
				}
			} finally {
				if (deps.registry.get(port)) {
					await closeSession(deps, port);
				}
				setConfigFeatureFlags(originalFlags);
			}
		});
	});

	it("selects an existing account and submits the revealed password field with the real Together provider", async () => {
		await withAuthEncryptionKey(async () => {
			const originalFlags = snapshotConfigFlags();
			const port = randomPort(273);
			const fixtureUrl = `${baseUrl}/${HTML_FILE}?scenario=success-account-list`;
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

			const stageLLM = makeTogetherStageLLM();

			try {
				const result = await runAgent(deps, {
					session: {
						port,
						headless: false,
						url: fixtureUrl,
						forceRestart: true,
					},
					task: 'Use the normal sign-in flow on this page. If the page shows an account list or requires sign-in credentials, do not click account rows or credential fields yourself; use user_takeover with category "authentication". Do not finish until the page clearly shows the exact text "Dashboard Ready". Once the dashboard is visible, mark the task done and mention that the dashboard is ready.',
					stageLLMs: {
						findTargetURL: stageLLM,
						createChecklist: stageLLM,
						runAgent: stageLLM,
						verifySuccess: stageLLM,
					},
					featureFlags,
					...createAuthCredentialCallbacksFromInput({
						credentials: {
							mode: "plaintext",
							domainUrl: fixtureUrl,
							username: ACCEPTED_USERNAME,
							password: ACCEPTED_PASSWORD,
						},
					}),
					maxSteps: 10,
					keepSessionOpen: true,
				});

				assert.strictEqual(result.preprocess.target_url, fixtureUrl);
				assert.isAtLeast(result.steps.length, 1);
				assert.isTrue(
					result.steps.some((stepResult) =>
						stepUsedAuthenticationTakeover(stepResult.model.actions),
					),
					"at least one model step should request authentication takeover",
				);

				const serializedResult = JSON.stringify(result);
				assert.notInclude(serializedResult, ACCEPTED_PASSWORD);

				const session = deps.registry.get(port);
				assert.isDefined(session);
				const fixtureState = await readFixtureState(session!.browser);
				assert.isTrue(
					result.completed,
					`expected completed run, got ${JSON.stringify({
						completed: result.completed,
						result: result.result,
						userActionRequired: result.userActionRequired,
						fixtureState,
					})}`,
				);
				assert.isUndefined(result.userActionRequired);
				assert.strictEqual(fixtureState.page, "dashboard");
				assert.isTrue(fixtureState.loginSuccess);
				assert.isFalse(fixtureState.manualStepRequired);
				assert.strictEqual(fixtureState.submittedCount, 1);
				assert.strictEqual(fixtureState.invalidCredentialCount, 0);
				assert.strictEqual(fixtureState.authStep, "credentials");
				assert.strictEqual(fixtureState.lastAuthOutcome, "success");
				assert.include(fixtureState.bodyText ?? "", "Dashboard Ready");
			} finally {
				if (deps.registry.get(port)) {
					await closeSession(deps, port);
				}
				setConfigFeatureFlags(originalFlags);
			}
		});
	});

	it("falls back to manual takeover on the OTP fixture with the real Together provider", async () => {
		await withAuthEncryptionKey(async () => {
			const originalFlags = snapshotConfigFlags();
			const port = randomPort(272);
			const fixtureUrl = `${baseUrl}/${HTML_FILE}?scenario=otp-email-first`;
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

			const stageLLM = makeTogetherStageLLM();

			try {
				const result = await runAgent(deps, {
					session: {
						port,
						headless: false,
						url: fixtureUrl,
						forceRestart: true,
					},
					task: 'Use the normal sign-in flow on this page. If the page requires sign-in credentials, use user_takeover with category "authentication". If a one-time code, authenticator, or other manual verification step appears after sign-in, stop and return control instead of guessing. Do not mark the task done unless the dashboard is visible.',
					stageLLMs: {
						findTargetURL: stageLLM,
						createChecklist: stageLLM,
						runAgent: stageLLM,
						verifySuccess: stageLLM,
					},
					featureFlags,
					...createAuthCredentialCallbacksFromInput({
						credentials: {
							mode: "plaintext",
							domainUrl: fixtureUrl,
							username: ACCEPTED_USERNAME,
							password: ACCEPTED_PASSWORD,
						},
					}),
					maxSteps: 10,
					keepSessionOpen: true,
				});

				assert.isFalse(
					result.completed,
					`expected incomplete run, got ${JSON.stringify({
						completed: result.completed,
						result: result.result,
						userActionRequired: result.userActionRequired,
						stepCount: result.steps.length,
					})}`,
				);
				assert.isAtLeast(result.steps.length, 1);
				assert.isDefined(result.userActionRequired);
				assert.strictEqual(
					result.userActionRequired?.kind,
					"browser_user_takeover",
				);
				assert.isTrue(
					result.steps.some((stepResult) =>
						stepUsedAuthenticationTakeover(stepResult.model.actions),
					),
					"at least one model step should request authentication takeover",
				);

				const serializedResult = JSON.stringify(result);
				assert.notInclude(serializedResult, ACCEPTED_PASSWORD);

				const session = deps.registry.get(port);
				assert.isDefined(session);
				const fixtureState = await readFixtureState(session!.browser);
				assert.include(["otp", "login"], fixtureState.page ?? "");
				assert.isFalse(fixtureState.loginSuccess);
				if (fixtureState.page === "otp") {
					assert.isTrue(fixtureState.manualStepRequired);
					assert.strictEqual(fixtureState.submittedCount, 2);
					assert.strictEqual(fixtureState.invalidCredentialCount, 0);
					assert.strictEqual(fixtureState.authStep, "credentials");
					assert.strictEqual(fixtureState.lastAuthOutcome, "otp_required");
					assert.include(
						fixtureState.bodyText ?? "",
						"Manual takeover required",
					);
					assert.include(
						fixtureState.bodyText ?? "",
						"Enter the one-time code from your authenticator app",
					);
				} else {
					assert.notInclude(fixtureState.bodyText ?? "", "Dashboard Ready");
				}
			} finally {
				if (deps.registry.get(port)) {
					await closeSession(deps, port);
				}
				setConfigFeatureFlags(originalFlags);
			}
		});
	});

	after(async () => {
		if (server) {
			await stopServer(server);
		}
	});
});
