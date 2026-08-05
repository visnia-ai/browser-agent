import { assert } from "chai";
import { describe, it } from "mocha";
import {
	LOCAL_CDP_HOST,
	withLocalCdpHost,
} from "../src/browser/local-cdp.js";

describe("local CDP options", () => {
	it("uses IPv4 loopback for local debugging-port connections", () => {
		assert.deepEqual(withLocalCdpHost({ port: 40000 }), {
			host: "127.0.0.1",
			port: 40000,
		});
		assert.strictEqual(LOCAL_CDP_HOST, "127.0.0.1");
	});
});
