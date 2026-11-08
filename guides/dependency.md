---
title: Dependency
---

# Dependency

For most services this is the only thing you construct. Make one per
upstream and share it with every call site that talks to that upstream, so its
breaker sees all of their calls.

```ts
import { Dependency, exponential, retryAnything } from "firefly-limiter";

export const payments = new Dependency({
	name: "payments",
	attempts: 3,
	backoff: exponential({ base: 200, max: 10_000 }),
	shouldRetry: retryAnything,
	deadline: 5_000,
	breaker: { threshold: 5, resetAfter: 30_000 },
});
```

## What it assembles

The policies are always stacked in this order:

```
retry -> hedge? -> breaker? -> limiter? -> bulkhead? -> timeout
```

Anything you did not configure is left out. `onEvent` and `clock` are passed
to every piece, so you set them once.

`share` and `fallback` sit outside the stack and are set per call: `share`
needs a key, and `fallback`'s result type belongs to one call.

## Required options

| Option | What it is |
| --- | --- |
| `name` | What this dependency is called, in `health()` output and your own logs. |
| `attempts` | Total attempts per call, not additional ones. `1` never retries. |
| `backoff` | How long to wait between attempts. See [Policies](./policies.md). |
| `shouldRetry` | Whether a failure is worth repeating. |
| `deadline` | Deadline for one attempt, in milliseconds. |
| `breaker` | When to stop calling this dependency, or `false`. |

None has a default. Pass `breaker: false` if you don't want a breaker.

`shouldRetry` has no default because a 409 is fatal to one caller and expected
by another. `retryAnything` repeats everything. Under a `firefly-limiter/http`
transport, use `retryableTransportError`.

## Optional options

| Option | Add it when |
| --- | --- |
| `bulkhead` | One slow upstream must not consume every socket or worker. |
| `rateLimit` | The API publishes a rate limit, or you are being polite. |
| `budget` | Retries must not multiply an outage across concurrent callers. |
| `hedge` | The p99 is the problem, not the failures. |
| `maxElapsed` | A whole call, across all its attempts, has a time budget. |
| `onEvent` | You want the decisions in your metrics or logs. |
| `clock` | You are testing, or you keep time yourself. |

`budget` is shared by the retries and the hedged attempts. Each option's
fields are documented on its policy in [Policies](./policies.md), minus
`onEvent` and `clock`, which the dependency supplies.

## Calling through it

`run` takes the action and returns the result:

```ts
const invoice = await payments.run((signal) => charge(id, signal));
```

`wrap` returns the wrapped action instead, to call later. The signal is passed
when you call it, since a wrapped action can be called more than once:

```ts
const charge = payments.wrap((signal) => post(id, signal));
queue.push(charge);
```

### Per-call options

```ts
const today = await rates.run(readRates, {
	share: "today",
	fallback: () => cached,
	signal: request.signal,
});
```

`share` joins this call to any call to the same dependency already running
under the same key, so twenty callers make one request and share its attempts.
Nothing is kept once the call settles.

`fallback` answers instead of failing: stale data, an empty list. It sits
outside everything, so it also catches Firefly's own refusals, such as an open
circuit. The handler receives the failure. If it throws, the call rejects with
what it threw.

`signal` abandons this call.

## Reading state

`health()` returns this, and reading it changes no state:

```ts
{
	name: "payments",
	circuit: "closed",  // or "open", "half-open", or "none" if breaker: false
	failures: 0,        // what the breaker is currently counting
	inFlight: 0,
	queued: 0,
	tokens: 10,         // only when there is a rate limiter
	retries: 10,        // only when there is a retry budget
}
```

The pieces are readable too: `payments.breaker`, `.bulkhead`, `.limiter`,
`.budget` (each `undefined` when not configured), `.shared` for the
single-flight, and `.options` for the options it was built from. `.policy` is the whole stack as one policy, which is
what you hand to a transport.

## When to drop to `stack`

Use `stack` directly when you need a different order, when two dependencies
must share a breaker, or when the work is not a service call. `Dependency` is
built from the same public pieces, and `stack` still checks the order.
