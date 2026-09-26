// Consumes the build output the way an installed package is consumed: by
// package name, so the "exports" map resolves each entry point, and the
// emitted specifiers and the published surface all get exercised. Run with
// `npm run test:dist`, which builds first.

import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { test } from "node:test";

import * as core from "firefly-limiter";
import * as http from "firefly-limiter/http";

// Update these lists by hand: a name added or removed here is a change to the
// package's public API, and semver applies to it.
const coreSurface = [
	"Bulkhead",
	"BulkheadFullError",
	"CircuitBreaker",
	"CircuitOpenError",
	"Dependency",
	"FireflyError",
	"HedgeAbandonedError",
	"RateLimitError",
	"RateLimiter",
	"RetryBudget",
	"SingleFlight",
	"TimeoutError",
	"constant",
	"exponential",
	"fallback",
	"fromList",
	"hedge",
	"kindOf",
	"retry",
	"retryAnything",
	"stack",
	"systemClock",
	"tag",
	"timeout",
];

const httpSurface = [
	"RetryableResponseError",
	"byRequest",
	"idempotentMethods",
	"parseRetryAfter",
	"retryableApiError",
	"retryableStatuses",
	"retryableTransportError",
	"transport",
];

const noWait = core.constant(0, { jitter: "none" });

test("the built core entry point exports exactly the intended surface", () => {
	assert.deepEqual(Object.keys(core).sort(), [...coreSurface].sort());
});

test("the built http entry point exports exactly the intended surface", () => {
	assert.deepEqual(Object.keys(http).sort(), [...httpSurface].sort());
});

test("type declarations are emitted where package.json points", async () => {
	await access(new URL("../../dist/types/index.d.ts", import.meta.url));
	await access(new URL("../../dist/types/http.d.ts", import.meta.url));
});

test("a retry through the built artifact succeeds on the third attempt", async () => {
	let calls = 0;
	const call = core.retry({ attempts: 3, backoff: noWait, shouldRetry: core.retryAnything })(
		async () => {
			calls += 1;
			if (calls < 3) throw new Error("not yet");
			return "done";
		}
	);

	assert.equal(await call(), "done");
	assert.equal(calls, 3);
});

test("the caller's own error comes back out of the built artifact unchanged", async () => {
	const mine = new RangeError("mine");
	const call = core.retry({ attempts: 2, backoff: noWait, shouldRetry: core.retryAnything })(
		async () => {
			throw mine;
		}
	);

	await assert.rejects(call(), (error) => error === mine);
});

test("errors thrown by the built artifact are catchable by type", async () => {
	const call = core.timeout(1)(() => new Promise(() => {}));

	await assert.rejects(
		call(),
		(error) => error instanceof core.TimeoutError && error instanceof core.FireflyError
	);
});

test("the built http transport retries a 503 into a 200", async () => {
	const statuses = [503, 200];
	let sent = 0;
	const send = http.transport(
		async () => new Response(null, { status: statuses[sent++] }),
		core.retry({ attempts: 2, backoff: noWait, shouldRetry: core.retryAnything })
	);

	const response = await send(new Request("https://api.test/things"));

	assert.equal(response.status, 200);
	assert.equal(sent, 2);
});
