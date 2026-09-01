import { describe, expect, it } from 'vitest';
import {
  AgentClient,
  PerplexityError,
  embeddings,
  fetchTransport,
  isTerminal,
  search,
  type HttpClient,
  type HttpResponse,
  type JsonObject,
} from '../src/index.js';

/** Records what was sent, and replies with whatever the test scripted. */
function transport(replies: HttpResponse[]): { http: HttpClient; sent: JsonObject[] } {
  const sent: JsonObject[] = [];
  let call = 0;

  return {
    sent,
    http: async (request) => {
      sent.push({ method: request.method, path: request.path, body: request.body ?? null });

      return replies[Math.min(call++, replies.length - 1)]!;
    },
  };
}

const ok = (json: unknown): HttpResponse => ({ status: 200, json: json as never });

describe('search', () => {
  it('posts the query and returns the results', async () => {
    const { http, sent } = transport([ok({ results: [{ url: 'https://example.test' }] })]);

    expect(await search(http, 'prism ecosystem')).toEqual([{ url: 'https://example.test' }]);
    expect(sent[0]).toMatchObject({ method: 'POST', path: '/search' });
  });

  it('takes several queries at once', async () => {
    const { http, sent } = transport([ok({ results: [] })]);
    await search(http, ['one', 'two']);

    expect((sent[0]?.body as JsonObject).query).toEqual(['one', 'two']);
  });

  it('treats NO RESULTS as an answer, not a failure', async () => {
    // The same rule the Agent API sets for a completed run with no sources.
    const { http } = transport([ok({ results: [] })]);

    expect(await search(http, 'nothing at all')).toEqual([]);
  });

  it('drops an unset option rather than sending it as null', async () => {
    // Perplexity rejects some fields sent as null that it accepts as absent.
    const { http, sent } = transport([ok({ results: [] })]);
    await search(http, 'q', { max_results: null, recency: 'week' });

    expect(sent[0]?.body).toEqual({ query: 'q', recency: 'week' });
  });

  it('raises the provider error, with its type', async () => {
    const { http } = transport([ok({ error: { type: 'rate_limited', message: 'Slow down.' } })]);

    await expect(search(http, 'q')).rejects.toMatchObject({
      code: 'provider_error',
      providerType: 'rate_limited',
      message: 'Slow down.',
    });
  });

  it('names a non-JSON body rather than throwing a parse error', async () => {
    const { http } = transport([{ status: 502, json: null }]);

    await expect(search(http, 'q')).rejects.toMatchObject({
      code: 'unreadable_response',
      status: 502,
    });
  });
});

describe('embeddings', () => {
  it('posts to /embeddings and returns the vectors', async () => {
    const { http, sent } = transport([
      ok({ model: 'pplx-embed', data: [{ embedding: [0.1, 0.2] }], usage: { total_tokens: 4 } }),
    ]);

    const response = await embeddings(http, { model: 'pplx-embed', inputs: ['hello'] });

    expect(sent[0]?.path).toBe('/embeddings');
    expect(response.embeddings).toEqual([[0.1, 0.2]]);
    expect(response.usage).toEqual({ total_tokens: 4 });
    expect(response.model).toBe('pplx-embed');
  });

  it('uses a DIFFERENT endpoint for contextualized embeddings', async () => {
    // Not a flag on the same call. Prism's embeddings abstraction has no concept
    // of "these inputs belong together", so this is reached deliberately rather
    // than pretended to be the same thing.
    const { http, sent } = transport([ok({ data: [] })]);
    await embeddings(http, {
      model: 'm',
      inputs: ['a', 'b'],
      contextualized: true,
      documentContext: 'a report',
    });

    expect(sent[0]?.path).toBe('/contextualized-embeddings');
    expect((sent[0]?.body as JsonObject).document_context).toBe('a report');
  });

  it('omits document_context when there is none', async () => {
    const { http, sent } = transport([ok({ data: [] })]);
    await embeddings(http, { model: 'm', inputs: ['a'] });

    expect(sent[0]?.body).not.toHaveProperty('document_context');
  });

  it('raises the provider error', async () => {
    const { http } = transport([ok({ error: { message: 'bad model' } })]);

    await expect(embeddings(http, { model: 'nope', inputs: ['a'] })).rejects.toMatchObject({
      code: 'provider_error',
      providerType: 'embeddings_error',
    });
  });
});

