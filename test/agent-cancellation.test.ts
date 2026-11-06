import { describe, expect, it } from 'vitest';
import { AgentClient, type HttpClient, type HttpRequest, type JsonObject } from '../src/index.js';

function transport(bodies: JsonObject[]): { http: HttpClient; sent: HttpRequest[] } {
  const sent: HttpRequest[] = [];
  return {
    sent,
    http: async (request) => {
      sent.push(request);
      return { status: 200, json: bodies[Math.min(sent.length - 1, bodies.length - 1)]! };
    },
  };
}

describe('asynchronous cancellation and incomplete reasons', () => {
  it('accepts cancelling from cancel without claiming completion or success', async () => {
    const body = { id: 'resp_probe', status: 'cancelling' };
    const { http, sent } = transport([body]);
    const response = await new AgentClient(http).cancel('resp_probe');
    expect(response.id).toBe('resp_probe');
    expect(response.status).toBe('cancelling');
    expect(response.isTerminal()).toBe(false);
    expect(response.isSuccessful()).toBe(false);
    expect(response.raw).toBe(body);
    expect(sent).toEqual([{ method: 'POST', path: '/v1/agent/resp_probe/cancel' }]);
  });

  it('retrieves a cancelling snapshot without treating it as terminal', async () => {
    const { http } = transport([{ id: 'resp_probe', status: 'cancelling' }]);
    const response = await new AgentClient(http).retrieve('resp_probe');
    expect(response.status).toBe('cancelling');
    expect(response.isTerminal()).toBe(false);
    expect(response.isSuccessful()).toBe(false);
  });

  it('polls through cancelling until cancelled and never sleeps after the terminal response', async () => {
    const { http, sent } = transport(['queued', 'cancelling', 'cancelled'].map((status) => ({ id: 'resp_probe', status })));
    const slept: number[] = [];
    const response = await new AgentClient(http, async (ms) => { slept.push(ms); }).wait('resp_probe', 3, 7);
    expect(response.status).toBe('cancelled');
    expect(response.isTerminal()).toBe(true);
    expect(response.isSuccessful()).toBe(false);
    expect(sent).toHaveLength(3);
    expect(slept).toEqual([7, 7]);
  });

  it('times out a still-cancelling run within the original attempt bound', async () => {
    const { http, sent } = transport([{ id: 'resp_probe', status: 'cancelling' }]);
    const slept: number[] = [];
    await expect(new AgentClient(http, async (ms) => { slept.push(ms); }).wait('resp_probe', 2, 7))
      .rejects.toMatchObject({ code: 'agent_wait_timed_out' });
    expect(sent).toHaveLength(2);
    expect(slept).toEqual([7]);
  });

  it.each([
    [{ reason: 'max_output_tokens' }, 'max_output_tokens'],
    [{ reason: 'future_reason' }, 'future_reason'],
    [{ reason: '' }, ''],
    [{ reason: null }, null],
    [{ reason: 42 }, null],
    [{ reason: false }, null],
    [{ reason: ['max_output_tokens'] }, null],
    [{ reason: { value: 'max_output_tokens' } }, null],
    [{}, null],
    [null, null],
    ['max_output_tokens', null],
  ] as const)('reads only a string incomplete reason from %j', async (details, expected) => {
    const body = JSON.parse(JSON.stringify({ id: 'resp_probe', status: 'incomplete', incomplete_details: details })) as JsonObject;
    const { http } = transport([body]);
    const response = await new AgentClient(http).retrieve('resp_probe');
    expect(response.incompleteReason()).toBe(expected);
    expect(response.isTerminal()).toBe(true);
    expect(response.isSuccessful()).toBe(false);
    expect(response.raw).toBe(body);
    expect(response.raw).toEqual(body);
  });

  it('returns null when incomplete_details is absent', async () => {
    const { http } = transport([{ id: 'resp_probe', status: 'incomplete' }]);
    expect((await new AgentClient(http).retrieve('resp_probe')).incompleteReason()).toBeNull();
  });

  it('keeps rejecting an unknown status', async () => {
    const { http } = transport([{ id: 'resp_probe', status: 'cancelling_forever' }]);
    await expect(new AgentClient(http).cancel('resp_probe')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('does not turn an HTTP cancellation failure into an acknowledgement', async () => {
    const client = new AgentClient(async () => ({ status: 400, json: { error: { type: 'already_terminal', message: 'Already done' } } }));
    await expect(client.cancel('resp_probe')).rejects.toMatchObject({ code: 'provider_error', providerType: 'already_terminal', status: 400 });
  });
});

describe('documented cancel envelope', () => {
  it('accepts exactly response_id and cancelling without inventing a full snapshot', async () => {
    const body = { response_id: 'resp_probe', status: 'cancelling' };
    const { http, sent } = transport([body]);
    const response = await new AgentClient(http).cancel('resp_probe');
    expect(response.id).toBe('resp_probe');
    expect(response.status).toBe('cancelling');
    expect(response.isTerminal()).toBe(false);
    expect(response.isSuccessful()).toBe(false);
    expect(response.model).toBeNull();
    expect(response.output).toEqual([]);
    expect(response.annotations).toEqual([]);
    expect(response.usage).toEqual({});
    expect(response.createdAt).toBeNull();
    expect(response.error).toBeNull();
    expect(response.raw).toBe(body);
    expect(response.raw).toEqual({ response_id: 'resp_probe', status: 'cancelling' });
    expect(sent).toEqual([{ method: 'POST', path: '/v1/agent/resp_probe/cancel' }]);
  });

  it('prefers response_id when both keys are present', async () => {
    const { http } = transport([{ response_id: 'resp_probe', id: 'resp_other', status: 'cancelling' }]);
    expect((await new AgentClient(http).cancel('resp_probe')).id).toBe('resp_probe');
  });

  it.each([null, '', 42, false, [], {}].map((value) => [value] as const))('refuses a present invalid response_id %j instead of falling back', async (response_id) => {
    const { http } = transport([{ response_id, id: 'resp_probe', status: 'cancelling' }]);
    await expect(new AgentClient(http).cancel('resp_probe')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('fails when both identifiers are absent', async () => {
    const { http } = transport([{ status: 'cancelling' }]);
    await expect(new AgentClient(http).cancel('resp_probe')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each(['create', 'retrieve'] as const)('does not alias response_id on %s', async (operation) => {
    const { http } = transport([{ response_id: 'resp_probe', status: 'completed' }]);
    const client = new AgentClient(http);
    await expect(operation === 'create' ? client.create('synthetic') : client.retrieve('resp_probe'))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('encodes the cancel path while retaining an id-only legacy acknowledgement', async () => {
    const { http, sent } = transport([{ id: 'run/../admin', status: 'cancelling' }]);
    expect((await new AgentClient(http).cancel('run/../admin')).id).toBe('run/../admin');
    expect(sent).toEqual([{ method: 'POST', path: '/v1/agent/run%2F..%2Fadmin/cancel' }]);
  });
});

describe('cancel acknowledgement identity binding', () => {
  it.each([
    { response_id: 'resp_other', status: 'cancelling' },
    { id: 'resp_other', status: 'cancelling' },
    { response_id: 'resp_other', id: 'resp_probe', status: 'cancelling' },
    { response_id: 'resp_Probe', status: 'cancelling' },
  ])('refuses a mismatched acknowledgement %j without retrying or mutating raw', async (body) => {
    const original = JSON.parse(JSON.stringify(body)) as JsonObject;
    const { http, sent } = transport([body]);
    let thrown: unknown;
    try { await new AgentClient(http).cancel('resp_probe'); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ code: 'invalid_response', status: 200 });
    expect((thrown as Error).message).toContain('Cancellation state is uncertain. Use retrieve() with the requested ID to check its state.');
    expect((thrown as Error).message).not.toContain('resp_probe');
    expect((thrown as Error).message).not.toContain('resp_other');
    expect(sent).toEqual([{ method: 'POST', path: '/v1/agent/resp_probe/cancel' }]);
    expect(body).toEqual(original);
  });

  it.each(['resp_Aa', 'resp_0'])('accepts matching opaque identifier %s', async (id) => {
    const body = { response_id: id, status: 'cancelling' };
    const { http, sent } = transport([body]);
    const response = await new AgentClient(http).cancel(id);
    expect(response.id).toBe(id);
    expect(response.raw).toBe(body);
    expect(response.raw).toEqual({ response_id: id, status: 'cancelling' });
    expect(sent).toHaveLength(1);
  });
});
