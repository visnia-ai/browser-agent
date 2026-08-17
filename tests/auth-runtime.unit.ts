import { assert } from "chai";
import { describe, it } from "mocha";
import { attemptAutomatedAuthTakeover } from "../src/auth/runtime.js";
import {
	createAuthCredentialCallbacksFromInput,
	createSessionAuthTakeoverState,
} from "../src/auth/crypto.js";
import type {
	AuthCredentialsInput,
	AuthLookupOptions,
} from "../src/auth/types.js";
import type { SessionAuthTakeoverState } from "../src/auth/types.js";
import { withAuthEncryptionKey } from "./helpers/auth-test-utils.js";
import { assertNoSecretLeaksInText } from "./helpers/auth-prompt-capture.js";

function createAuthSession(input: {
	enabled: boolean;
	credentials?: AuthCredentialsInput;
}) {
	const callbacks = createAuthCredentialCallbacksFromInput({
		credentials: input.credentials,
	});
	return createSessionAuthTakeoverState({
		enabled: input.enabled,
		requestAuthDomainCandidates: callbacks?.requestAuthDomainCandidates,
		requestAuthIdentifierForDomain:
			callbacks?.requestAuthIdentifierForDomain,
		requestAuthPasswordForDomain: callbacks?.requestAuthPasswordForDomain,
	});
}

function extractRef(dom: string, pattern: RegExp): string | undefined {
	return dom.match(pattern)?.[1];
}

function extractIdentifierRef(dom: string): string | undefined {
	return (
		extractRef(dom, /input ref="([^"]+)"[^\n]*type="email"/i) ??
		extractRef(dom, /input ref="([^"]+)"[^\n]*autocomplete="username"/i) ??
		extractRef(dom, /input ref="([^"]+)"[^\n]*placeholder="Email"/i) ??
		extractRef(dom, /input ref="([^"]+)"[^\n]*name="email"/i)
	);
}

function extractCheckboxRef(dom: string): string | undefined {
	return extractRef(dom, /input ref="([^"]+)"[^\n]*type="checkbox"/i);
}

function extractSwitchIdentifierRef(dom: string): string | undefined {
	for (const block of dom.split(
		/\n(?=\s*(?:ref="[^"]+"\s+(?:button|link):|(?:button|link)\s+ref="[^"]+"))/,
	)) {
		const ref = firstDefined(
			block.match(/^\s*ref="([^"]+)"\s+(?:button|link):/m)?.[1],
			block.match(/^\s*(?:button|link)\s+ref="([^"]+)"/m)?.[1],
		);
		if (ref && /Use another|different|Change|Add account/i.test(block)) {
			return ref;
		}
	}
	return undefined;
}

function firstDefined(
	...values: Array<string | undefined>
): string | undefined {
	return values.find((value): value is string => typeof value === "string");
}

function extractAccountRef(dom: string): string | undefined {
	for (const block of dom.split(
		/\n(?=\s*(?:ref="[^"]+"\s+link:|link\s+ref="[^"]+"))/,
	)) {
		const ref = firstDefined(
			block.match(/^\s*ref="([^"]+)"\s+link:/m)?.[1],
			block.match(/^\s*link\s+ref="([^"]+)"/m)?.[1],
		);
		if (ref && block.includes("[AUTH_IDENTIFIER_MATCH]")) {
			return ref;
		}
	}
	return undefined;
}