describe('the Agent API', () => {
  const queued = ok({ id: 'run-1', status: 'queued' });
  const done = ok({
    id: 'run-1',
    status: 'completed',
    model: 'sonar-deep-research',
    created_at: 1700000000,
    usage: { total_tokens: 100 },
    output: [
      {
        content: [
          { text: 'First part.', annotations: [{ url: 'https://a.test' }] },
          { text: 'Second part.' },
        ],
      },
    ],
  });

  it('creates a run in the BACKGROUND by default', async () => {
    // A research run can take minutes, and a request held open that long is one
    // a proxy will cut.
    const { http, sent } = transport([queued]);
    await new AgentClient(http).create('research prism');

    expect(sent[0]?.path).toBe('/v1/agent');
    expect((sent[0]?.body as JsonObject).background).toBe(true);
  });

  it('lets the caller turn background off', async () => {
    const { http, sent } = transport([queued]);
    await new AgentClient(http).create('x', { background: false });

    expect((sent[0]?.body as JsonObject).background).toBe(false);
  });

  it('escapes the id in the path', async () => {
    // An id is provider-supplied; interpolating one containing a slash would
    // reach a different endpoint entirely.
    const { http, sent } = transport([done]);
    await new AgentClient(http).retrieve('run/../admin');

    expect(sent[0]?.path).toBe('/v1/agent/run%2F..%2Fadmin');
  });

  it('collects the text and the annotations out of the output', async () => {
    const { http } = transport([done]);
    const response = await new AgentClient(http).retrieve('run-1');

    expect(response.text()).toBe('First part.\nSecond part.');
    expect(response.annotations).toEqual([{ url: 'https://a.test' }]);
    expect(response.isSuccessful()).toBe(true);
    expect(response.createdAt).toBe(1700000000);
  });

  it('knows which states are terminal', () => {
    expect(['completed', 'failed', 'incomplete', 'cancelled'].every(isTerminal as never)).toBe(true);
    expect(isTerminal('queued')).toBe(false);
    expect(isTerminal('in_progress')).toBe(false);
  });

  it('polls until the run is terminal', async () => {
    const slept: number[] = [];
    const { http } = transport([queued, queued, done]);
    const client = new AgentClient(http, async (ms) => {
      slept.push(ms);
    });

    const response = await client.wait('run-1', 5, 250);

    expect(response.isSuccessful()).toBe(true);
    // Two waits for three attempts: none after the one that succeeded.
    expect(slept).toEqual([250, 250]);
  });

  it('does NOT sleep after the last attempt', async () => {
    // Waiting out an interval only to throw makes every timeout one interval
    // slower than it needs to be.
    const slept: number[] = [];
    const { http } = transport([queued]);
    const client = new AgentClient(http, async (ms) => {
      slept.push(ms);
    });

    await expect(client.wait('run-1', 2, 100)).rejects.toMatchObject({
      code: 'agent_wait_timed_out',
    });
    expect(slept).toEqual([100]);
  });

  it('THROWS on timeout rather than returning a non-terminal response', async () => {
    // A caller handed back a `queued` would have to re-check the status to know
    // the wait failed, and the ones who forget treat an unfinished run as an
    // empty answer.
    const { http } = transport([queued]);
    const client = new AgentClient(http, async () => undefined);

    await expect(client.wait('run-1', 1)).rejects.toThrow(PerplexityError);
  });

  it('refuses a nonsensical wait rather than looping forever', async () => {
    const { http } = transport([queued]);

    await expect(new AgentClient(http).wait('run-1', 0)).rejects.toMatchObject({
      code: 'invalid_argument',
    });
  });

  it('carries a failed run\'s error without throwing', async () => {
    // A run that FAILED is a terminal answer, not a transport failure: the
    // caller asked what happened and this is what happened.
    const { http } = transport([
      ok({ id: 'run-1', status: 'failed', error: { message: 'search backend down', code: 'e50' } }),
    ]);

    const response = await new AgentClient(http).retrieve('run-1');

    expect(response.isTerminal()).toBe(true);
    expect(response.isSuccessful()).toBe(false);
    expect(response.error).toEqual({ message: 'search backend down', code: 'e50', type: null });
  });

  it('rejects a response with an unrecognised status', async () => {
    const { http } = transport([ok({ id: 'run-1', status: 'vibing' })]);

    await expect(new AgentClient(http).retrieve('run-1')).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('raises an HTTP failure with the provider type', async () => {
    const { http } = transport([
      { status: 429, json: { error: { type: 'rate_limit', message: 'Too many' } } as never },
    ]);

    await expect(new AgentClient(http).retrieve('run-1')).rejects.toMatchObject({
      code: 'provider_error',
      providerType: 'rate_limit',
      status: 429,
    });
  });
});

describe('fetchTransport', () => {
  it('sends the key as a bearer token and joins the base url', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const http = fetchTransport({
      apiKey: 'secret-key',
      baseUrl: 'https://api.perplexity.ai/',
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, init };

        return { json: async () => ({ results: [] }), status: 200 };
      }) as unknown as typeof globalThis.fetch,
    });

    await http({ method: 'POST', path: '/search', body: { query: 'q' } });

    expect(seen!.url).toBe('https://api.perplexity.ai/search');
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe('Bearer secret-key');
  });

  it('reports a non-JSON body as null rather than throwing', async () => {
    // The caller raises `unreadable_response` WITH the status, which is far
    // more use than a parse error with no context.
    const http = fetchTransport({
      apiKey: 'k',
      fetch: (async () => ({
        status: 500,
        json: async () => {
          throw new Error('not json');
        },
      })) as unknown as typeof globalThis.fetch,
    });

    expect(await http({ method: 'GET', path: '/x' })).toEqual({ status: 500, json: null });
  });
});
