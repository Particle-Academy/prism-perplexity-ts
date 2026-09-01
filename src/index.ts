export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Failures carry a stable CODE.
 *
 * The reference throws Prism's `PrismException` with an English message and a
 * provider-supplied `errorType`. A class name does not survive a port and a
 * sentence is not a contract, so the code is what a consumer branches on here
 * — the same decision as `prism-ts` and `prism-harness-ts`.
 */
export type PerplexityErrorCode =
  /** The endpoint did not return a JSON object at all. */
  | 'unreadable_response'
  /** The endpoint returned JSON, and it carried an error. */
  | 'provider_error'
  /** The response is missing something this client requires to proceed. */
  | 'invalid_response'
  /** A background run did not reach a terminal state before the attempts ran out. */
  | 'agent_wait_timed_out'
  /** An argument this client refuses to send. */
  | 'invalid_argument';

export class PerplexityError extends Error {
  constructor(
    readonly code: PerplexityErrorCode,
    message: string,
    /** The provider's own error type, when it gave one. */
    readonly providerType: string | null = null,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'PerplexityError';
  }
}

// -- transport ---------------------------------------------------------------

export interface HttpRequest {
  method: 'GET' | 'POST';
  /** Relative to the base url the transport was built with. */
  path: string;
  body?: JsonObject;
}

export interface HttpResponse {
  status: number;
  /** The decoded body, or null when it was not JSON. */
  json: JsonValue | null;
}

/**
 * How this package reaches Perplexity.
 *
 * AN INTERFACE, not a dependency. The reference takes Laravel's `PendingRequest`
 * because it is already there; here the seam keeps the package at zero
 * dependencies and lets a consumer bring their own client, their own retry
 * policy, and their own way of holding an API key. It is also what makes every
 * test below run without a network.
 */
export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

/** A transport over `fetch`, for a caller who does not want to write one. */
export function fetchTransport(options: {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}): HttpClient {
  const baseUrl = (options.baseUrl ?? 'https://api.perplexity.ai').replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;

  return async (request) => {
    const response = await doFetch(`${baseUrl}${request.path}`, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });

    // A non-JSON body is reported as null rather than thrown here, so the
    // caller below can raise `unreadable_response` with the status attached —
    // which is far more use than a parse error with no context.
    let json: JsonValue | null = null;
    try {
      json = (await response.json()) as JsonValue;
    } catch {
      json = null;
    }

    return { status: response.status, json };
  };
}

// -- search ------------------------------------------------------------------

/**
 * Perplexity's Search API — web results, NO MODEL.
 *
 * Returns the sources a grounded answer would have been built from, without
 * paying for the answer. Useful when the application wants to do its own
 * synthesis, or to show a user where information came from before spending
 * tokens summarising it.
 *
 * Results come back as plain objects rather than wrapped in a value type,
 * matching the reference and for its reason: Perplexity documents this payload
 * as open-ended, and a wrapper naming only today's fields would quietly drop
 * tomorrow's.
 */
export async function search(
  http: HttpClient,
  query: string | readonly string[],
  options: JsonObject = {},
): Promise<JsonObject[]> {
  const data = await readJson(
    http,
    { method: 'POST', path: '/search', body: compact({ ...options, query: query as JsonValue }) },
    'The search endpoint did not return a JSON object.',
  );

  assertNoError(data, 'search_error');

  const results = data.results;

  // No results is a legitimate answer to a search, not a failure — the same
  // rule the Agent API sets for a completed run with no sources.
  return Array.isArray(results) ? results.filter(isJsonObject) : [];
}

// -- embeddings --------------------------------------------------------------

export interface EmbeddingsRequest {
  model: string;
  inputs: readonly string[];
  /**
   * Embed the inputs as chunks of ONE document, each in light of the others.
   *
   * A different endpoint, not a flag on the same one. Prism's embeddings
   * abstraction is text-in, vector-out and has no concept of "these belong
   * together", so this is reached deliberately rather than pretended to be the
   * same call.
   */
  contextualized?: boolean;
  /** Only meaningful when the inputs are chunks of one document. */
  documentContext?: string;
}

