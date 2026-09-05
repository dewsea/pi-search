import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import type { SearchResult } from "../src/providers/types.js";
import { deduplicateResults, fetchWithTimeout, isPrivateIP, validateHttpUrl } from "../src/utils.js";

describe("Utility Suite — validateHttpUrl", () => {
	it("accepts valid public HTTP and HTTPS URLs", () => {
		const u1 = validateHttpUrl("https://example.com/search?q=test");
		assert.strictEqual(u1.hostname, "example.com");

		const u2 = validateHttpUrl("http://api.service.io/v1");
		assert.strictEqual(u2.hostname, "api.service.io");

		// Legitimate public domain names starting with digits (e.g. 10.example.com)
		const u3 = validateHttpUrl("https://10.example.com/docs");
		assert.strictEqual(u3.hostname, "10.example.com");

		// Public IP
		const u4 = validateHttpUrl("https://8.8.8.8/dns-query");
		assert.strictEqual(u4.hostname, "8.8.8.8");
	});

	it("rejects non-HTTP protocols", () => {
		assert.throws(() => validateHttpUrl("file:///etc/passwd"), /Unsupported URL protocol/);
		assert.throws(() => validateHttpUrl("ftp://example.com/resource"), /Unsupported URL protocol/);
		assert.throws(() => validateHttpUrl("javascript:alert(1)"), /Unsupported URL protocol/);
	});

	it("rejects URLs with credentials", () => {
		assert.throws(() => validateHttpUrl("https://user:pass@example.com/"), /must not include credentials/);
	});

	it("rejects private, loopback, and non-public IP addresses", () => {
		assert.throws(() => validateHttpUrl("http://127.0.0.1:8080"), /Blocked non-public IP access/);
		assert.throws(() => validateHttpUrl("http://0.0.0.0/"), /Blocked non-public IP access/);
		assert.throws(() => validateHttpUrl("http://10.0.0.1/"), /Blocked non-public IP access/);
		assert.throws(() => validateHttpUrl("http://172.16.1.1/"), /Blocked non-public IP access/);
		assert.throws(() => validateHttpUrl("http://192.168.1.1/"), /Blocked non-public IP access/);
		assert.throws(() => validateHttpUrl("http://169.254.169.254/"), /Blocked non-public IP access/);
		assert.throws(() => validateHttpUrl("http://[::1]/"), /Blocked non-public IP access/);
		assert.throws(() => validateHttpUrl("http://[fc00::1]/"), /Blocked non-public IP access/);
		assert.throws(() => validateHttpUrl("http://[fe80::1]/"), /Blocked non-public IP access/);
	});

	it("rejects single-label and non-public hostnames", () => {
		assert.throws(() => validateHttpUrl("http://localhost/api"), /Blocked non-public hostname/);
		assert.throws(() => validateHttpUrl("http://intranet/"), /Blocked non-public hostname/);
		assert.throws(() => validateHttpUrl("http://myrouter/admin"), /Blocked non-public hostname/);
		assert.throws(() => validateHttpUrl("http://service.local/"), /Blocked non-public hostname/);
		assert.throws(() => validateHttpUrl("http://service.internal/"), /Blocked non-public hostname/);
		assert.throws(() => validateHttpUrl("http://test.invalid/"), /Blocked non-public hostname/);
	});
});

