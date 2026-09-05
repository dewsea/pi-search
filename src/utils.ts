import type { SearchResult } from "./providers/types.js";

export const MAX_DIRECT_RESPONSE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

export function deduplicateResults(allResults: SearchResult[]): SearchResult[] {
	const seen = new Set<string>();
	const unique: SearchResult[] = [];
	for (const r of allResults) {
		const key = r.url.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			unique.push(r);
		}
	}
	return unique;
}

type IPv4Address = [number, number, number, number];

function stripIpBrackets(ip: string): string {
	const trimmed = ip.trim();
	return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
}

function parseIPv4(ip: string): IPv4Address | null {
	const parts = ip.split(".");
	if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return null;
	const values = parts.map(Number);
	if (values.some((value) => value < 0 || value > 255)) return null;
	return values as IPv4Address;
}

function parseIPv6Groups(ip: string): number[] | null {
	const halves = ip.split("::");
	if (halves.length > 2) return null;

	const parsePart = (part: string): number[] | null => {
		if (!part) return [];
		const groups = part.split(":");
		const lastGroup = groups.at(-1);
		if (lastGroup?.includes(".")) {
			const ipv4 = parseIPv4(lastGroup);
			if (!ipv4) return null;
			groups.splice(
				groups.length - 1,
				1,
				((ipv4[0] << 8) | ipv4[1]).toString(16),
				((ipv4[2] << 8) | ipv4[3]).toString(16),
			);
		}

		const values = groups.map((group) => {
			if (!/^[0-9a-f]{1,4}$/i.test(group)) return -1;
			return Number.parseInt(group, 16);
		});
		return values.some((value) => value < 0) ? null : values;
	};

	const left = parsePart(halves[0]);
	const right = parsePart(halves.length === 2 ? halves[1] : "");
	if (!left || !right) return null;

	const totalGroups = left.length + right.length;
	if (halves.length === 1) {
		return totalGroups === 8 ? [...left, ...right] : null;
	}
	if (totalGroups >= 8) return null;
	return [...left, ...new Array(8 - totalGroups).fill(0), ...right];
}

type IPv4Cidr = readonly [address: IPv4Address, prefixLength: number];

// Deny every IPv4 range that is private, local, shared, documentation-only,
// benchmarking, multicast, or reserved.
const NON_PUBLIC_IPV4_CIDRS: readonly IPv4Cidr[] = [
	[[0, 0, 0, 0], 8],
	[[10, 0, 0, 0], 8],
	[[100, 64, 0, 0], 10],
	[[127, 0, 0, 0], 8],
	[[169, 254, 0, 0], 16],
	[[172, 16, 0, 0], 12],
	[[192, 0, 0, 0], 24],
	[[192, 0, 2, 0], 24],
	[[192, 88, 99, 0], 24],
	[[192, 168, 0, 0], 16],
	[[198, 18, 0, 0], 15],
	[[198, 51, 100, 0], 24],
	[[203, 0, 113, 0], 24],
	[[224, 0, 0, 0], 4],
	[[240, 0, 0, 0], 4],
];

// Special-purpose ranges inside today's global-unicast 2000::/3 allocation.
// Addresses outside 2000::/3 are denied separately instead of assuming that
// unallocated IPv6 space is publicly routable.
const NON_PUBLIC_GLOBAL_UNICAST_IPV6_CIDRS = [
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
	["3fff::", 20],
] as const;

function ipv4ToNumber([a, b, c, d]: IPv4Address): number {
	return (((a * 256 + b) * 256 + c) * 256 + d) >>> 0;
}

function isIPv4InCidr(address: IPv4Address, [base, prefixLength]: IPv4Cidr): boolean {
	const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
	return (ipv4ToNumber(address) & mask) === (ipv4ToNumber(base) & mask);
}

function isPrivateIPv4(address: IPv4Address): boolean {
	return NON_PUBLIC_IPV4_CIDRS.some((cidr) => isIPv4InCidr(address, cidr));
}

function ipv6ToBigInt(groups: readonly number[]): bigint {
	return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
}

function isIPv6InCidr(address: readonly number[], baseText: string, prefixLength: number): boolean {
	const base = parseIPv6Groups(baseText);
	if (!base) throw new Error(`Invalid internal IPv6 CIDR base: ${baseText}`);
	const shift = BigInt(128 - prefixLength);
	return ipv6ToBigInt(address) >> shift === ipv6ToBigInt(base) >> shift;
}

