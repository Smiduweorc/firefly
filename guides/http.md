---
title: HTTP
---

# HTTP

`firefly-limiter/http` is a separate entry point. The core does not import it.

```ts
import { transport, retryableTransportError } from "firefly-limiter/http";

const api = new ApiClient({
	baseUrl: "https://api.example.com/v1",
	transport: transport(fetch, payments.policy),
});
```

`transport` wraps a `fetch`-shaped function in a policy and hands back a
function of the same shape:

```ts
type Transport = (request: Request) => Promise<Response>;
```

That is the same type Aphid and dung beetle export for their transports. It is
declared here, not imported, so neither package has to be installed.

## Statuses inside a transport

`ApiClient` turns a non-2xx response into an `HttpError` after the transport
returns. Inside the transport a 429 is an ordinary resolved `Response`.

So `transport` reads the status itself. For statuses worth repeating it raises
a `RetryableResponseError`, which the policies above it see as a failure. The
final response is handed back with its body unread, so `decode` and
`HttpError.body` work as they do without a policy.

That is why a policy handed to `transport` uses `retryableTransportError` as its
`shouldRetry`:

```ts
retry({
	attempts: 3,
	backoff: exponential({ base: 200, max: 10_000 }),
	shouldRetry: retryableTransportError,
});
```

It repeats a `RetryableResponseError` and a `TimeoutError`. It does not repeat
any other `FireflyError` (an open circuit, a full bulkhead: nothing was sent) or
the caller's own abort.

## What it decides

### Status classification

`408`, `425`, `429`, `500`, `502`, `503` and `504` are retried by default. The
set is the exported `retryableStatuses`, and `retryStatuses` replaces it.

A response that is about to be discarded has its body cancelled, so a retried
call leaks nothing.

### `Retry-After`

Honoured for `429` and `503`, as delta-seconds or an HTTP-date. A missing,
malformed or already-past value is ignored. `parseRetryAfter` is exported.

The header sets the earliest time the next attempt may start. It is not added
to the backoff, so a backoff longer than the header does not wait twice.

`maxRetryAfter` caps it, and defaults to 30 seconds. Set it to your schedule's
`max`.

### Idempotency

`GET`, `HEAD`, `OPTIONS`, `PUT` and `DELETE` are retried. `POST` and `PATCH`
are not, unless the request carries an `Idempotency-Key` header or you pass
`retryUnsafeMethods: true`.

### Body replay

To replay a body it has to be kept, so a body is read into memory up to
`maxReplayBytes`, which defaults to 1 MiB:

- Under the limit, every attempt is sent from the same bytes.
- Over it, the request is sent once, whole, and never retried, and a
  `body-too-large` event is emitted.

If the request declares a length over the limit, the body is not read at all.
`bodySize` supplies that length and defaults to reading `content-length`, which
Node keeps on a `Request` but browsers forbid. A body that declares nothing, or
declares the wrong length, is still measured as it is read.

### Cancellation

The caller's signal, which a client puts on the `Request`, is what the policy
runs under. Per-attempt deadlines derive their own signals from it, and an
abort by the caller is not retried.

## Different policies for different endpoints

A transport applies to every call. To give a payment endpoint a longer
deadline than a search box, pick a policy per request:

```ts
import { byRequest } from "firefly-limiter/http";

const api = new ApiClient({
	baseUrl: "https://api.example.com/v1",
	transport: transport(
		fetch,
		byRequest((request) =>
			request.url.includes("/payments") ? payments.policy : reads.policy
		)
	),
});
```

Build the policies once, outside the selector. A breaker built inside it is a
new breaker per request.

## Working with Aphid and dung beetle

Both templates leave retries and timeouts to a decorator around `ApiClient`'s
transport. `firefly-limiter/http` is that decorator.

A client you publish from Aphid or dung beetle should not depend on Firefly.
Baking a retry policy into `@example/api-client` gives every consumer your
timeouts and attempt counts. The application depends on Firefly and hands the
transport in. dung beetle's generator never writes policy, so a regenerated
client does not either.

### Catching a refusal

The transport rejects, so `ApiClient` reports a `TransportError` with
Firefly's error as its `cause`:

```ts
try {
	await api.request(listInvoices());
} catch (error) {
	if (error instanceof TransportError && error.cause instanceof TimeoutError) {
		// the deadline, not the network
	}
	if (error instanceof TransportError && error.cause instanceof CircuitOpenError) {
		// nothing was sent; error.cause.retryAt says when one call will be tried
	}
	if (error instanceof HttpError) {
		// a status the policy did not retry, or retried until it ran out
	}
	throw error;
}
```

Exhausted retries rethrow the last failure unwrapped, so the `HttpError` a
caller catches is the one the API produced, with the API's own body.

## Above the client instead

You can also wrap `api.request(...)`, where the typed result and the error
classes are in scope. That suits a fallback for one call site. Keep the breaker
in the transport, where it sees every call.

`retryableApiError` is the predicate for this position. It recognises the
templates' errors by name and shape, so Aphid and dung beetle need not be
installed. A `TransportError` is retryable unless the caller aborted it, an
`HttpError` is retryable when its status is in the set, and a `DecodeError`
never is.