function buildAuthRuntimeChatYAMLMock() {
	return async (
		messages: Array<{ role?: string; content?: unknown }>,
		_llm: unknown,
		caller?: string,
	) => {
		const dom = String(messages?.[1]?.content ?? "");
		if (String(caller).startsWith("authTakeover:probe")) {
			const usernameRef = extractIdentifierRef(dom);
			const passwordRef = extractRef(
				dom,
				/input ref="([^"]+)"[^\n]*type="password"/i,
			);
			const continueRef = extractRef(
				dom,
				/button ref="([^"]+)"[^\n]*(Continue|Next)/i,
			);
			const submitRef = extractRef(
				dom,
				/button ref="([^"]+)"[^\n]*Sign in/i,
			);
			const stayLoggedInCheckboxRef = extractCheckboxRef(dom);
			const switchIdentifierRef = extractSwitchIdentifierRef(dom);
			const accountRef = extractAccountRef(dom);
			if (accountRef || switchIdentifierRef) {
				return {
					data: {
						action: "select_account",
						...(accountRef ? { accountRef } : {}),
						...(!accountRef && switchIdentifierRef
							? { switchIdentifierRef }
							: {}),
						reason: accountRef
							? "matching account"
							: "use another account",
					},
					usage: {
						input_tokens: 10,
						cached_input_tokens: 0,
						output_tokens: 5,
						total_tokens: 15,
					},
					reasoning_tokens: "",
				} as any;
			}
			if (passwordRef && submitRef) {
				const data: Record<string, unknown> = {
					action: "submit_credentials",
					passwordRef,
					submitRef,
					reason: "fields present",
				};
				if (usernameRef) {
					data.usernameRef = usernameRef;
				}
				if (stayLoggedInCheckboxRef) {
					data.stayLoggedInCheckboxRef = stayLoggedInCheckboxRef;
				}
				if (switchIdentifierRef) {
					data.switchIdentifierRef = switchIdentifierRef;
				}
				return {
					data,
					usage: {
						input_tokens: 10,
						cached_input_tokens: 0,
						output_tokens: 5,
						total_tokens: 15,
					},
					reasoning_tokens: "",
				} as any;
			}
			if (usernameRef && continueRef) {
				return {
					data: {
						action: "advance_identifier_step",
						usernameRef,
						continueRef,
						reason: "identifier first",
					},
					usage: {
						input_tokens: 10,
						cached_input_tokens: 0,
						output_tokens: 5,
						total_tokens: 15,
					},
					reasoning_tokens: "",
				} as any;
			}
			if (usernameRef && !passwordRef && !submitRef) {
				return {
					data: {
						action: "advance_identifier_step",
						usernameRef,
						reason: "enter fallback",
					},
					usage: {
						input_tokens: 10,
						cached_input_tokens: 0,
						output_tokens: 5,
						total_tokens: 15,
					},
					reasoning_tokens: "",
				} as any;
			}
			return {
				data: { action: "cannot_attempt", reason: "no-match" },
				usage: {
					input_tokens: 10,
					cached_input_tokens: 0,
					output_tokens: 5,
					total_tokens: 15,
				},
				reasoning_tokens: "",
			} as any;
		}

		return {
			data: {
				outcome: "success_or_redirect",
				reason: "dashboard visible",
			},
			usage: {
				input_tokens: 8,
				cached_input_tokens: 0,
				output_tokens: 4,
				total_tokens: 12,
			},
			reasoning_tokens: "",
		} as any;
	};
}