export interface EmbeddingsResponse {
  embeddings: number[][];
  usage: JsonObject;
  model: string | null;
}

export async function embeddings(
  http: HttpClient,
  request: EmbeddingsRequest,
): Promise<EmbeddingsResponse> {
  const data = await readJson(
    http,
    {
      method: 'POST',
      path: request.contextualized === true ? '/contextualized-embeddings' : '/embeddings',
      body: compact({
        model: request.model,
        inputs: [...request.inputs],
        document_context: request.documentContext ?? null,
      }),
    },
    'The embeddings endpoint did not return a JSON object.',
  );

  assertNoError(data, 'embeddings_error');

  const rows = Array.isArray(data.data) ? data.data : [];

  return {
    embeddings: rows.filter(isJsonObject).map((row) => {
      const embedding = row.embedding;

      return Array.isArray(embedding)
        ? embedding.filter((value): value is number => typeof value === 'number')
        : [];
    }),
    usage: isJsonObject(data.usage) ? data.usage : {},
    model: typeof data.model === 'string' ? data.model : null,
  };
}

// -- the Agent API -----------------------------------------------------------

export type AgentStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'incomplete'
  | 'cancelled';

const TERMINAL: readonly AgentStatus[] = ['completed', 'failed', 'incomplete', 'cancelled'];

export function isTerminal(status: AgentStatus): boolean {
  return TERMINAL.includes(status);
}

export interface AgentError {
  message: string;
  code: string | null;
  type: string | null;
}

export class AgentResponse {
  constructor(
    readonly id: string,
    readonly status: AgentStatus,
    readonly model: string | null,
    readonly output: readonly JsonObject[],
    readonly annotations: readonly JsonObject[],
    readonly usage: JsonObject,
    readonly error: AgentError | null,
    readonly createdAt: number | null,
    readonly raw: JsonObject,
  ) {}

  isTerminal(): boolean {
    return isTerminal(this.status);
  }

  isSuccessful(): boolean {
    return this.status === 'completed';
  }

  /** Every text part of the output, joined. */
  text(): string {
    const parts: string[] = [];

    for (const item of this.output) {
      const content = Array.isArray(item.content) ? item.content : [];

      for (const part of content.filter(isJsonObject)) {
        if (typeof part.text === 'string') parts.push(part.text);
      }
    }

    return parts.join('\n');
  }
}

export type Sleeper = (milliseconds: number) => Promise<void>;

/**
 * The long-running Agent API: start a run, poll it, cancel it.
 *
 * `background: true` by default, matching the reference — a research run can
 * take minutes, and a request held open for that long is one a proxy will cut.
 */
