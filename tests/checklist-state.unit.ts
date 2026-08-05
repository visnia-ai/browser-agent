import { assert } from "chai";
import { describe, it } from "mocha";
import {
	applyChecklistUpdate,
	applyVerifierChecklistChanges,
	createChecklistItems,
	formatChecklistForPrompt,
	normalizeChecklistDraft,
	normalizeChecklistUpdate,
	replaceChecklistPreservingDone,
} from "../src/core/checklist-state.js";

describe("checklist state", () => {
	it("normalizes concise checklist drafts and assigns stable ids", () => {
		const draft = normalizeChecklistDraft({
			items: [" Return all matches. ", "Return all matches.", "Include links."],
		});
		assert.deepEqual(draft, {
			items: ["Return all matches.", "Include links."],
		});
		assert.deepEqual(createChecklistItems(draft!.items), [
			{ id: "C1", requirement: "Return all matches.", status: "TODO" },
			{ id: "C2", requirement: "Include links.", status: "TODO" },
		]);
	});

	it("accepts only known delta ids and applies done/regressed updates", () => {
		const items = createChecklistItems(["One", "Two"]);
		const update = normalizeChecklistUpdate(
			{ c1: "DONE", C2: "regressed", C9: "done", C3: "other" },
			items,
		);
		assert.deepEqual(update, { C1: "done", C2: "regressed" });
		applyChecklistUpdate(items, update);
		assert.deepEqual(formatChecklistForPrompt(items), [
			"[DONE] C1 One",
			"[REGRESSED] C2 Two",
		]);
	});

	it("reopens and extends the cumulative checklist without duplicates", () => {
		const items = createChecklistItems(["One", "Two"]);
		items[1].status = "DONE";
		const result = applyVerifierChecklistChanges({
			items,
			reopenIds: ["c2", "C9"],
			addRequirements: ["Three", " one "],
		});
		assert.deepEqual(result, { reopenedIds: ["C2"], addedIds: ["C3"] });
		assert.deepEqual(items, [
			{ id: "C1", requirement: "One", status: "TODO" },
			{ id: "C2", requirement: "Two", status: "TODO" },
			{ id: "C3", requirement: "Three", status: "TODO" },
		]);
	});

	it("preserves completed requirements during rare verifier regeneration", () => {
		const items = createChecklistItems(["Keep this result", "Replace this gap"]);
		items[0].status = "DONE";
		items[1].status = "REGRESSED";

		assert.deepEqual(
			replaceChecklistPreservingDone(items, [
				"Keep this result",
				"A corrected requirement",
			]),
			[
				{ id: "C1", requirement: "Keep this result", status: "DONE" },
				{
					id: "C3",
					requirement: "A corrected requirement",
					status: "TODO",
				},
			],
		);
	});
});