describe("auth runtime", () => {
	it("handles password-visible form directly with programmatic credential submission", async () => {
		await withAuthEncryptionKey(async () => {
			const interactions: string[] = [];
			const logMessages: string[] = [];
			let usernameValue = "";
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://login.example.com/sign-in",
					username: "user@example.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};
			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getPageProjection: async () =>
						'input ref="u1" type="email" placeholder="Email"\ninput ref="p1" type="password" autocomplete="current-password"\ninput ref="stay1" type="checkbox" label="Remember me"\nbutton ref="s1": "Sign in"',
					getCurrentURL: async () =>
						"https://login.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					chatYAML: buildAuthRuntimeChatYAMLMock(),
					log: (message) => {
						logMessages.push(message);
					},
					typeText: async (_browser, ref, text) => {
						interactions.push(`type:${ref}:${text}`);
						if (ref === "u1") {
							usernameValue = text;
						}
					},
					readIdentifierInputByRef: async () => ({
						value: usernameValue,
						editable: true,
					}),
					click: async (_browser, ref) => {
						interactions.push(`click:${ref}`);
					},
					waitForAllOpenTabsToSettle: async () => {
						interactions.push("wait");
					},
					assertPasswordInputRef: async (_browser, ref) => {
						interactions.push(`verify-password:${ref}`);
					},
					ensureCheckboxChecked: async (_browser, ref) => {
						interactions.push(`check:${ref}`);
					},
				},
			});

			assert.isTrue(result.handled);
			assert.deepEqual(interactions, [
				"type:u1:user@example.com",
				"verify-password:p1",
				"type:p1:real-password",
				"check:stay1",
				"click:s1",
				"wait",
			]);
			assert.lengthOf(result.traceEntries, 2);
			assert.strictEqual(result.traceEntries[0]?.stage, "probe");
			assert.strictEqual(result.traceEntries[1]?.stage, "result");
			const probeMessages = result.traceEntries[0]?.messages ?? [];
			const resultMessages = result.traceEntries[1]?.messages ?? [];
			const probeRoles = probeMessages
				.map((entry) =>
					(entry as { role?: unknown }).role
						? String((entry as { role?: unknown }).role)
						: "",
				)
				.filter((role) => role.length > 0);
			const resultRoles = resultMessages
				.map((entry) =>
					(entry as { role?: unknown }).role
						? String((entry as { role?: unknown }).role)
						: "",
				)
				.filter((role) => role.length > 0);
			assert.deepEqual(probeRoles, ["system", "user", "assistant"]);
			assert.deepEqual(resultRoles, ["system", "user", "assistant"]);
			assert.notInclude(
				JSON.stringify(result.traceEntries),
				"real-password",
			);
			assert.strictEqual(sessionAuth.suppressScreenshots, false);
			assert.strictEqual(sessionAuth.protectedRefs.size, 0);
			assert.isTrue(
				logMessages.some((entry) =>
					entry.includes("authTakeover:attempt_started"),
				),
			);
			assert.isTrue(
				logMessages.some(
					(entry) =>
						entry.includes("authTakeover:auth_fields_detected") &&
						entry.includes('"hasPasswordRef":true') &&
						entry.includes('"hasSubmitRef":true'),
				),
			);
		});
	});

	it("skips username typing when the visible identifier already matches", async () => {
		await withAuthEncryptionKey(async () => {
			const interactions: string[] = [];
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://login.example.com/sign-in",
					username: "user@example.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};

			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getPageProjection: async () =>
						'input ref="u1" type="email" value="USER@example.com"\ninput ref="p1" type="password"\nbutton ref="s1": "Sign in"',
					getCurrentURL: async () =>
						"https://login.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					chatYAML: buildAuthRuntimeChatYAMLMock(),
					typeText: async (_browser, ref, text) => {
						interactions.push(`type:${ref}:${text}`);
					},
					readIdentifierInputByRef: async () => ({
						value: "USER@example.com",
						editable: true,
					}),
					click: async (_browser, ref) => {
						interactions.push(`click:${ref}`);
					},
					waitForAllOpenTabsToSettle: async () => {
						interactions.push("wait");
					},
					assertPasswordInputRef: async (_browser, ref) => {
						interactions.push(`verify-password:${ref}`);
					},
				},
			});

			assert.isTrue(result.handled);
			assert.deepEqual(interactions, [
				"verify-password:p1",
				"type:p1:real-password",
				"click:s1",
				"wait",
			]);
			assertNoSecretLeaksInText(JSON.stringify(result.traceEntries), [
				"real-password",
			]);
		});
	});

	it("replaces a mismatched editable identifier before submitting credentials", async () => {
		await withAuthEncryptionKey(async () => {
			const interactions: string[] = [];
			let usernameValue = "other@example.com";
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://login.example.com/sign-in",
					username: "user@example.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};

			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getPageProjection: async () =>
						'input ref="u1" type="email" value="other@example.com"\ninput ref="p1" type="password"\nbutton ref="s1": "Sign in"',
					getCurrentURL: async () =>
						"https://login.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					chatYAML: buildAuthRuntimeChatYAMLMock(),
					typeText: async (_browser, ref, text) => {
						interactions.push(`type:${ref}:${text}`);
						if (ref === "u1") {
							usernameValue = text;
						}
					},
					readIdentifierInputByRef: async () => ({
						value: usernameValue,
						editable: true,
					}),
					click: async (_browser, ref) => {
						interactions.push(`click:${ref}`);
					},
					waitForAllOpenTabsToSettle: async () => {
						interactions.push("wait");
					},
					assertPasswordInputRef: async (_browser, ref) => {
						interactions.push(`verify-password:${ref}`);
					},
				},
			});

			assert.isTrue(result.handled);
			assert.deepEqual(interactions, [
				"type:u1:user@example.com",
				"verify-password:p1",
				"type:p1:real-password",
				"click:s1",
				"wait",
			]);
		});
	});

	it("switches away from a mismatched non-editable identifier before login", async () => {
		await withAuthEncryptionKey(async () => {
			const interactions: string[] = [];
			let stage: "mismatch" | "identifier" | "password" = "mismatch";
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://login.example.com/sign-in",
					username: "user@example.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};

			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getPageProjection: async () => {
						if (stage === "mismatch") {
							return 'input ref="u1" type="email" value="other@example.com"\ninput ref="p1" type="password"\nbutton ref="sw1": "Use another email"\nbutton ref="s1": "Sign in"';
						}
						if (stage === "identifier") {
							return 'input ref="u2" type="email" placeholder="Email"\nbutton ref="c1": "Continue"';
						}
						return 'input ref="p1" type="password"\nbutton ref="s1": "Sign in"';
					},
					getCurrentURL: async () =>
						"https://login.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					chatYAML: buildAuthRuntimeChatYAMLMock(),
					typeText: async (_browser, ref, text) => {
						interactions.push(`type:${ref}:${text}`);
					},
					readIdentifierInputByRef: async (_browser, ref) => ({
						value: ref === "u1" ? "other@example.com" : "",
						editable: ref !== "u1",
					}),
					click: async (_browser, ref) => {
						interactions.push(`click:${ref}`);
						if (ref === "sw1") {
							stage = "identifier";
						}
						if (ref === "c1") {
							stage = "password";
						}
					},
					waitForAllOpenTabsToSettle: async () => {
						interactions.push("wait");
					},
					assertPasswordInputRef: async (_browser, ref) => {
						interactions.push(`verify-password:${ref}`);
					},
				},
			});

			assert.isTrue(result.handled);
			assert.deepEqual(interactions, [
				"click:sw1",
				"wait",
				"type:u2:user@example.com",
				"click:c1",
				"wait",
				"verify-password:p1",
				"type:p1:real-password",
				"click:s1",
				"wait",
			]);
			assert.strictEqual(
				result.traceEntries[0]?.outcomeReason,
				"identifier_switch_clicked",
			);
		});
	});

	it("submits password when selected account text matches without username input", async () => {
		await withAuthEncryptionKey(async () => {
			const interactions: string[] = [];
			const logs: string[] = [];
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://accounts.example.com/sign-in",
					username: "john@test.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};

			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getPageProjection: async () =>
						'div:\n  ref="sw1" link: "john@test.com selected. Switch account"\n  input ref="p1" type="password" name="Passwd": "Enter your password"\n  button ref="s1": "Next"',
					getCurrentURL: async () =>
						"https://accounts.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					chatYAML: async (_messages, _llm, caller) => {
						if (caller?.startsWith("authTakeover:probe")) {
							return {
								data: {
									action: "submit_credentials",
									passwordRef: "p1",
									submitRef: "s1",
									switchIdentifierRef: "sw1",
									reason: "password step",
								},
								usage: {
									input_tokens: 10,
									cached_input_tokens: 0,
									output_tokens: 5,
									total_tokens: 15,
								},
								reasoning_tokens: "",
							} as any;
						}
						return {
							data: {
								outcome: "success_or_redirect",
								reason: "dashboard visible",
							},
							usage: {
								input_tokens: 8,
								cached_input_tokens: 0,
								output_tokens: 4,
								total_tokens: 12,
							},
							reasoning_tokens: "",
						} as any;
					},
					log: (message) => {
						logs.push(message);
					},
					click: async (_browser, ref) => {
						interactions.push(`click:${ref}`);
					},
					typeText: async (_browser, ref, text) => {
						interactions.push(`type:${ref}:${text}`);
					},
					waitForAllOpenTabsToSettle: async () => {
						interactions.push("wait");
					},
					assertPasswordInputRef: async (_browser, ref) => {
						interactions.push(`verify-password:${ref}`);
					},
				},
			});

			assert.isTrue(result.handled);
			assert.deepEqual(interactions, [
				"verify-password:p1",
				"type:p1:real-password",
				"click:s1",
				"wait",
			]);
			assert.include(
				result.traceEntries[0]?.outcomeReason ?? "",
				"identifier_text_matched",
			);
			assert.isTrue(
				logs.some((entry) =>
					entry.includes("authTakeover:identifier_text_matched"),
				),
			);
			assertNoSecretLeaksInText(JSON.stringify(result.traceEntries), [
				"real-password",
			]);
		});
	});

	it("switches account when selected account text mismatches without username input", async () => {
		await withAuthEncryptionKey(async () => {
			const interactions: string[] = [];
			let stage: "mismatch" | "identifier" | "password" = "mismatch";
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://accounts.example.com/sign-in",
					username: "john@test.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};

			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getPageProjection: async () => {
						if (stage === "mismatch") {
							return 'div:\n  ref="sw1" link: "other@example.com selected. Switch account"\n  input ref="p1" type="password" name="Passwd": "Enter your password"\n  button ref="s1": "Next"';
						}
						if (stage === "identifier") {
							return 'input ref="u1" type="email" placeholder="Email"\nbutton ref="c1": "Continue"';
						}
						return 'div: "john@test.com"\ninput ref="p1" type="password" name="Passwd": "Enter your password"\nbutton ref="s1": "Next"';
					},
					getCurrentURL: async () =>
						"https://accounts.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					chatYAML: async (_messages, _llm, caller) => {
						if (caller?.startsWith("authTakeover:probe")) {
							if (stage === "identifier") {
								return {
									data: {
										action: "advance_identifier_step",
										usernameRef: "u1",
										continueRef: "c1",
										reason: "identifier first",
									},
									usage: {
										input_tokens: 10,
										cached_input_tokens: 0,
										output_tokens: 5,
										total_tokens: 15,
									},
									reasoning_tokens: "",
								} as any;
							}
							return {
								data: {
									action: "submit_credentials",
									passwordRef: "p1",
									submitRef: "s1",
									...(stage === "mismatch"
										? { switchIdentifierRef: "sw1" }
										: {}),
									reason: "password step",
								},
								usage: {
									input_tokens: 10,
									cached_input_tokens: 0,
									output_tokens: 5,
									total_tokens: 15,
								},
								reasoning_tokens: "",
							} as any;
						}
						return {
							data: {
								outcome: "success_or_redirect",
								reason: "dashboard visible",
							},
							usage: {
								input_tokens: 8,
								cached_input_tokens: 0,
								output_tokens: 4,
								total_tokens: 12,
							},
							reasoning_tokens: "",
						} as any;
					},
					click: async (_browser, ref) => {
						interactions.push(`click:${ref}`);
						if (ref === "sw1") {
							stage = "identifier";
						}
						if (ref === "c1") {
							stage = "password";
						}
					},
					typeText: async (_browser, ref, text) => {
						interactions.push(`type:${ref}:${text}`);
					},
					waitForAllOpenTabsToSettle: async () => {
						interactions.push("wait");
					},
					assertPasswordInputRef: async (_browser, ref) => {
						interactions.push(`verify-password:${ref}`);
					},
				},
			});

			assert.isTrue(result.handled);
			assert.deepEqual(interactions, [
				"click:sw1",
				"wait",
				"type:u1:john@test.com",
				"click:c1",
				"wait",
				"verify-password:p1",
				"type:p1:real-password",
				"click:s1",
				"wait",
			]);
			assert.strictEqual(
				result.traceEntries[0]?.outcomeReason,
				"identifier_switch_clicked",
			);
			assertNoSecretLeaksInText(JSON.stringify(result.traceEntries), [
				"real-password",
			]);
		});
	});

	it("selects a matching account chooser row before entering the password", async () => {
		await withAuthEncryptionKey(async () => {
			const interactions: string[] = [];
			let stage: "chooser" | "password" = "chooser";
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://accounts.example.com/sign-in",
					username: "user@example.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};

			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getPageProjection: async () =>
						stage === "chooser"
							? 'main:\n  "Choose an account"\n  ul:\n    ref="acct1" link:\n      ref="name1": "Test User"\n      ref="email1": "user@example.com"\n    ref="other1" link:\n      ref="other-text": "Use another account"'
							: 'input ref="p1" type="password"\nbutton ref="s1": "Sign in"',
					getCurrentURL: async () =>
						"https://accounts.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					chatYAML: buildAuthRuntimeChatYAMLMock(),
					click: async (_browser, ref) => {
						interactions.push(`click:${ref}`);
						if (ref === "acct1") {
							stage = "password";
						}
					},
					waitForAllOpenTabsToSettle: async () => {
						interactions.push("wait");
					},
					typeText: async (_browser, ref, text) => {
						interactions.push(`type:${ref}:${text}`);
					},
					assertPasswordInputRef: async (_browser, ref) => {
						interactions.push(`verify-password:${ref}`);
					},
				},
			});

			assert.isTrue(result.handled);
			assert.deepEqual(interactions, [
				"click:acct1",
				"wait",
				"verify-password:p1",
				"type:p1:real-password",
				"click:s1",
				"wait",
			]);
			assert.strictEqual(
				result.traceEntries[0]?.outcomeReason,
				"account_selected",
			);
		});
	});

	it("uses another-account chooser option when configured account is absent", async () => {
		await withAuthEncryptionKey(async () => {
			const interactions: string[] = [];
			let stage: "chooser" | "identifier" | "password" = "chooser";
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://accounts.example.com/sign-in",
					username: "user@example.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};

			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getPageProjection: async () => {
						if (stage === "chooser") {
							return 'main:\n  "Choose an account"\n  ul:\n    ref="acct1" link:\n      ref="email1": "other@example.com"\n    ref="other1" link:\n      ref="other-text": "Use another account"';
						}
						if (stage === "identifier") {
							return 'input ref="u1" type="email" placeholder="Email"\nbutton ref="c1": "Continue"';
						}
						return 'input ref="p1" type="password"\nbutton ref="s1": "Sign in"';
					},
					getCurrentURL: async () =>
						"https://accounts.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					chatYAML: buildAuthRuntimeChatYAMLMock(),
					click: async (_browser, ref) => {
						interactions.push(`click:${ref}`);
						if (ref === "other1") {
							stage = "identifier";
						}
						if (ref === "c1") {
							stage = "password";
						}
					},
					waitForAllOpenTabsToSettle: async () => {
						interactions.push("wait");
					},
					typeText: async (_browser, ref, text) => {
						interactions.push(`type:${ref}:${text}`);
					},
					assertPasswordInputRef: async (_browser, ref) => {
						interactions.push(`verify-password:${ref}`);
					},
				},
			});

			assert.isTrue(result.handled);
			assert.deepEqual(interactions, [
				"click:other1",
				"wait",
				"type:u1:user@example.com",
				"click:c1",
				"wait",
				"verify-password:p1",
				"type:p1:real-password",
				"click:s1",
				"wait",
			]);
			assert.strictEqual(
				result.traceEntries[0]?.outcomeReason,
				"identifier_switch_clicked",
			);
		});
	});

	it("falls back when a mismatched identifier cannot be changed safely", async () => {
		await withAuthEncryptionKey(async () => {
			const logs: string[] = [];
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://login.example.com/sign-in",
					username: "user@example.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};

			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getPageProjection: async () =>
						'input ref="u1" type="email" value="other@example.com"\ninput ref="p1" type="password"\nbutton ref="s1": "Sign in"',
					getCurrentURL: async () =>
						"https://login.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					chatYAML: buildAuthRuntimeChatYAMLMock(),
					log: (message) => {
						logs.push(message);
					},
					typeText: async () => {
						throw new Error("must not type");
					},
					readIdentifierInputByRef: async () => ({
						value: "other@example.com",
						editable: false,
					}),
				},
			});

			assert.isFalse(result.handled);
			assert.strictEqual(
				result.traceEntries[0]?.outcomeReason,
				"identifier_mismatch",
			);
			assertNoSecretLeaksInText(JSON.stringify(logs), ["real-password"]);
		});
	});

	it("handles identifier-first flow and resolves password step after continue", async () => {
		await withAuthEncryptionKey(async () => {
			const interactions: string[] = [];
			const logMessages: string[] = [];
			let domCalls = 0;
			let passwordRequests = 0;
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://login.example.com/sign-in",
					username: "user@example.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};
			const originalPasswordRequest =
				sessionAuth.requestAuthPasswordForDomain!;
			sessionAuth.requestAuthPasswordForDomain = async (currentUrl) => {
				passwordRequests += 1;
				return await originalPasswordRequest(currentUrl);
			};

			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getPageProjection: async () => {
						domCalls += 1;
						return domCalls === 1
							? 'input ref="u1" type="email" placeholder="Email"\nbutton ref="c1": "Continue"'
							: 'input ref="p1" type="password"\nbutton ref="s1": "Sign in"';
					},
					getCurrentURL: async () =>
						"https://login.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					chatYAML: buildAuthRuntimeChatYAMLMock(),
					log: (message) => {
						logMessages.push(message);
					},
					typeText: async (_browser, ref, text) => {
						interactions.push(`type:${ref}:${text}`);
					},
					click: async (_browser, ref) => {
						interactions.push(`click:${ref}`);
					},
					waitForAllOpenTabsToSettle: async () => {
						interactions.push("wait");
					},
					assertPasswordInputRef: async (_browser, ref) => {
						interactions.push(`verify-password:${ref}`);
					},
				},
			});

			assert.isTrue(result.handled);
			assert.strictEqual(sessionAuth.suppressScreenshots, false);
			assert.strictEqual(sessionAuth.protectedRefs.size, 0);
			assert.strictEqual(passwordRequests, 1);
			assert.deepEqual(interactions, [
				"type:u1:user@example.com",
				"click:c1",
				"wait",
				"verify-password:p1",
				"type:p1:real-password",
				"click:s1",
				"wait",
			]);
			assert.isTrue(
				logMessages.some(
					(entry) =>
						entry.includes(
							"authTakeover:identifier_step_completed",
						) &&
						entry.includes('"usedContinueRef":true') &&
						entry.includes('"usedEnterFallback":false'),
				),
			);
		});
	});

	it("uses Enter fallback when no continue or submit ref is detectable on identifier step", async () => {
		await withAuthEncryptionKey(async () => {
			const interactions: string[] = [];
			const logMessages: string[] = [];
			let domCalls = 0;
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://login.example.com/sign-in",
					username: "user@example.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};

			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getPageProjection: async () => {
						domCalls += 1;
						return domCalls === 1
							? 'input ref="u1" type="email" placeholder="Email"'
							: 'input ref="p1" type="password"\nbutton ref="s1": "Sign in"';
					},
					getCurrentURL: async () =>
						"https://login.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					chatYAML: buildAuthRuntimeChatYAMLMock(),
					log: (message) => {
						logMessages.push(message);
					},
					typeText: async (_browser, ref, text, enter) => {
						interactions.push(
							`type:${ref}:${text}:enter=${Boolean(enter)}`,
						);
					},
					click: async (_browser, ref) => {
						interactions.push(`click:${ref}`);
					},
					waitForAllOpenTabsToSettle: async () => {
						interactions.push("wait");
					},
					assertPasswordInputRef: async (_browser, ref) => {
						interactions.push(`verify-password:${ref}`);
					},
				},
			});

			assert.isTrue(result.handled);
			assert.strictEqual(sessionAuth.suppressScreenshots, false);
			assert.strictEqual(sessionAuth.protectedRefs.size, 0);
			assert.deepEqual(interactions, [
				"type:u1:user@example.com:enter=true",
				"wait",
				"verify-password:p1",
				"type:p1:real-password:enter=false",
				"click:s1",
				"wait",
			]);
			assert.isTrue(
				logMessages.some(
					(entry) =>
						entry.includes(
							"authTakeover:identifier_step_completed",
						) && entry.includes('"usedEnterFallback":true'),
				),
			);
		});
	});

	it("includes identifier step failure details in trace and unhandled logs", async () => {
		await withAuthEncryptionKey(async () => {
			const logMessages: string[] = [];
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://login.example.com/sign-in",
					username: "user@example.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};

			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getPageProjection: async () =>
						'input ref="u1" type="email" placeholder="Email"\nbutton ref="c1": "Continue"',
					getCurrentURL: async () =>
						"https://login.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					chatYAML: buildAuthRuntimeChatYAMLMock(),
					log: (message) => {
						logMessages.push(message);
					},
					typeText: async () => {},
					click: async () => {
						throw new Error("continue button detached");
					},
				},
			});

			assert.isFalse(result.handled);
			assert.strictEqual(result.traceEntries[0]?.outcome, "unhandled");
			assert.include(
				result.traceEntries[0]?.outcomeReason ?? "",
				"identifier_step_failed: continue button detached",
			);
			assert.isTrue(
				logMessages.some(
					(entry) =>
						entry.includes('"reason":"identifier_step_failed"') &&
						entry.includes('"error":"continue button detached"'),
				),
			);
		});
	});

	it("stops before identifier/password lookup when no domain credential matches", async () => {
		let domainLookupOptions: AuthLookupOptions | undefined;
		let identifierLookups = 0;
		let passwordLookups = 0;
		const sessionAuth: SessionAuthTakeoverState = {
			enabled: true,
			requestAuthDomainCandidates: async (_currentUrl, options) => {
				domainLookupOptions = options;
				return [];
			},
			requestAuthIdentifierForDomain: async () => {
				identifierLookups += 1;
				return "user@example.com";
			},
			requestAuthPasswordForDomain: async () => {
				passwordLookups += 1;
				return "real-password";
			},
			protectedRefs: new Set<string>(),
			suppressScreenshots: false,
		};

		const result = await attemptAutomatedAuthTakeover({
			deps: {
				getPageProjection: async () => "dom",
				getCurrentURL: async () => "https://idp.example.com/login",
			},
			browser: {} as any,
			sessionAuth,
		});

		assert.isFalse(result.handled);
		assert.deepEqual(domainLookupOptions, { purpose: "auth_takeover" });
		assert.strictEqual(identifierLookups, 0);
		assert.strictEqual(passwordLookups, 0);
	});

	it("falls back after four failed attempts within one takeover event", async () => {
		const logMessages: string[] = [];
		const result = await attemptAutomatedAuthTakeover({
			deps: {
				getPageProjection: async () =>
					'div ref="x1": "Sign in with SSO"',
				getCurrentURL: async () => "https://login.example.com/sign-in",
			},
			browser: {} as any,
			sessionAuth: {
				enabled: true,
				requestAuthDomainCandidates: async () => ["example.com"],
				requestAuthIdentifierForDomain: async () => "user@example.com",
				requestAuthPasswordForDomain: async () => "real-password",
				protectedRefs: new Set<string>(),
				suppressScreenshots: false,
			},
			hooks: {
				log: (message) => {
					logMessages.push(message);
				},
			},
		});

		assert.isFalse(result.handled);
		assert.strictEqual(
			logMessages.filter((entry) =>
				entry.includes("authTakeover:attempt_started"),
			).length,
			4,
		);
		assert.isTrue(
			logMessages.some(
				(entry) =>
					entry.includes('"reason":"attempt_budget_exhausted"') &&
					entry.includes('"maxAttempts":4'),
			),
		);
	});

	it("uses step-indexed auth caller labels and trace step numbers", async () => {
		await withAuthEncryptionKey(async () => {
			const callers: string[] = [];
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: "https://login.example.com/sign-in",
					username: "user@example.com",
					password: "real-password",
				},
			})!;
			sessionAuth.authProbeLLM = {
				provider: "openai",
				model: "gpt-auth-test",
			};

			const result = await attemptAutomatedAuthTakeover({
				deps: {
					getPageProjection: async () =>
						'input ref="u1" type="email"\ninput ref="p1" type="password"\nbutton ref="s1": "Sign in"\ndiv: "Dashboard Ready"',
					getCurrentURL: async () =>
						"https://login.example.com/sign-in",
				},
				browser: {} as any,
				sessionAuth,
				stepBaseIndex: 1,
				hooks: {
					chatYAML: async (_messages, _llm, caller) => {
						callers.push(caller ?? "");
						if (caller?.startsWith("authTakeover:probe:step")) {
							return {
								data: {
									action: "submit_credentials",
									usernameRef: "u1",
									passwordRef: "p1",
									submitRef: "s1",
									reason: "fields present",
								},
								usage: {
									input_tokens: 10,
									cached_input_tokens: 0,
									output_tokens: 5,
									total_tokens: 15,
								},
								reasoning_tokens: "probe-thinking",
								responseMessages: [
									{
										role: "assistant",
										content: [
											{
												type: "reasoning",
												text: "probe-thinking",
												providerOptions: {
													anthropic: { signature: "probe-signature" },
												},
											},
											{ type: "text", text: "raw probe response" },
										],
									},
								],
							} as any;
						}
						return {
							data: {
								outcome: "success_or_redirect",
								reason: "dashboard visible",
							},
							usage: {
								input_tokens: 8,
								cached_input_tokens: 0,
								output_tokens: 4,
								total_tokens: 12,
							},
							reasoning_tokens: "result-thinking",
							responseMessages: [
								{
									role: "assistant",
									content: [
										{
											type: "reasoning",
											text: "result-thinking",
											providerOptions: {
												google: { thoughtSignature: "result-signature" },
											},
										},
										{ type: "text", text: "raw result response" },
									],
								},
							],
						} as any;
					},
					typeText: async () => {},
					readIdentifierInputByRef: async () => ({
						value: "user@example.com",
						editable: true,
					}),
					click: async () => {},
					waitForAllOpenTabsToSettle: async () => {},
					assertPasswordInputRef: async () => {},
				},
			});

			assert.isTrue(result.handled);
			assert.include(callers, "authTakeover:probe:step2");
			assert.include(callers, "authTakeover:result:step3");
			assert.strictEqual(result.traceEntries[0]?.step, 2);
			assert.strictEqual(result.traceEntries[0]?.stage, "probe");
			assert.strictEqual(result.traceEntries[1]?.step, 3);
			assert.strictEqual(result.traceEntries[1]?.stage, "result");
			const probeAssistantMessage = (
				result.traceEntries[0]?.messages ?? []
			).find(
				(message) =>
					(message as { role?: unknown }).role === "assistant",
			) as
				| { content?: Array<Record<string, unknown>> }
				| undefined;
			const resultAssistantMessage = (
				result.traceEntries[1]?.messages ?? []
			).find(
				(message) =>
					(message as { role?: unknown }).role === "assistant",
			) as
				| { content?: Array<Record<string, unknown>> }
				| undefined;
			assert.deepInclude(probeAssistantMessage?.content?.[0], {
				type: "reasoning",
				text: "probe-thinking",
				providerOptions: {
					anthropic: { signature: "probe-signature" },
				},
			});
			assert.deepInclude(resultAssistantMessage?.content?.[0], {
				type: "reasoning",
				text: "result-thinking",
				providerOptions: {
					google: { thoughtSignature: "result-signature" },
				},
			});
			assert.notProperty(probeAssistantMessage ?? {}, "reasoning_tokens");
			assert.notProperty(resultAssistantMessage ?? {}, "reasoning_tokens");
		});
	});

	it("never leaks secrets in auth takeover logs", async () => {
		await withAuthEncryptionKey(async () => {
			const logs: string[] = [];
			const secretDomain =
				"https://login.example.com/sign-in?tenant=private-workspace";
			const sessionAuth = createAuthSession({
				enabled: true,
				credentials: {
					mode: "plaintext",
					domainUrl: secretDomain,
					username: "secret-user@example.com",
					password: "ultra-secret-password",
				},
			})!;

			await attemptAutomatedAuthTakeover({
				deps: {
					getPageProjection: async () => "div: no form found",
					getCurrentURL: async () =>
						"https://login.example.com/sign-in?token=top-secret",
				},
				browser: {} as any,
				sessionAuth,
				hooks: {
					log: (message) => {
						logs.push(message);
					},
				},
			});

			assertNoSecretLeaksInText(JSON.stringify(logs), [
				"ultra-secret-password",
				"private-workspace",
				"token=top-secret",
			]);
		});
	});
});
