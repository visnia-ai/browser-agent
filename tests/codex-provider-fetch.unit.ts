import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import {
	__createCodexFetchForTests,
	runProviderChat,
	setCodexProviderRuntime,
	type CodexCredentials,
} from "../src/agents/providers/ai-sdk.js";

describe("Codex provider fetch", () => {
	afterEach(() => {
		setCodexProviderRuntime(null);
	});

	it("adds Codex identity and OAuth headers without leaking replaced headers", async () => {
		const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
		setCodexProviderRuntime({
			async getCredentials() {
				return {
					accessToken: "oauth-token",
					accountId: "account-id",
					version: "1.2.3",
				};
			},
			async refreshCredentials() {},
		});
		const codexFetch = __createCodexFetchForTests(async (input, init) => {
			calls.push({ input, init });
			return new Response("ok", { status: 200 });
		});

		await codexFetch(
			"https://chatgpt.com/backend-api/codex/responses",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer placeholder",
					"Content-Type": "application/json",
				},
				body: "{}",
			},
		);

		assert.lengthOf(calls, 1);
		assert.equal(
			calls[0].input,
			"https://chatgpt.com/backend-api/codex/responses",
		);
		const headers = new Headers(calls[0].init?.headers);
		assert.equal(headers.get("Authorization"), "Bearer oauth-token");
		assert.equal(headers.get("ChatGPT-Account-ID"), "account-id");
		assert.equal(headers.get("originator"), "codex_cli_rs");
		assert.equal(headers.get("version"), "1.2.3");
		assert.equal(headers.get("User-Agent"), "codex_cli_rs/1.2.3");
		assert.equal(headers.get("OpenAI-Beta"), "responses=experimental");
		assert.match(headers.get("session_id") ?? "", /^[0-9a-f-]{36}$/);
		assert.match(
			headers.get("x-client-request-id") ?? "",
			/^[0-9a-f-]{36}$/,
		);
	});

	it("refreshes once after 401 and retries with the same request identity", async () => {
		let credentials: CodexCredentials = {
			accessToken: "expired-token",
			accountId: "account-id",
			version: "1.2.3",
		};
		let refreshCount = 0;
		const headersSeen: Headers[] = [];
		setCodexProviderRuntime({
			async getCredentials() {
				return credentials;
			},
			async refreshCredentials() {
				refreshCount += 1;
				credentials = { ...credentials, accessToken: "fresh-token" };
			},
		});
		const codexFetch = __createCodexFetchForTests(async (_input, init) => {
			headersSeen.push(new Headers(init?.headers));
			return new Response(null, {
				status: headersSeen.length === 1 ? 401 : 200,
			});
		});

		const response = await codexFetch(
			"https://chatgpt.com/backend-api/codex/responses",
		);

		assert.equal(response.status, 200);
		assert.equal(refreshCount, 1);
		assert.lengthOf(headersSeen, 2);
		assert.equal(headersSeen[0].get("Authorization"), "Bearer expired-token");
		assert.equal(headersSeen[1].get("Authorization"), "Bearer fresh-token");
		assert.equal(
			headersSeen[0].get("x-client-request-id"),
			headersSeen[1].get("x-client-request-id"),
		);
		assert.equal(
			headersSeen[0].get("session_id"),
			headersSeen[1].get("session_id"),
		);
	});

	it("single-flights concurrent credential refresh", async () => {
		let credentials: CodexCredentials = {
			accessToken: "expired-token",
			accountId: "account-id",
			version: "1.2.3",
		};
		let refreshCount = 0;
		let releaseRefresh!: () => void;
		const refreshBarrier = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		setCodexProviderRuntime({
			async getCredentials() {
				return credentials;
			},
			async refreshCredentials() {
				refreshCount += 1;
				await refreshBarrier;
				credentials = { ...credentials, accessToken: "fresh-token" };
			},
		});
		const attempts = new Map<string, number>();
		const codexFetch = __createCodexFetchForTests(async (_input, init) => {
			const headers = new Headers(init?.headers);
			const requestId = headers.get("x-client-request-id") ?? "";
			const count = (attempts.get(requestId) ?? 0) + 1;
			attempts.set(requestId, count);
			return new Response(null, { status: count === 1 ? 401 : 200 });
		});

		const requests = [
			codexFetch("https://chatgpt.com/backend-api/codex/responses"),
			codexFetch("https://chatgpt.com/backend-api/codex/responses"),
		];
		await new Promise((resolve) => setImmediate(resolve));
		releaseRefresh();
		const responses = await Promise.all(requests);

		assert.deepEqual(
			responses.map((response) => response.status),
			[200, 200],
		);
		assert.equal(refreshCount, 1);
		assert.equal(attempts.size, 2);
	});

	it("requires initialized auth and redacts invalid credential values", async () => {
		const codexFetch = __createCodexFetchForTests(async () =>
			new Response(null, { status: 200 }),
		);
		try {
			await codexFetch("https://chatgpt.com/backend-api/codex/responses");
			assert.fail("expected uninitialized auth to be rejected");
		} catch (error) {
			assert.include(
				(error as Error).message,
				"authentication has not been initialized",
			);
		}

		setCodexProviderRuntime({
			async getCredentials() {
				return {
					accessToken: "secret-with-newline\n",
					accountId: "account-id",
					version: "1.2.3",
				};
			},
			async refreshCredentials() {},
		});
		try {
			await codexFetch("https://chatgpt.com/backend-api/codex/responses");
			assert.fail("expected invalid credentials to be rejected");
		} catch (error) {
			assert.include((error as Error).message, "invalid accessToken");
			assert.notInclude((error as Error).message, "secret-with-newline");
		}
	});

	it("calls the fixed Responses endpoint and parses streaming text and usage", async () => {
		const originalFetch = globalThis.fetch;
		let requestedUrl = "";
		let requestedBody: Record<string, unknown> = {};
		setCodexProviderRuntime({
			async getCredentials() {
				return {
					accessToken: "oauth-token",
					accountId: "account-id",
					version: "1.2.3",
				};
			},
			async refreshCredentials() {},
		});
		const events = [
			{
				type: "response.created",
				response: {
					id: "resp_1",
					created_at: 1_700_000_000,
					model: "gpt-5.6-luna",
					service_tier: null,
				},
			},
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_1", phase: "final_answer" },
			},
			{
				type: "response.output_text.delta",
				item_id: "msg_1",
				output_index: 0,
				delta: '{"ok":true}',
				logprobs: null,
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "message", id: "msg_1", phase: "final_answer" },
			},
			{
				type: "response.completed",
				response: {
					incomplete_details: null,
					usage: {
						input_tokens: 12,
						input_tokens_details: {
							cached_tokens: 3,
							cache_write_tokens: 0,
							orchestration_input_tokens: null,
							orchestration_input_cached_tokens: null,
						},
						output_tokens: 5,
						output_tokens_details: {
							reasoning_tokens: 2,
							orchestration_output_tokens: null,
						},
					},
					reasoning: null,
					service_tier: null,
				},
			},
		];
		const sse = `${events
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.join("")}data: [DONE]\n\n`;
		globalThis.fetch = (async (input, init) => {
			requestedUrl = String(input);
			requestedBody = JSON.parse(String(init?.body));
			return new Response(sse, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as typeof fetch;

		try {
			const chunks: string[] = [];
			const result = await runProviderChat({
				options: {
					provider: "codex",
					model: "gpt-5.6-luna",
					reasoningEffort: "high",
					reserveOutputTokens: 4_000,
				},
				prompt: "Return JSON.",
				onOutputChunk: (chunk) => chunks.push(chunk),
			});

			assert.equal(
				requestedUrl,
				"https://chatgpt.com/backend-api/codex/responses",
			);
			assert.equal(requestedBody.model, "gpt-5.6-luna");
			assert.equal(requestedBody.store, false);
			assert.equal(requestedBody.stream, true);
			assert.deepEqual(requestedBody.reasoning, {
				effort: "high",
				summary: "detailed",
			});
			assert.notProperty(requestedBody, "max_output_tokens");
			assert.notProperty(requestedBody, "prompt_cache_key");
			assert.deepEqual(requestedBody.include, [
				"reasoning.encrypted_content",
			]);
			assert.deepEqual(chunks, ['{"ok":true}']);
			assert.equal(result.content, '{"ok":true}');
			assert.deepEqual(result.usage, {
				input_tokens: 12,
				cached_input_tokens: 3,
				cache_write_tokens: 0,
				reasoning_tokens: 2,
				non_reasoning_output_tokens: 3,
				output_tokens: 5,
				total_tokens: 17,
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
