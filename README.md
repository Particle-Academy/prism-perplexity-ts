# Prism Perplexity for TypeScript

Perplexity's search, embeddings and Agent API. The TypeScript port of
[`particle-academy/prism-perplexity`](https://github.com/Particle-Academy/prism-perplexity).

Zero runtime dependencies. Node 22+.

```
npm install @particle-academy/prism-perplexity
```

## Usage

Everything takes an `HttpClient` — a function from a request to a response — so
the transport is yours. `fetchTransport()` is the batteries-included one:

```ts
import { embeddings, fetchTransport, search } from '@particle-academy/prism-perplexity';

const http = fetchTransport({ apiKey: process.env.PERPLEXITY_API_KEY! });

const results = await search(http, 'what changed in node 24');

const vectors = await embeddings(http, {
  model: 'text-embedding-3-small',
  inputs: ['first', 'second'],
});
```

`search()` takes a single query or an array of them. A failure throws
`PerplexityError`, whose `code` names what went wrong rather than leaving you to
parse a message.

## The Agent API is long-running, so it is polled explicitly

An agent request does not return an answer; it returns a task that reaches a
terminal state at some point after. `AgentClient` owns that loop:

```ts
import { AgentClient, isTerminal } from '@particle-academy/prism-perplexity';

const agent = new AgentClient(http);

const started = await agent.create('Summarise this week in Node releases');

// Poll it yourself...
const latest = await agent.retrieve(started.id);
isTerminal(latest.status);

// ...or let the client do it: 60 attempts, 1s apart, by default.
const finished = await agent.wait(started.id);
```

`cancel(id)` acknowledges a request: `cancelling` is neither terminal nor successful.
The acknowledgement's `response_id` (or legacy `id`, only when `response_id` is absent)
must match the requested ID exactly. A malformed or mismatched acknowledgement raises
`invalid_response`; cancellation state is uncertain, so call `retrieve(id)` to check it.
The client does not retry cancellation automatically. `create()` and `retrieve()` still
use their own `id` field, and `raw` retains the provider body.

`AgentResponse.incompleteReason()` returns the string `incomplete_details.reason`,
including an empty string, or `null` when absent or malformed.

`isTerminal()` is exported as a function rather than left as a status
comparison, because "which statuses mean stop" is the one thing a caller
writing their own loop gets wrong — and getting it wrong means either polling
forever or treating a still-running task as finished.

The sleeper is injectable (`Sleeper`), which is what makes the polling
behaviour testable without waiting in real time.

## Your API key never reaches this package's error paths

`fetchTransport` holds the key and puts it on the request. Errors carry the
status and the provider's message; they do not carry the request headers. That
matters because a thrown error in an agent framework tends to end up in a log,
a span, or a model's context.

## Parity

Request shaping, the error codes and the terminal-status set are compared
against the PHP reference and the Python port by prism-parity's perplexity
corpus. **One of its forty-five rows agrees** across all three languages; the
TypeScript and Python outputs agree on all forty-five. The original seventeen
rows are unchanged. The gaps are G-29 through
G-32 in the envelope's port-gaps register — read it before assuming a response
from this port is interchangeable with one from PHP.
