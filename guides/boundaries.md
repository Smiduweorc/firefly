---
title: Boundaries
---

# Boundaries

## Not included

- I/O. The action you pass in does the work: a `fetch`, an `ApiClient` call, a
  database query, anything returning a promise.
- What counts as a failure. That is your `shouldRetry`.
  `firefly-limiter/http` exports an HTTP one, `retryableTransportError`.
- Wrapping your errors. The last failure is rethrown unchanged; see
  [Concepts](./concepts.md).
- Logging and metrics. Nothing is written to stdout. `onEvent` receives every
  decision as a plain value.
- Configuration. Nothing reads `process.env`, which would break in browsers
  and bundlers. The numbers go in the options object.
- State across processes. See below.
- Caching, freshness, `ETag` and `Vary`. Use your data layer,
  [Repletes](https://github.com/Smiduweorc/Repletes), or a separate transport
  decorator. `SingleFlight` collapses concurrent calls and keeps nothing once
  they settle.
- Registries, singletons and patching `globalThis.fetch`. Two libraries in one
  process would share a breaker without knowing it. Construct a policy and pass
  it where it is used.
- Work at import time. Importing starts no timer and allocates no state.
- The numbers. Attempts, deadlines and bulkhead sizes have no defaults.

## One process

Everything Firefly holds is in memory in one process. With one instance that
is the same as fleet-wide. With N replicas, each has its own breaker, bulkhead,
rate limiter and retry budget, so an outage gets N recovery probes and up to N
times the retries, and a rate limit of 10 per second becomes 10N. Each replica
still protects itself.

A distributed limiter needs a store, a clock the machines agree on, and a plan
for when the store is down. That belongs to your deployment.

### Per-host breakers

Keep a `Map` of breakers and pick one with `byRequest`:

```ts
const breakers = new Map<string, CircuitBreaker>();

const forHost = (host: string): CircuitBreaker => {
	const existing = breakers.get(host);
	if (existing) {
		return existing;
	}
	const breaker = new CircuitBreaker({ threshold: 5, resetAfter: 30_000 });
	breakers.set(host, breaker);
	return breaker;
};

const retrying = retry({
	attempts: 3,
	backoff: exponential({ base: 200, max: 10_000 }),
	shouldRetry: retryableTransportError,
});

const policy = byRequest((request) =>
	stack(retrying, forHost(new URL(request.url).host).policy, timeout(2_000))
);
```

The map never evicts. If the set of hosts is open-ended, add your own
eviction.

## Benchmarks

No benchmarks yet.
