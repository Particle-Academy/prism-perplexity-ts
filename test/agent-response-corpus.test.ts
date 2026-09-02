import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AgentClient, PerplexityError, type JsonObject } from '../src/index.js';

/**
 * The cross-language agent-response corpus from `prism-parity`.
 *
 * The response body is UNTRUSTED input — it is whatever the provider sent —
 * and three things a consumer cannot decide for itself ride on how it is read:
 *
 *   - whether the run is FINISHED, which is what `wait()` turns on. Call a
 *     queued run terminal and an empty answer is returned as the final one;
 *     call a cancelled run live and the loop polls to timeout for a run that
 *     ended promptly.
 *   - which CITATIONS it carries and in WHAT ORDER, because a UI numbers them
 *     and the answer text refers to them by that number.
 *   - whether the body is refused, and under which identifier — a consumer
 *     switches on that to tell a bad request from a rate limit.
 *
 * The first two agree in all three languages on every row, which is the part
 * worth knowing. The identifiers do not, and those are pinned in the negative.
 */
interface CorpusCase {
  id: string;
  title: string;
  http_status: number;
  body: unknown;
  parsed: {
    php: Record<string, unknown>;
    ts: Record<string, unknown>;
    py: Record<string, unknown>;
  };
  agrees: boolean;
  ports_agree: boolean;
  disagrees_on: string[];
  notes: string;
}

const corpus = JSON.parse(
  readFileSync(new URL('./fixtures/perplexity-agent-response.json', import.meta.url), 'utf8'),
) as { cases: CorpusCase[] };

async function parse(entry: CorpusCase): Promise<Record<string, unknown>> {
  const client = new AgentClient(async () => ({
    status: entry.http_status,
    json: entry.body,
  }));

  try {
    const response = await client.retrieve('resp_probe');

    return {
      refused: false,
      id: response.id,
      status: response.status,
      terminal: response.isTerminal(),
      successful: response.isSuccessful(),
      model: response.model,
      created_at: response.createdAt,
      output_count: response.output.length,
      annotations: response.annotations as readonly JsonObject[],
      usage: response.usage,
      error: response.error,
      text: response.text(),
    };
  } catch (thrown) {
    const error = thrown as PerplexityError;

    return { refused: true, error_code: error.code, error_type: error.providerType };
  }
}

const caseOf = (id: string): CorpusCase => corpus.cases.find((entry) => entry.id === id)!;

describe('the cross-language agent-response corpus', () => {
  it('is the whole suite, not a subset someone trimmed to green', () => {
    expect(corpus.cases).toHaveLength(17);
  });

  it.each(corpus.cases)('$id parses the way the corpus recorded ($title)', async (entry) => {
    expect(await parse(entry)).toEqual(entry.parsed.ts);
  });

  it('agrees with the reference on whether a run is finished, on every row', async () => {
    // The load-bearing value, and the good news. `wait()` has exactly two ways
    // to be wrong and both are silent, so this is asserted against live output
    // rather than read off the corpus.
    for (const entry of corpus.cases) {
      if (entry.parsed.php.refused === true) continue;

      expect((await parse(entry)).terminal, entry.id).toBe(entry.parsed.php.terminal);
    }
  });

  it('agrees with the reference on the citations and their ORDER, on every row', async () => {
    // Holds across the malformed rows too: a bare string in an annotation list
    // is dropped by all three, and the sibling that follows it still arrives.
    for (const entry of corpus.cases) {
      if (entry.parsed.php.refused === true) continue;

      expect((await parse(entry)).annotations, entry.id).toEqual(entry.parsed.php.annotations);
    }
  });

  it('renders an absent usage as an OBJECT, where the reference renders a list', async () => {
    // G-29, and a second instance of G-20: an empty PHP array encodes as `[]`,
    // never `{}`. A consumer reading `usage.input_tokens` off serialised output
    // gets a list where it expected an object, and which one depends on the
    // language that served the request.
    const entry = caseOf('agent-0002');

    expect((await parse(entry)).usage).toEqual({});
    expect(Array.isArray(entry.parsed.php.usage)).toBe(true);
  });

  it('separates its OWN refusal code from the provider error type; the reference does not', async () => {
    // G-30, and a difference in SHAPE rather than in naming. This port has a
    // `code` it owns and reserves `providerType` for what Perplexity actually
    // said. The reference has no code at all and puts its own client
    // identifier into the slot the provider's type would occupy — so on a
    // client-side refusal a consumer cannot tell "the provider called this
    // invalid" from "this library did".
    const entry = caseOf('agent-0008');
    const parsed = await parse(entry);

    expect(parsed.error_code).toBe('invalid_response');
    expect(parsed.error_type).toBeNull();
    expect(entry.parsed.php.error_code).toBeNull();
    expect(entry.parsed.php.error_type).toBe('invalid_response');
  });

  it('calls a JSON ARRAY body unreadable, which is what it is', async () => {
    // G-31, and the one row where this port is plainly right. PHP's `is_array`
    // is true for a decoded JSON LIST as well as a map, so a body that was
    // never a response passes the reference's readability check and fails its
    // status check instead — telling the caller the provider sent a response
    // missing a status, when a proxy or a captive portal sent something that
    // was never a response at all.
    //
    // Asserted in the POSITIVE: this is the behaviour to keep.
    const entry = caseOf('agent-0012');

    expect((await parse(entry)).error_code).toBe('unreadable_response');
    expect(entry.parsed.php.error_type).toBe('invalid_response');
  });

  it('NULLS a numeric-string created_at, where the reference coerces it', async () => {
    // G-32. JSON has one number type and providers still send timestamps as
    // strings. Neither answer is obviously right — the reference is forgiving,
    // this is predictable — but a caller cannot have both, and a timestamp that
    // exists in one language and is null in another is discovered by rendering
    // a blank date.
    const entry = caseOf('agent-0016');

    expect((await parse(entry)).created_at).toBeNull();
    expect(entry.parsed.php.created_at).toBe(1730000000);
  });

  it('agrees with the OTHER port on every row', () => {
    // Recorded because it is the useful half of the finding: this is a
    // reference-versus-ports split, not a three-way scatter, so every
    // divergence above has exactly one side that has to move.
    expect(corpus.cases.filter((entry) => !entry.ports_agree)).toEqual([]);
  });
});
