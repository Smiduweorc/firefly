# firefly-limiter

![logo](https://raw.githubusercontent.com/Smiduweorc/firefly/master/assets/logo.png)

Retries, timeouts, circuit breakers, bulkheads, rate limits and hedging for the outgoing calls of one process, for setups without a service mesh.

```sh
npm install firefly-limiter
```

Node 22 or later, ESM only. CI runs Node 22 and 24 on Linux, Windows and macOS. No runtime dependencies, and nothing runs at import time.

## Example

Describe the upstream once, next to the client that calls it:

```ts
import { Dependency, exponential, retryAnything } from "firefly-limiter";

export const rates = new Dependency({
	name: "rates",
	attempts: 3,
	backoff: exponential({ base: 200, max: 5_000 }),
	shouldRetry: retryAnything,
	deadline: 2_000,
	breaker: { threshold: 5, resetAfter: 30_000 },
});
```

Every field is required. There are no default numbers. Then call through it. Each attempt gets an `AbortSignal` that the deadline aborts:

```ts
const today = await rates.run((signal) => readRates(signal), {
	share: "today",         // concurrent callers with this key make one request
	fallback: () => cached, // answer here if every attempt failed
});
```

When the attempts run out, your last error is rethrown unchanged. Firefly's own errors (`TimeoutError`, `CircuitOpenError`, `BulkheadFullError`, `RateLimitError`) are only for its refusals.

To put the same policy under an HTTP client instead, wrap its `fetch`:

```ts
import { retryableTransportError, transport } from "firefly-limiter/http";

const api = new ApiClient({
	baseUrl: "https://api.example.com/v1",
	transport: transport(fetch, rates.policy),
});
```

`health()` returns the current state without changing it, so a health endpoint can call it:

```ts
app.get("/health", () => rates.health());
// { name: "rates", circuit: "closed", failures: 0, inFlight: 0, queued: 0 }
```

## Not included

- State shared across processes. Counts live in one process, so 20 replicas means 20 breakers. See [Boundaries](https://smiduweorc.github.io/firefly/documents/Boundaries.html).
- Use behind a service mesh. If Envoy or Istio already retries, the two layers of retries multiply.
- Protecting a server from its callers. This is for calls you make.
- I/O, caching, logging and metrics. You pass the call in, caching is [Repletes](https://github.com/Smiduweorc/Repletes), and `onEvent` gives you every decision for your own metrics.

## Known quirks

- Inside a transport a 429 is a resolved `Response`, not an `HttpError`, so a `shouldRetry` that checks for `HttpError` never matches. Use `retryableTransportError` for a dependency you hand to `transport`.
- Create each `Dependency` or `CircuitBreaker` once and share it. One created inside a client factory counts only that client's calls, and one created per request never trips.
- `stack` throws a `TypeError` when policies are in an order that cannot work, for example `timeout` outside `retry`. `Dependency` builds the order for you.

## Guides

Full API reference: <https://smiduweorc.github.io/firefly/>

- [Concepts](https://smiduweorc.github.io/firefly/documents/Concepts.html)
- [Dependency](https://smiduweorc.github.io/firefly/documents/Dependency.html)
- [Policies](https://smiduweorc.github.io/firefly/documents/Policies.html)
- [HTTP](https://smiduweorc.github.io/firefly/documents/HTTP.html), including use with Aphid and dung beetle clients
- [Testing](https://smiduweorc.github.io/firefly/documents/Testing.html)
- [Boundaries](https://smiduweorc.github.io/firefly/documents/Boundaries.html)

## License

MIT
