/**
 * The default transport follows a redirect only while it stays on the same origin.
 *
 * `fetchTransport` sends `Authorization` with every request. It follows a
 * redirect only while scheme, host and port are unchanged; any other redirect
 * is not followed and the call fails with a `PerplexityError`.
 *
 * These cases run the REAL transport over the real `fetch`, through the
 * functions an application calls, against loopback servers only: every other
 * connection is refused below.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AgentClient, PerplexityError, embeddings, fetchTransport, search } from '../src/index.js';

const KEY = 'pplx-test-redirect-key';

// Refuse every connection that is not to a loopback address.
const originalConnect = net.Socket.prototype.connect;
beforeAll(() => {
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const first = args[0];
    const host =
      typeof first === 'object' && first !== null
        ? (first as { host?: string; path?: string }).host ?? ((first as { path?: string }).path ? 'ipc' : 'localhost')
        : typeof args[1] === 'string'
          ? args[1]
          : 'localhost';
    if (host !== 'ipc' && host !== 'localhost' && !host.startsWith('127.')) {
      throw new Error(`network blocked in tests: ${host}`);
    }
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
});
afterAll(() => {
  net.Socket.prototype.connect = originalConnect;
});

interface Seen {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
}

interface Endpoint {
  url: string;
  port: number;
  seen: Seen[];
  connections: number;
  redirect: [number, string] | null;
  landed: unknown;
  close: () => Promise<void>;
}

async function serve(host: string): Promise<Endpoint> {
  const state: Endpoint = {
    url: '',
    port: 0,
    seen: [],
    connections: 0,
    redirect: null,
    landed: { error: { message: 'landed', type: 'landed' } },
    close: async () => {},
  };
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      state.seen.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers });
      if (state.redirect !== null && !(req.url ?? '').startsWith('/landed')) {
        const [status, location] = state.redirect;
        res.writeHead(status, { Location: location, 'Content-Type': 'application/json' });
        res.end('{"results":[]}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state.landed));
    });
  });
  server.on('connection', () => {
    state.connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  state.port = (server.address() as AddressInfo).port;
  state.url = `http://${host}:${state.port}`;
  state.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return state;
}

const open: Endpoint[] = [];
async function server(host: string): Promise<Endpoint> {
  const s = await serve(host);
  open.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

function calls(endpoint: Endpoint): Record<string, () => Promise<unknown>> {
  const http = fetchTransport({ apiKey: KEY, baseUrl: endpoint.url });
  const agent = new AgentClient(http, async () => {});
  return {
    search: () => search(http, 'prism'),
    embeddings: () => embeddings(http, { model: 'pplx-embed', inputs: ['one'] }),
    'contextualized-embeddings': () => embeddings(http, { model: 'pplx-embed', inputs: ['one', 'two'], contextualized: true }),
    'agent-create': () => agent.create('research this'),
    'agent-retrieve': () => agent.retrieve('run-1'),
    'agent-cancel': () => agent.cancel('run-1'),
    'agent-wait': () => agent.wait('run-1', 1, 0),
  };
}

const CALLS = [
  'search',
  'embeddings',
  'contextualized-embeddings',
  'agent-create',
  'agent-retrieve',
  'agent-cancel',
  'agent-wait',
] as const;

async function failure(action: () => Promise<unknown>): Promise<PerplexityError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(PerplexityError);
    const failed = error as PerplexityError;
    expect(String(failed)).not.toContain(KEY);
    expect(failed.message).not.toContain(KEY);
    expect(JSON.stringify(failed)).not.toContain(KEY);
    return failed;
  }
  throw new Error('the call did not fail');
}

describe('a redirect to another origin is not followed', () => {
  for (const otherHost of ['127.0.0.2', '127.0.0.1']) {
    const label = otherHost === '127.0.0.1' ? 'other port' : 'other host';
    for (const status of [301, 302, 303, 307, 308]) {
      for (const call of CALLS) {
        it(`${label}, ${status}, ${call}`, async () => {
          const endpoint = await server('127.0.0.1');
          const other = await server(otherHost);
          endpoint.redirect = [status, `${other.url}/elsewhere`];

          const error = await failure(calls(endpoint)[call]!);

          expect(error.status).toBe(status);
          expect(endpoint.seen).toHaveLength(1);
          expect(endpoint.seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
          expect(other.seen).toEqual([]);
          expect(other.connections).toBe(0);
        });
      }
    }
  }
});

describe('a scheme change is another origin', () => {
  for (const call of CALLS) {
    it(call, async () => {
      const endpoint = await server('127.0.0.1');
      endpoint.redirect = [302, `https://127.0.0.1:${endpoint.port}/landed`];

      const error = await failure(calls(endpoint)[call]!);

      expect(error.status).toBe(302);
      expect(endpoint.connections).toBe(1);
      expect(endpoint.seen).toHaveLength(1);
    });
  }
});

describe('a same-origin redirect', () => {
  it('is still followed, with the credential', async () => {
    const endpoint = await server('127.0.0.1');
    endpoint.redirect = [302, `${endpoint.url}/landed/search`];
    endpoint.landed = { results: [{ url: 'https://example.test' }] };

    const http = fetchTransport({ apiKey: KEY, baseUrl: endpoint.url });

    expect(await search(http, 'prism')).toEqual([{ url: 'https://example.test' }]);
    expect(endpoint.seen.map((s) => [s.method, s.path])).toEqual([
      ['POST', '/search'],
      ['GET', '/landed/search'],
    ]);
    expect(endpoint.seen[1]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('keeps the method and body on a 307', async () => {
    const endpoint = await server('127.0.0.1');
    endpoint.redirect = [307, '/landed/v1/agent'];
    endpoint.landed = { id: 'run-1', status: 'queued' };

    const http = fetchTransport({ apiKey: KEY, baseUrl: endpoint.url });
    const response = await new AgentClient(http).create('research this');

    expect(response.id).toBe('run-1');
    expect(endpoint.seen.map((s) => [s.method, s.path])).toEqual([
      ['POST', '/v1/agent'],
      ['POST', '/landed/v1/agent'],
    ]);
  });

  it('is followed for a relative location on a GET', async () => {
    const endpoint = await server('127.0.0.1');
    endpoint.redirect = [308, '/landed/v1/agent/run-1'];
    endpoint.landed = { id: 'run-1', status: 'completed' };

    const http = fetchTransport({ apiKey: KEY, baseUrl: endpoint.url });
    const response = await new AgentClient(http).retrieve('run-1');

    expect(response.id).toBe('run-1');
    expect(endpoint.seen.map((s) => s.path)).toEqual(['/v1/agent/run-1', '/landed/v1/agent/run-1']);
  });

  it('is not followed without end', async () => {
    const endpoint = await server('127.0.0.1');
    endpoint.redirect = [302, '/loop'];

    const http = fetchTransport({ apiKey: KEY, baseUrl: endpoint.url });
    const error = await failure(() => search(http, 'prism'));

    expect(error.status).toBe(302);
    expect(endpoint.seen.length).toBeLessThanOrEqual(21);
  });
});
