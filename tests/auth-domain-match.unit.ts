import { assert } from "chai";
import { describe, it } from "mocha";
import { authDomainsMatch } from "../src/auth/domain-match.js";

describe("authDomainsMatch", () => {
	it("matches identical login URLs", () => {
		assert.isTrue(
			authDomainsMatch({
				configuredUrl: "https://login.example.com/sign-in",
				currentUrl: "https://login.example.com/sign-in",
			}),
		);
	});

	it("matches different subdomains on the same registrable domain", () => {
		assert.isTrue(
			authDomainsMatch({
				configuredUrl: "https://accounts.example.com/login",
				currentUrl: "https://app.example.com/dashboard",
			}),
		);
	});

	it("does not match different registrable domains", () => {
		assert.isFalse(
			authDomainsMatch({
				configuredUrl: "https://login.example.com/sign-in",
				currentUrl: "https://accounts.other.test/login",
			}),
		);
	});

	it("falls back to exact hostname equality when a registrable domain cannot be derived", () => {
		assert.isTrue(
			authDomainsMatch({
				configuredUrl: "http://localhost:3000/login",
				currentUrl: "http://localhost:9222/dashboard",
			}),
		);
		assert.isFalse(
			authDomainsMatch({
				configuredUrl: "http://localhost:3000/login",
				currentUrl: "http://127.0.0.1:9222/dashboard",
			}),
		);
	});

	it("returns false when either URL is invalid", () => {
		assert.isFalse(
			authDomainsMatch({
				configuredUrl: "not-a-url",
				currentUrl: "https://login.example.com/sign-in",
			}),
		);
		assert.isFalse(
			authDomainsMatch({
				configuredUrl: "https://login.example.com/sign-in",
				currentUrl: "still-not-a-url",
			}),
		);
	});

	it("matches when the configured URL is missing an http/https prefix", () => {
		assert.isTrue(
			authDomainsMatch({
				configuredUrl: "login.example.com/sign-in",
				currentUrl: "https://login.example.com/sign-in",
			}),
		);
		assert.isTrue(
			authDomainsMatch({
				configuredUrl: "login.example.com",
				currentUrl: "https://app.example.com/dashboard",
			}),
		);
	});

	it("matches when the current URL is missing an http/https prefix", () => {
		assert.isTrue(
			authDomainsMatch({
				configuredUrl: "https://login.example.com/sign-in",
				currentUrl: "login.example.com/sign-in",
			}),
		);
		assert.isTrue(
			authDomainsMatch({
				configuredUrl: "https://accounts.example.com/login",
				currentUrl: "app.example.com/dashboard",
			}),
		);
	});

	it("matches multi-level public suffix domains by registrable domain", () => {
		assert.isTrue(
			authDomainsMatch({
				configuredUrl: "https://auth.service.co.uk/login",
				currentUrl: "https://app.service.co.uk/home",
			}),
		);
		assert.isFalse(
			authDomainsMatch({
				configuredUrl: "https://auth.service.co.uk/login",
				currentUrl: "https://app.other.co.uk/home",
			}),
		);
	});
});
