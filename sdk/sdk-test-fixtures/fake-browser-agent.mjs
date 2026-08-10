#!/usr/bin/env node

import fs from "node:fs";

const mode = process.env.SDK_FAKE_MODE || "success";

if (process.argv.includes("--version-json")) {
	process.stderr.write("version diagnostic\n");
	if (process.env.SDK_FAKE_VERSION_COUNT) {
		fs.appendFileSync(process.env.SDK_FAKE_VERSION_COUNT, "1\n");
	}
	process.stdout.write(
		`${JSON.stringify({
			version: "1.0.0",
			rpcProtocolVersion: mode === "version-mismatch" ? 999 : 1,
		})}\n`,
	);
	process.exit(0);
}

if (process.argv.includes("--sdk-self-test-json")) {
	process.stdout.write(
		`${JSON.stringify({
			sharp: true,
			tesseract: true,
			tiktoken: true,
			pdf: true,
			docx: true,
			xlsx: true,
		})}\n`,
	);
	process.exit(0);
}

if (process.argv.includes("codex-login")) {
	if (process.env.SDK_FAKE_AUTH_COUNT) {
		fs.appendFileSync(process.env.SDK_FAKE_AUTH_COUNT, "1\n");
	}
	const checking = process.argv.includes("--check");
	if (checking && mode !== "auth-wait" && mode !== "auth-fail") {
		process.stdout.write(
			`${JSON.stringify({ loggedIn: mode !== "auth-logged-out" })}\n`,
		);
	}
	if (!checking) process.stderr.write("Codex login preflight\n");
	if (mode === "auth-fail") process.exit(2);
	if (mode !== "auth-wait") process.exit(0);
	process.on("SIGTERM", () => process.exit(0));
	setInterval(() => undefined, 1_000);
	await new Promise(() => undefined);
}

const configPath = process.argv.find(
	(argument) =>
		argument !== process.argv[0] &&
		argument !== process.argv[1] &&
		argument !== "--rpc",
);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

if (process.env.SDK_FAKE_CAPTURE) {
	const keys = [
		"OPENAI_API_KEY",
		"ANTHROPIC_API_KEY",
		"GOOGLE_API_KEY",
		"TOGETHER_API_KEY",
		"VLLM_API_KEY",
	];
	fs.writeFileSync(
		process.env.SDK_FAKE_CAPTURE,
		JSON.stringify({
			config,
			environment: Object.fromEntries(
				keys
					.filter((key) => process.env[key])
					.map((key) => [key, process.env[key]]),
			),
		}),
	);
}

process.stderr.write(
	`diagnostic ${configPath} ${process.env.OPENAI_API_KEY || ""}\n`,
);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	input += chunk;
	if (!input.includes("\n")) return;
	const request = JSON.parse(input.split("\n")[0]);
	const requestTasks = request.params?.tasks ?? [];
	const credentials = requestTasks.flatMap((task) => task.credentials ?? []);
	if (process.env.SDK_FAKE_CAPTURE) {
		const captured = JSON.parse(
			fs.readFileSync(process.env.SDK_FAKE_CAPTURE, "utf8"),
		);
		fs.writeFileSync(
			process.env.SDK_FAKE_CAPTURE,
			JSON.stringify({
				...captured,
				requestCredentialCounts: requestTasks.map(
					(task) => task.credentials?.length ?? 0,
				),
			}),
		);
	}
	for (const credential of credentials) {
		process.stderr.write(
			`credential diagnostic ${credential.username} ${credential.password} ${credential.domain}\n`,
		);
	}
	if (mode === "malformed") {
		process.stdout.write("{bad json}\n");
		return;
	}
	if (mode === "invalid-message") {
		process.stdout.write(`${JSON.stringify({ jsonrpc: "1.0" })}\n`);
		return;
	}
	if (mode === "early-exit") process.exit(2);
	if (mode === "reject") {
		process.stdout.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				error: {
					code: -32000,
					message: `bad ${configPath}`,
					data: { code: "CHROME_NOT_FOUND" },
				},
			})}\n`,
		);
		return;
	}
	if (mode === "invalid-ack") {
		process.stdout.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`,
		);
		return;
	}
	process.stdout.write("\n");
	process.stdout.write(
		`${JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			result: { accepted: true },
		})}\n`,
	);
	if (mode === "rpc-error") {
		process.stdout.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				method: "browser-agent/error",
				params: { message: `failure ${configPath}` },
			})}\n`,
		);
		return;
	}
	process.stdout.write(
		`${JSON.stringify({
			jsonrpc: "2.0",
			method: "browser-agent/status",
			params: {
				task_id: "task-1",
				status: "user_takeover",
				reason: "Please continue.",
			},
		})}\n`,
	);
	const tasks =
		mode === "incomplete"
			? config.tasks.slice(0, -1)
			: [...config.tasks].reverse();
	for (const task of tasks) {
		const index = config.tasks.indexOf(task) + 1;
		const taskCredentials = requestTasks[index - 1]?.credentials ?? [];
		process.stdout.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				method: "browser-agent/task_result",
				params: {
					task_id: `task-${index}`,
					status: task.task.includes("fail") ? "failed" : "completed",
					runs: [
						{
							run_index: 1,
							yaml_result: `answer: ${index}`,
							data: { answer: index },
							completed: true,
							successful: true,
							validator: {
								ran: true,
								success: true,
								summary: "Verified.",
							},
						},
					],
					errors: taskCredentials.length
						? taskCredentials.map(
								(credential) =>
									`credential error ${credential.username} ${credential.password} ${credential.domain}`,
							)
						: task.task.includes("fail")
							? ["failed"]
							: [],
				},
			})}\n`,
		);
		if (mode === "wait") break;
	}
	if (mode === "wait") return;
	process.stdout.write(
		`${JSON.stringify({
			jsonrpc: "2.0",
			method: "browser-agent/all_tasks_completed",
			params: {},
		})}\n`,
		() => process.exit(mode === "nonzero-complete" ? 2 : 0),
	);
});

process.on("SIGTERM", () => process.exit(0));