export function isPrivateIP(ip: string): boolean {
	const normalized = stripIpBrackets(ip).split("%", 1)[0];
	const ipv4 = parseIPv4(normalized);
	if (ipv4) return isPrivateIPv4(ipv4);

	const ipv6 = parseIPv6Groups(normalized);
	if (!ipv6) return true;

	// IPv4-mapped IPv6 addresses must use the same IPv4 policy.
	const isMappedIPv4 = ipv6.slice(0, 5).every((group) => group === 0) && ipv6[5] === 0xffff;
	if (isMappedIPv4) {
		const mapped: IPv4Address = [ipv6[6] >> 8, ipv6[6] & 0xff, ipv6[7] >> 8, ipv6[7] & 0xff];
		return isPrivateIPv4(mapped);
	}

	if (!isIPv6InCidr(ipv6, "2000::", 3)) return true;
	return NON_PUBLIC_GLOBAL_UNICAST_IPV6_CIDRS.some(([base, prefixLength]) => isIPv6InCidr(ipv6, base, prefixLength));
}

export const NON_PUBLIC_HOST_SUFFIXES = [
	".localhost",
	".local",
	".internal",
	".home.arpa",
	".test",
	".invalid",
	".example",
];

export function validateHttpUrl(urlStr: string): URL {
	const url = new URL(urlStr);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Unsupported URL protocol: ${url.protocol}`);
	}
	if (url.username || url.password) {
		throw new Error("URL must not include credentials");
	}
	const hostname = url.hostname;
	if (!hostname) throw new Error("URL must include a hostname");

	const normalizedHostname = stripIpBrackets(hostname);
	const isIP = parseIPv4(normalizedHostname) !== null || parseIPv6Groups(normalizedHostname) !== null;
	if (isIP && isPrivateIP(normalizedHostname)) {
		throw new Error(`Blocked non-public IP access: ${hostname}`);
	}
	if (!isIP) {
		const canonicalHostname = normalizedHostname.toLowerCase().replace(/\.$/, "");
		if (
			!canonicalHostname.includes(".") ||
			canonicalHostname === "localhost" ||
			NON_PUBLIC_HOST_SUFFIXES.some((suffix) => canonicalHostname.endsWith(suffix))
		) {
			throw new Error(`Blocked non-public hostname: ${hostname}`);
		}
	}
	return url;
}

async function bufferResponseWithLimit(response: Response, maxResponseBytes: number): Promise<Response> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
		await response.body?.cancel().catch(() => undefined);
		throw new Error(`PAYLOAD_TOO_LARGE: response exceeds ${maxResponseBytes} bytes`);
	}
	if (!response.body) return response;

	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		totalBytes += value.byteLength;
		if (totalBytes > maxResponseBytes) {
			await reader.cancel().catch(() => undefined);
			throw new Error(`PAYLOAD_TOO_LARGE: response exceeds ${maxResponseBytes} bytes`);
		}
		chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
	}

	const body =
		totalBytes === 0 && [204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks, totalBytes);
	const buffered = new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
	if (response.url) Object.defineProperty(buffered, "url", { value: response.url });
	return buffered;
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Network request aborted");
}

/**
 * Bound network requests by timeout and total response byte size, returning
 * a fully buffered Response.
 */
export async function fetchWithTimeout(
	url: string,
	options: RequestInit = {},
	timeoutMs: number = DEFAULT_PROVIDER_TIMEOUT_MS,
	maxResponseBytes: number = MAX_DIRECT_RESPONSE_BYTES,
): Promise<Response> {
	const timeoutController = new AbortController();
	let timeoutReject: ((error: Error) => void) | undefined;
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeoutReject = reject;
	});
	const timer = setTimeout(() => {
		timeoutController.abort(new Error("timeout"));
		timeoutReject?.(new Error(`Network request timed out after ${timeoutMs}ms`));
	}, timeoutMs);

	const signal = options.signal
		? AbortSignal.any([options.signal, timeoutController.signal])
		: timeoutController.signal;

	let removeCallerAbortListener: (() => void) | undefined;
	const callerSignal = options.signal;
	const callerAbortPromise = callerSignal
		? new Promise<never>((_resolve, reject) => {
				const onAbort = () => reject(abortReason(callerSignal));
				if (callerSignal.aborted) {
					onAbort();
					return;
				}
				callerSignal.addEventListener("abort", onAbort, { once: true });
				removeCallerAbortListener = () => callerSignal.removeEventListener("abort", onAbort);
			})
		: undefined;

	try {
		const request = (async () => {
			const response = await fetch(url, { ...options, signal });
			return bufferResponseWithLimit(response, maxResponseBytes);
		})();
		// Attach catch handler to avoid unhandledRejection if abort/timeout wins the race
		request.catch(() => {});
		const pending = callerAbortPromise ? [request, timeoutPromise, callerAbortPromise] : [request, timeoutPromise];
		return await Promise.race(pending);
	} catch (err) {
		if (timeoutController.signal.aborted && !options.signal?.aborted) {
			throw new Error(`Network request timed out after ${timeoutMs}ms`, { cause: err });
		}
		throw err;
	} finally {
		clearTimeout(timer);
		removeCallerAbortListener?.();
	}
}
