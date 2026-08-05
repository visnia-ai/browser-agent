import { assert } from "chai";
import { describe, it } from "mocha";
import {
	createPortAllocator,
	NoAvailablePortError,
} from "../src/port-allocation.js";

describe("port allocation", () => {
	it("picks the first free port in low-to-high order", async () => {
		const allocator = createPortAllocator({
			isPortInUse: async (port) => port === 9000 || port === 9001,
			minPort: 9000,
			maxPort: 9003,
		});

		assert.strictEqual(await allocator.acquirePort(), 9002);
	});

	it("skips ports already reserved in-process", async () => {
		const allocator = createPortAllocator({
			isPortInUse: async () => false,
			minPort: 9000,
			maxPort: 9002,
		});

		const first = await allocator.acquirePort();
		const second = await allocator.acquirePort();

		assert.strictEqual(first, 9000);
		assert.strictEqual(second, 9001);
	});

	it("reuses a released port", async () => {
		const allocator = createPortAllocator({
			isPortInUse: async () => false,
			minPort: 9000,
			maxPort: 9001,
		});

		const first = await allocator.acquirePort();
		allocator.releasePort(first);

		assert.strictEqual(await allocator.acquirePort(), 9000);
	});

	it("errors when the range is exhausted", async () => {
		const allocator = createPortAllocator({
			isPortInUse: async () => true,
			minPort: 9000,
			maxPort: 9001,
		});

		try {
			await allocator.acquirePort();
			assert.fail("expected allocator to throw");
		} catch (error) {
			assert.instanceOf(error, NoAvailablePortError);
			assert.strictEqual(
				(error as Error).message,
				"No available Chrome debugging port found in range 9000-9001.",
			);
		}
	});
});