describe("Utility Suite — isPrivateIP", () => {
	it("classifies private IPv4 addresses correctly", () => {
		assert.strictEqual(isPrivateIP("127.0.0.1"), true);
		assert.strictEqual(isPrivateIP("10.0.0.1"), true);
		assert.strictEqual(isPrivateIP("172.16.0.1"), true);
		assert.strictEqual(isPrivateIP("172.31.255.255"), true);
		assert.strictEqual(isPrivateIP("192.168.0.1"), true);
		assert.strictEqual(isPrivateIP("169.254.169.254"), true);
		assert.strictEqual(isPrivateIP("0.0.0.0"), true);
		assert.strictEqual(isPrivateIP("100.64.0.1"), true);
		assert.strictEqual(isPrivateIP("198.18.0.1"), true);
		assert.strictEqual(isPrivateIP("224.0.0.1"), true);
		assert.strictEqual(isPrivateIP("240.0.0.1"), true);

		// Public IPv4
		assert.strictEqual(isPrivateIP("8.8.8.8"), false);
		assert.strictEqual(isPrivateIP("1.1.1.1"), false);
		assert.strictEqual(isPrivateIP("172.32.0.1"), false);
	});

	it("classifies IPv6 addresses correctly", () => {
		assert.strictEqual(isPrivateIP("::1"), true);
		assert.strictEqual(isPrivateIP("fe80::1"), true);
		assert.strictEqual(isPrivateIP("fc00::1"), true);
		assert.strictEqual(isPrivateIP("fd12::1"), true);
		assert.strictEqual(isPrivateIP("2001:db8::1"), true);
		assert.strictEqual(isPrivateIP("::ffff:192.168.1.1"), true);
		assert.strictEqual(isPrivateIP("::ffff:10.0.0.1"), true);

		// Public IPv6
		assert.strictEqual(isPrivateIP("2607:f8b0:4005:805::200e"), false);
	});
});

describe("Utility Suite — deduplicateResults", () => {
	it("deduplicates results case-insensitively by URL, preserving first occurrence", () => {
		const items: SearchResult[] = [
			{ title: "First", url: "https://example.com/page", snippet: "s1" },
			{ title: "Duplicate", url: "HTTPS://EXAMPLE.COM/PAGE", snippet: "s2" },
			{ title: "Other", url: "https://other.org", snippet: "s3" },
		];

		const deduped = deduplicateResults(items);
		assert.strictEqual(deduped.length, 2);
		assert.strictEqual(deduped[0].title, "First");
		assert.strictEqual(deduped[1].title, "Other");
	});

	it("returns empty array for empty input", () => {
		assert.deepStrictEqual(deduplicateResults([]), []);
	});
});

describe("Utility Suite — fetchWithTimeout", () => {
	let originalFetch: typeof global.fetch;

	before(() => {
		originalFetch = global.fetch;
	});

	after(() => {
		global.fetch = originalFetch;
	});

	it("should succeed if network request completes under the timeout", async () => {
		global.fetch = async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return new Response("Done");
		};

		const res = await fetchWithTimeout("https://test.com", {}, 100);
		assert.strictEqual(res.status, 200);
		assert.strictEqual(await res.text(), "Done");
	});

	it("should reject with timeout error if request takes too long", async () => {
		global.fetch = async () => {
			await new Promise((resolve) => setTimeout(resolve, 100));
			return new Response("Slow");
		};

		await assert.rejects(fetchWithTimeout("https://test.com", {}, 10), /timed out after 10ms/);
	});

	it("should propagate caller cancellation even when the transport ignores its signal", async () => {
		const controller = new AbortController();
		global.fetch = async () => new Promise<Response>(() => undefined);
		const request = fetchWithTimeout("https://test.com", { signal: controller.signal }, 1000);
		setTimeout(() => controller.abort(new Error("cancelled by caller")), 10);

		await assert.rejects(request, /cancelled by caller/);
	});

	it("should keep the timeout active while reading the response body", async () => {
		global.fetch = async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("partial"));
					},
				}),
			);

		await assert.rejects(fetchWithTimeout("https://test.com", {}, 10), /timed out after 10ms/);
	});

	it("should reject declared and streamed responses above the byte budget", async () => {
		global.fetch = async () => new Response("12345", { headers: { "Content-Length": "5" } });
		await assert.rejects(fetchWithTimeout("https://test.com", {}, 100, 4), /PAYLOAD_TOO_LARGE/);

		global.fetch = async () => new Response("12345");
		await assert.rejects(fetchWithTimeout("https://test.com", {}, 100, 4), /PAYLOAD_TOO_LARGE/);
	});
});
