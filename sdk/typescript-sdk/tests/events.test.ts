import assert from "node:assert/strict";
import test from "node:test";
import { ReplayEvents } from "../src/events.js";

test("streams, replays, closes, and ignores post-close publications", async () => {
	const events = new ReplayEvents<number>();
	const live: number[] = [];
	const reading = (async () => {
		for await (const value of events.iterate()) live.push(value);
	})();
	await new Promise((resolve) => setImmediate(resolve));
	events.publish(1);
	events.publish(2);
	events.close();
	events.publish(3);
	await reading;
	assert.deepEqual(live, [1, 2]);
	const replay = [];
	for await (const value of events.iterate()) replay.push(value);
	assert.deepEqual(replay, [1, 2]);
});
