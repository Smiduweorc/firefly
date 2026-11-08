---
title: Policies
---

# Policies

All of these compose with [`stack`](./concepts.md), and most are assembled for
you by [`Dependency`](./dependency.md).

Policies that hold state (`CircuitBreaker`, `Bulkhead`, `RateLimiter`,
`RetryBudget`, `SingleFlight`) are objects you construct, so their scope is
whatever you share them with. The rest (`retry`, `timeout`, `hedge`,
`fallback`) are functions that return a policy.

## Backoff schedules

A schedule is a function from an attempt number to a delay. Write your own if
the provided ones don't fit:

```ts
type Backoff = (attempt: number, error?: unknown) => number;
```

The failure is passed too, for a schedule that reads something from the error.
The three provided schedules ignore it.

```ts
exponential({ base: 200, factor: 2, max: 10_000 })  // base * factor ** (attempt - 1)
constant(500)                                        // the same delay every time
fromList([100, 500, 2_000])                          // in order, repeating the last
```

`factor` defaults to `2` and `max` to no ceiling. `fromList` throws a
`RangeError` if the list is empty.

### Jitter

Every schedule is jittered, and full jitter is the default. Without jitter,
clients that failed together retry together.

| `jitter` | Spreads the delay over |
| --- | --- |
| `"full"` (default) | `[0, delay]` |
| `"equal"` | `[delay / 2, delay]` |
| `"none"` | nothing; the delay is exact |

Pass `random` to make a jittered schedule exact in a test.

## `retry`

Repeats the action until it succeeds, the options say to stop, or the caller's
signal aborts.

```ts
retry({
	attempts: 3,
	backoff: exponential({ base: 100, max: 5_000 }),
	shouldRetry: (error, attempt) => isTransient(error),
	budget: shared,
	maxElapsed: 20_000,
});
```

| Option | Notes |
| --- | --- |
| `attempts` | Total, not additional. `1` never retries. |
| `backoff` | Required. |
| `shouldRetry` | Required, called with the error and the attempt that produced it. |
| `budget` | A `RetryBudget` shared with other callers. |
| `maxElapsed` | No attempt is started once the wait before it would carry the call past this, measured from the first attempt. |

`retryAnything` repeats everything, including a `TypeError` from a bug in your
own code.

The loop stops when the caller's signal aborts, the attempts run out,
`shouldRetry` returns false, a shared budget is empty, or the next backoff
would pass `maxElapsed`. In each case the last failure is rethrown as it was.

## `RetryBudget`

A ceiling on retries across every call that shares it.

`attempts: 3` bounds one call. If every caller is on its third attempt, the
dependency gets three times its normal load. A budget caps the total.

```ts
const budget = new RetryBudget({ ratio: 0.2, capacity: 10 });
```

`ratio` is retries earned per call: `0.2` lets the client retry a fifth of what
it sends. `capacity` is both the ceiling on what can be saved up and the
largest run of retries allowed when nothing has been earned yet. It starts
full, so a quiet client can still retry.

It counts calls and uses no clock or timer. Read `budget.tokens` for what is
left. When it runs out, a `budget-exhausted` event
is emitted and the failure is rethrown.

## `timeout`

Gives each attempt `ms` to finish, aborting that attempt's own signal with a
`TimeoutError` and rejecting with the same error.

```ts
timeout(2_000)
```

An action that watches its signal stops when the deadline passes.

This is a deadline per attempt. For a budget across all attempts, use
`maxElapsed` on `retry`. An attempt never outlives that budget: a deadline that
would run past it is cut short.

## `CircuitBreaker`

Stops calling a dependency that is failing, and tries one call once the reset
window has passed.

There are two trip conditions and you pick one. Consecutive failures:

```ts
const breaker = new CircuitBreaker({
	threshold: 5,
	resetAfter: 30_000,
});
```

Or a rate over a window. Use this when failures are mixed with successes:
40% of calls failing may never reach five in a row.

```ts
const breaker = new CircuitBreaker({
	resetAfter: 30_000,
	window: {
		size: 100,
		within: 60_000,
		minimumCalls: 20,
		failureRate: 0.5,
		slowerThan: 2_000,
		slowRate: 0.3,
	},
});
```

