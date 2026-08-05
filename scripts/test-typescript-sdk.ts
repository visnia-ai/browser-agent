import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserAgent } from "../sdk/typescript-sdk/src/index.js";

const downloads = await mkdtemp(join(tmpdir(), "browser-agent-sdk-test-"));

try {
	const agent = new BrowserAgent({
		provider: "openai",
		model: "gpt-5.5",
		headless: false,
		downloadDirectory: downloads,
	});
	const run = agent.run({
		task: "Open the page and return its title.",
		url: "https://example.com",
	});

	const result = await run.result;
	console.log(JSON.stringify(result, null, 2));
} finally {
	await rm(downloads, { recursive: true, force: true });
}
