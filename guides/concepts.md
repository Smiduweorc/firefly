---
title: Concepts
---

# Concepts

## Actions and policies

An action is the work. It takes a signal and returns a promise:

```ts
type Action<T> = (signal: AbortSignal) => Promise<T>;
```

A policy wraps an action and hands back a wrapped action:

```ts
type Policy = <T>(action: Action<T>) => Wrapped<T>;
type Wrapped<T> = (signal?: AbortSignal) => Promise<T>;
```

`Wrapped` is an `Action` whose signal is optional, so the outermost call can be
made with none. Every policy below it always receives a real signal.

Applying a policy is a function call, and so is running the result:

```ts
const guarded = timeout(2_000)(readRates);
const today = await guarded();
```

Nesting combines them. `retry` around `timeout` around the work repeats the
deadline-wrapped attempt:

```ts
const today = await retry(options)(timeout(2_000)(readRates))();
```

`fallback` is the exception. It produces a result of its own, so it is a
`TypedPolicy<T>`, not a `Policy`, and it wraps a stack instead of sitting inside
one.

## Composing: `stack`

`stack` composes left to right, outermost first, so the arguments read the way
the stack is drawn. `stack(a, b)(action)` is `a(b(action))`.

```ts
const policy = stack(
	retry({ attempts: 3, backoff: exponential({ base: 100 }), shouldRetry }),
	breaker.policy,
	limiter.policy,
	bulkhead.policy,
	timeout(2_000)
);
```

### The order

A wrong order usually runs without an error and protects nothing, so each
policy in this package is labelled with what it does, and `stack` throws a
`TypeError` when a labelled policy sits outside one that must contain it.

| Position | Policy | Why there |
| --- | --- | --- |
| Outermost | `fallback` | Where it can answer for a call that failed all the way through. |
| | `SingleFlight` | Outside the retry, so callers sharing a key share its attempts too. |
| | `retry` | Outside the breaker, so the breaker records every attempt. |
| | `hedge` | Inside the retry and outside the breaker, so each branch is recorded on its own. |
| | `CircuitBreaker` | Inside the retry and outside the waiting policies, so an open circuit refuses instead of queueing for a slot it will not use. |
| | `RateLimiter` | Outside the bulkhead, so waiting for a token does not hold a concurrency slot. |
| | `Bulkhead` | Directly around the work, where the count of in-flight attempts is the thing being bounded. |
| Innermost | `timeout` | A deadline per attempt. For the whole operation, see `maxElapsed` below. |

Two policies of the same kind may sit next to each other. Policies you write
are unlabelled, so `stack` passes them through without an opinion. Label your
own with `tag(policy, kind)` to have it held to the same order, read a label
back with `kindOf(policy)`, and use `stack.unchecked(...)` for an arrangement
you mean and this package does not know about. The thrown message names both
policies and where the outer one belongs.

## Signals and cancellation

- The signal you pass to a wrapped action is the caller's signal. Aborting it
  abandons the whole operation.
- `timeout` and `hedge` derive a per-attempt signal, aborted when the caller
  gives up or when that attempt alone is abandoned. Once the call has settled
  the attempt's signal stops listening to the caller, so a shutdown signal you
  pass to every call does not collect a listener per call.
- An action that ignores its signal keeps running after it is abandoned. The
  rejection still arrives on time.

A caller's abort is never retried. `retry`, `fallback` and `hedge` check the
outer signal first and rethrow.

### Deadlines and budgets

- `timeout(ms)` is a deadline for one attempt. Three attempts under a two
  second deadline can take six seconds, plus the backoff.
- `maxElapsed` on `retry` is a budget for the whole operation. No attempt is
  started once the wait before it would pass the budget.

A deadline that would run past the budget is cut short, so the last attempt
cannot overshoot it.

## The clock

Every policy reads time through a `Clock` (`now()` and `sleep()`), and
constructing a policy starts no timer. Pass `clock` to replace it; see
[Testing](./testing.md).

## Events

Every decision a policy makes is handed to an `onEvent` sink as a plain value:

```ts
const policy = retry({
	attempts: 3,
	backoff: exponential({ base: 100 }),
	shouldRetry,
	onEvent: (event) => metrics.count(event.type),
});
```

The union is closed:

| Event | Carries | Emitted by |
| --- | --- | --- |
| `attempt` | `attempt` | `retry`, once per try |
| `retry` | `attempt`, `delay`, `error` | `retry`, once per wait |
| `budget-exhausted` | `tokens` | `retry`, `hedge` |
| `timeout` | `ms`, `elapsed` | `timeout` |
| `hedge` | `attempt` | `hedge`, per attempt past the first |
| `fallback` | `error` | `fallback` |
| `circuit-open` | `openedAt`, `retryAt`, `error` | `CircuitBreaker` |
| `circuit-half-open` | `openedAt` | `CircuitBreaker` |
| `circuit-close` | | `CircuitBreaker` |
| `rate-limited` | `retryAt`, `rejected` | `RateLimiter` |
| `bulkhead-queued` | `inFlight`, `queued` | `Bulkhead` |
| `bulkhead-rejected` | `inFlight`, `queued` | `Bulkhead` |
| `body-too-large` | `limit`, `declared` | `transport` |

Every event also carries `call`, an id shared by every event from the same
call, so a sink can tell three attempts of one call from three calls. A hedged
branch reports under the call it belongs to.

A throw from your sink is caught and dropped.

## Errors

A `FireflyError` means Firefly declined: it stopped waiting, refused to start,
or had nowhere to run the work. A failure that came from your work is rethrown
unchanged, so one `instanceof` separates the two.

| Class | Raised when | Carries |
| --- | --- | --- |
| `TimeoutError` | An attempt passed its deadline. | `ms`, `elapsed` |
| `CircuitOpenError` | The circuit was open, so nothing was sent. | `openedAt`, `retryAt`, and `cause`, the failure that opened it |
| `BulkheadFullError` | Concurrency and queue were both full. | `concurrency`, `queued` |
| `RateLimitError` | No token, and `onExhausted` is `"reject"`. | `retryAt` |
| `HedgeAbandonedError` | A hedged attempt lost the race. | `attempt` |

`HedgeAbandonedError` is the abort reason on a losing attempt's signal. It is
never thrown to the caller, so if you see one, an action logged its own
cancellation.
