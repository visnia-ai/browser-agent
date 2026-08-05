import assert from "node:assert/strict";
import test from "node:test";
import {
	asBrowserAgentError,
	BrowserAgentError,
	redact,
} from "../src/errors.js";

test("redacts secrets and paths and normalizes unknown errors", () => {
	assert.equal(
		redact("secret /tmp/private", ["", "secret"], ["", "/tmp/private"]),
		"<redacted> <internal>",
	);
	const existing = new BrowserAgentError("CANCELLED", "cancelled", {
		details: { attempt: 1 },
		cause: "cause",
	});
	assert.equal(
		asBrowserAgentError(existing, "PROCESS_EXITED", [], []),
		existing,
	);
	const normalized = asBrowserAgentError(
		new Error("secret"),
		"PROCESS_EXITED",
		["secret"],
		[],
	);
	assert.equal(normalized.message, "<redacted>");
	assert(normalized.cause instanceof Error);
	const primitive = asBrowserAgentError(42, "PROCESS_EXITED", [], []);
	assert.equal(primitive.message, "42");
	assert.equal(primitive.cause, undefined);
});
