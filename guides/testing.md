---
title: Testing
---

# Testing

Every policy reads time through one interface, so a test can replace it and
never sleep:

```ts
interface Clock {
	now(): number;
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
```

Nothing calls `Date.now` or `setTimeout` directly. Pass a `clock` to any policy
or to a `Dependency` and a five minute backoff schedule finishes immediately.
This package's own suite has no real sleeps.

## A virtual clock

The package does not ship one. This is a shorter version of the one in
[`tests/virtual-clock.ts`](https://github.com/Smiduweorc/firefly/blob/master/tests/virtual-clock.ts):

```ts
import type { Clock } from "firefly-limiter";

interface Timer {
	readonly at: number;
	readonly fire: () => void;
}

const flush = (): Promise<void> =>
	new Promise((resolve) => setImmediate(resolve));

export class VirtualClock implements Clock {
	#now = 0;
	#timers = new Set<Timer>();

	now(): number {
		return this.#now;
	}

	sleep(ms: number, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) {
			return Promise.reject(signal.reason);
		}

		return new Promise((resolve, reject) => {
			const timer: Timer = {
				at: this.#now + ms,
				fire: () => {
					signal?.removeEventListener("abort", abort);
					resolve();
				},
			};

			const abort = (): void => {
				this.#timers.delete(timer);
				reject(signal?.reason);
			};

			this.#timers.add(timer);
			signal?.addEventListener("abort", abort, { once: true });
		});
	}

	/** Moves time forward by `ms`, firing whatever falls due on the way. */
	async advance(ms: number): Promise<void> {
		const target = this.#now + ms;

		for (;;) {
			await flush();

			let next: number | undefined;
			for (const timer of this.#timers) {
				if (next === undefined || timer.at < next) {
					next = timer.at;
				}
			}

			if (next === undefined || next > target) {
				break;
			}

			this.#now = Math.max(this.#now, next);

			for (const timer of [...this.#timers]) {
				if (timer.at <= this.#now) {
					this.#timers.delete(timer);
					timer.fire();
				}
			}
		}

		this.#now = target;
		await flush();
	}
}
```

The `flush` between steps lets the promises woken by one timer settle before
the next one fires. Without it, time moves past work that has not run yet.

## Making jitter exact

Full jitter is on by default, so a delay is a random value in a range. Pass
`random` to pin it:

```ts
const backoff = exponential({ base: 100, random: () => 1 });

assert.equal(backoff(1), 100);
assert.equal(backoff(2), 200);
```

`jitter: "none"` also works.

## Asserting on decisions

Assert on `onEvent` instead of on timing:

```ts
const events: FireflyEvent[] = [];

const policy = retry({
	attempts: 3,
	backoff: constant(1_000, { jitter: "none" }),
	shouldRetry: retryAnything,
	onEvent: (event) => events.push(event),
	clock,
});

const result = policy(failsTwiceThenSucceeds)();
await clock.advance(5_000);

await result;
assert.deepEqual(
	events.map((event) => event.type),
	["attempt", "retry", "attempt", "retry", "attempt"]
);
```

Every event carries `call`, so a test that runs several calls at once can group
them without threading an id through the action.

## Driving a breaker

Open to half-open is only a matter of time, so advance the clock:

```ts
const breaker = new CircuitBreaker({ threshold: 2, resetAfter: 30_000, clock });
const guarded = breaker.policy(failing);

await assert.rejects(guarded());
await assert.rejects(guarded());

assert.equal(breaker.state, "open");
await assert.rejects(guarded(), CircuitOpenError);

await clock.advance(30_000);
assert.equal(breaker.state, "half-open");
```

Reading `state`, `failures`, `recorded`, `tokens`, `inFlight` and `queued`
changes no state, so assertions are safe.

## Actions that do not settle

Testing a bulkhead's queue or a hedge's race needs work that hangs until the
test lets it go:

```ts
/** Never settles on its own; rejects when its signal aborts. */
const pending = (signal: AbortSignal): Promise<never> =>
	new Promise((_, reject) => {
		signal.addEventListener("abort", () => reject(signal.reason), {
			once: true,
		});
	});

/** A promise the test settles by hand. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
```

`pending` also checks that a policy cancels: if it rejects with the
`TimeoutError`, the attempt's signal was aborted.