| Window field | What it is |
| --- | --- |
| `size` | Calls remembered. |
| `within` | How recent a call must be to count, in ms. Without it, the window is the last `size` calls however old. |
| `minimumCalls` | Calls required before a rate can open the circuit, so two failures out of two do not read as 100%. |
| `failureRate` | Share of the window that must have failed, `0` to `1`. |
| `slowerThan` | Calls at least this slow count as slow, whether or not they succeeded. |
| `slowRate` | Share of the window that must be slow. |

`slowRate` opens the circuit for an upstream that answers, but too slowly. A
circuit opened by slowness alone has no failure to report, so its
`CircuitOpenError.cause` is `undefined`.

Both forms take `isFailure`, which decides whether an error counts. An error it
declines is not recorded at all: it neither opens nor closes the circuit, and
passes through untouched.

`probes` (default `1`) is how many calls are let through while half-open, and
how many must succeed to close it.

Read `breaker.state` (`"closed"`, `"open"`, `"half-open"`), `breaker.failures`
and `breaker.recorded`. Constructing one starts no timer.

## `Bulkhead`

Bounds how many calls may be in flight at once, and how many may wait, so one
slow dependency cannot take every connection or worker.

```ts
const bulkhead = new Bulkhead({
	concurrency: 20,
	queue: 100,
	queueTimeout: 1_000,
});
```

`queue` defaults to `0`, which refuses instead of queueing, with a
`BulkheadFullError`. `queueTimeout` is how long a call may wait for a slot
before it is refused.

The queue is first in, first out, and a caller whose signal aborts leaves it.

### Adaptive concurrency

`adapt` moves the limit: additive increase while calls succeed under pressure,
multiplicative decrease when they fail or take longer than `slowerThan`.

```ts
adapt: { min: 5, max: 100, slowerThan: 1_000, decrease: 0.9 }
```

`decrease` defaults to `0.9`. The limit only grows while every slot is in
use. Read the current value from `bulkhead.concurrency`, alongside `inFlight`
and `queued`.

## `RateLimiter`

A token bucket, per process.

```ts
const limiter = new RateLimiter({
	capacity: 10,
	perSecond: 5,
	onExhausted: "wait",
});
```

`capacity` is the bucket size, which is the largest burst allowed after an idle
period. `onExhausted` defaults to `"wait"`; `"reject"` refuses with a
`RateLimitError` carrying `retryAt` instead.

It refills from the clock when read, with no timer. Waiting callers are served
in the order they arrived.
Read `limiter.tokens` and `limiter.queued`, or spend a token directly with
`await limiter.take(signal)`.

## `hedge`

Sends the same work again before the first attempt has failed, and takes the
first answer.

```ts
hedge({
	attempts: 2,
	delay: 300,
	budget: shared,
});
```

`delay` is how long to wait for the attempt in flight before starting another,
as a number or as a schedule read with the number of attempts already started.
Set it near the latency you are willing to accept, around the p95 of the call,
not the p50, or every call is sent twice.

Losing attempts are aborted as soon as one answers. The winner's signal is left
alone, since its result may still be being read.

By default a hedge only handles latency: a failure goes straight to the caller,
and repeating it is `retry`'s job. `shouldHedge` starts the next attempt
immediately on a failure it accepts. It has no default.

A hedge sends extra requests when the dependency is slow, so share a `budget`
with the retry above it. If every attempt fails, the last failure is rethrown.

## `SingleFlight`

Collapses concurrent calls that share a key into one call.

```ts
const shared = new SingleFlight();

const today = await shared.run("rates:today", readRates, signal);
```

It stores nothing once a call settles, so the next caller starts a new one and
there is no expiry to configure.

Each caller's signal detaches only that caller. The work is aborted when the
last caller leaves. Read `shared.inFlight` and `shared.has(key)`, or use
`shared.policy(key)` to run everything a policy wraps under one key.

## `fallback`

Answers with a substitute when everything else has failed: stale data, an empty
list.

```ts
const rates = await fallback(() => cached)(policy(readRates))();
```

It goes outermost and wraps a stack (see [Concepts](./concepts.md)).

`shouldFallback` narrows which failures get the substitute, and defaults to all
of them, since a substitute adds no load on the dependency. An aborted call
still rejects.