export class AgentClient {
  constructor(
    private readonly http: HttpClient,
    /** Injected so `wait()` is testable without real time passing. */
    private readonly sleeper: Sleeper = (ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
  ) {}

  async create(input: string | readonly JsonObject[], options: JsonObject = {}): Promise<AgentResponse> {
    return this.#map({
      method: 'POST',
      path: '/v1/agent',
      body: { ...options, input: input as JsonValue, background: options.background ?? true },
    });
  }

  async retrieve(id: string): Promise<AgentResponse> {
    return this.#map({ method: 'GET', path: `/v1/agent/${encodeURIComponent(id)}` });
  }

  async cancel(id: string): Promise<AgentResponse> {
    return this.#map({ method: 'POST', path: `/v1/agent/${encodeURIComponent(id)}/cancel` });
  }

  /**
   * Poll until the run reaches a terminal state.
   *
   * Throws `agent_wait_timed_out` rather than returning the last non-terminal
   * response: a caller that got a `queued` back from `wait()` would have to
   * check the status again to know the wait failed, and the ones that forget
   * are the ones that treat an unfinished run as an empty answer.
   */
  async wait(id: string, maxAttempts = 60, intervalMs = 1000): Promise<AgentResponse> {
    if (maxAttempts < 1 || intervalMs < 0) {
      throw new PerplexityError(
        'invalid_argument',
        'maxAttempts must be at least 1 and intervalMs cannot be negative.',
      );
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await this.retrieve(id);

      if (response.isTerminal()) return response;

      // No sleep after the LAST attempt: waiting out an interval only to throw
      // makes every timeout one interval slower than it needs to be.
      if (attempt < maxAttempts) await this.sleeper(intervalMs);
    }

    throw new PerplexityError(
      'agent_wait_timed_out',
      `The Perplexity agent run [${id}] did not finish within ${maxAttempts} attempt(s).`,
    );
  }

  async #map(request: HttpRequest): Promise<AgentResponse> {
    const { status, json } = await this.http(request);

    if (!isJsonObject(json)) {
      throw new PerplexityError(
        'unreadable_response',
        'The Agent API did not return a JSON object.',
        null,
        status,
      );
    }

    if (status < 200 || status >= 300) {
      const error = isJsonObject(json.error) ? json.error : {};

      throw new PerplexityError(
        'provider_error',
        typeof error.message === 'string' ? error.message : 'Unknown Agent API error.',
        typeof error.type === 'string' ? error.type : 'agent_request_error',
        status,
      );
    }

    const id = json.id;
    const agentStatus = json.status;

    if (typeof id !== 'string' || id === '' || !isAgentStatus(agentStatus)) {
      throw new PerplexityError(
        'invalid_response',
        'The Agent API response is missing a recognized status or response id.',
        null,
        status,
      );
    }

    const output = (Array.isArray(json.output) ? json.output : []).filter(isJsonObject);
    const annotations: JsonObject[] = [];

    for (const item of output) {
      for (const part of (Array.isArray(item.content) ? item.content : []).filter(isJsonObject)) {
        for (const annotation of (Array.isArray(part.annotations) ? part.annotations : []).filter(
          isJsonObject,
        )) {
          annotations.push(annotation);
        }
      }
    }

    const raw = isJsonObject(json.error) ? json.error : null;

    return new AgentResponse(
      id,
      agentStatus,
      typeof json.model === 'string' ? json.model : null,
      output,
      annotations,
      isJsonObject(json.usage) ? json.usage : {},
      raw !== null && typeof raw.message === 'string'
        ? {
            message: raw.message,
            code: typeof raw.code === 'string' ? raw.code : null,
            type: typeof raw.type === 'string' ? raw.type : null,
          }
        : null,
      typeof json.created_at === 'number' ? json.created_at : null,
      json,
    );
  }
}

function isAgentStatus(value: unknown): value is AgentStatus {
  return (
    typeof value === 'string' &&
    ['queued', 'in_progress', 'completed', 'failed', 'incomplete', 'cancelled'].includes(value)
  );
}

// -- shared ------------------------------------------------------------------

async function readJson(
  http: HttpClient,
  request: HttpRequest,
  unreadable: string,
): Promise<JsonObject> {
  const { status, json } = await http(request);

  if (!isJsonObject(json)) {
    throw new PerplexityError('unreadable_response', unreadable, null, status);
  }

  return json;
}

function assertNoError(data: JsonObject, fallbackType: string): void {
  if (data.error === undefined || data.error === null) return;

  const error = isJsonObject(data.error) ? data.error : {};

  throw new PerplexityError(
    'provider_error',
    typeof error.message === 'string' ? error.message : 'Unknown error',
    typeof error.type === 'string' ? error.type : fallbackType,
  );
}

/**
 * Drop null and empty-array values.
 *
 * Matches the reference's `array_filter`, and for a real reason: Perplexity
 * rejects some fields sent as null that it accepts as absent, so an
 * "unset" option must not travel as an explicit null.
 */
function compact(body: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(body).filter(
      ([, value]) => value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0),
    ),
  );
}
