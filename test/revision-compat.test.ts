import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import type { JSONRPCMessage } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createHub } from '../src/index.js';
import { createStdioHub } from '../src/stdio.js';
import { authorizeInBrowser, registerPublicClient } from './auth-flow.js';

/**
 * What a client pinned to an older protocol revision gets answered.
 *
 * The hub is dual-era — 2026-07-28 behind a modern opening, 2025-11-25 behind
 * a legacy one — and that summary invites the question this file pins with a
 * test rather than an assumption: what does a plain `initialize` offering some
 * *other* revision get back? The smallest clients offer exactly what they were
 * built against — 2025-06-18 is a common pin — and cannot perform the modern
 * `server/discover` probe at all, so the answer decides whether they
 * interoperate.
 *
 * It is the same answer on every endpoint, because every endpoint hands the
 * opening to an unpinned SDK server: a supported 2025-era revision is echoed
 * back, anything else is answered with the 2025-11-25 counteroffer, and the
 * handshake continues on it. No endpoint rejects an `initialize` over its
 * `protocolVersion`, and none waits for a better one. The raw client below
 * fails a request on a timeout rather than hanging the suite, so "the answer
 * never arrives" cannot pass as green.
 */

/** Fails instead of hanging — the whole point of the unknown-revision tests. */
const REQUEST_TIMEOUT_MS = 5_000;

/** The half an answer is parsed as; anything else is a protocol surprise. */
type Answer = { result?: Record<string, unknown>; error?: { message?: unknown } };

function protocolVersionOf(answer: Answer): unknown {
  return answer.result?.protocolVersion;
}

function toolNamesOf(answer: Answer): string[] {
  const tools = answer.result?.tools as Array<Record<string, unknown>> | undefined;
  return (tools ?? []).map(tool => String(tool.name));
}

const started: Array<ReturnType<typeof createStdioHub>> = [];

afterEach(async () => {
  for (const hub of started.splice(0)) {
    hub.watcher.stop();
    await hub.supervisor.stop();
  }
});

function startStdioHub(): ReturnType<typeof createStdioHub> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-revision-'));
  const configPath = path.join(dir, 'mcp.json');
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
  // One meta-tool list, no children: the negotiation is the subject here, and
  // on-demand lifecycling would make "is a child up" a moving target.
  const hub = createStdioHub({ configPath, idleTimeoutMinutes: 0 });
  started.push(hub);
  return hub;
}

interface RawSession {
  request(method: string, params?: Record<string, unknown>): Promise<Answer>;
  notify(method: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * A minimal JSON-RPC client on the entry point that owns the era decision.
 *
 * `serveStdio` with a hand-pinned transport, exactly as runStdio wires it: the
 * point is what the real opening exchange answers, not what a hand-connected
 * server would. No SDK client on the far side — the clients this file is about
 * cannot do the discover probe, so neither does this one.
 */
async function openStdioSession(): Promise<RawSession> {
  const hub = startStdioHub();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(ctx => hub.build(ctx.era), { transport: serverTransport });
  const pending = new Map<number, (answer: Answer) => void>();
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- InMemoryTransport is not an EventTarget; onmessage is its only message hook
  clientTransport.onmessage = message => {
    if (!('id' in message) || typeof message.id !== 'number') return;
    const settle = pending.get(message.id);
    if (settle) {
      pending.delete(message.id);
      settle(message as unknown as Answer);
    }
  };
  let nextId = 0;
  return {
    async request(method, params) {
      const id = ++nextId;
      const answer = new Promise<Answer>(settle => {
        const timer = setTimeout(() => {
          pending.delete(id);
          settle({ error: { message: `no answer to ${method} within ${REQUEST_TIMEOUT_MS}ms` } });
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, received => {
          clearTimeout(timer);
          settle(received);
        });
      });
      await clientTransport.send({
        jsonrpc: '2.0',
        id,
        method,
        ...(params === undefined ? {} : { params })
      } as unknown as JSONRPCMessage);
      return answer;
    },
    async notify(method) {
      await clientTransport.send({ jsonrpc: '2.0', method } as unknown as JSONRPCMessage);
    },
    async close() {
      await handle.close();
      await clientTransport.close();
    }
  };
}

describe('the revision an opening exchange is answered in, over stdio', () => {
  it('echoes a 2025-06-18 opening — a client pinned to it interoperates as-is', async () => {
    const session = await openStdioSession();
    try {
      const answer = await session.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '1.0.0' }
      });
      expect(answer.error).toBeUndefined();
      expect(protocolVersionOf(answer)).toBe('2025-06-18');
    } finally {
      await session.close();
    }
  });

  it('counteroffers 2025-11-25 to an unknown revision, and the session works on it', async () => {
    const session = await openStdioSession();
    try {
      const answer = await session.request('initialize', {
        protocolVersion: '1999-01-01',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '1.0.0' }
      });
      expect(answer.error).toBeUndefined();
      expect(protocolVersionOf(answer)).toBe('2025-11-25');
      await session.notify('notifications/initialized');
      const list = await session.request('tools/list', {});
      expect(list.error).toBeUndefined();
      expect(toolNamesOf(list)).toContain('list_servers');
    } finally {
      await session.close();
    }
  });

  it('counteroffers 2025-11-25 to a bare 2026-07-28 opening without the discover claim', async () => {
    // The modern revision is claimed by a server/discover probe, not offered
    // in initialize. A plain client that writes it here gets the legacy
    // counteroffer rather than the modern era.
    const session = await openStdioSession();
    try {
      const answer = await session.request('initialize', {
        protocolVersion: '2026-07-28',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '1.0.0' }
      });
      expect(answer.error).toBeUndefined();
      expect(protocolVersionOf(answer)).toBe('2025-11-25');
    } finally {
      await session.close();
    }
  });
});

describe('the revision an opening exchange is answered in, over HTTP', () => {
  const EVERYTHING = path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js');
  const PASSWORD = 'test-password';
  const REDIRECT_URI = 'http://localhost:33419/callback';

  let tmpDir: string;
  let hub: Awaited<ReturnType<typeof createHub>>;
  let httpServer: ReturnType<Awaited<ReturnType<typeof createHub>>['app']['listen']>;
  let token: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-revision-http-'));
    const configPath = path.join(tmpDir, 'mcp.json');
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { everything: { command: process.execPath, args: [EVERYTHING] } } }));
    hub = await createHub({
      externalUrl: 'http://localhost:3000',
      configPath,
      dataPath: path.join(tmpDir, 'data'),
      password: PASSWORD,
      requireResourceBoundTokens: false,
      idleTimeoutMinutes: 0
    });
    await hub.supervisor.waitUntilSettled();
    httpServer = hub.app.listen(0);
    const clientId = await registerPublicClient(hub.app, REDIRECT_URI);
    const { code, verifier } = await authorizeInBrowser(hub.app, clientId, {
      password: PASSWORD,
      redirectUri: REDIRECT_URI
    });
    const tokens = await request(hub.app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT_URI })
      .expect(200);
    token = tokens.body.access_token as string;
  }, 30_000);

  afterAll(async () => {
    httpServer?.close();
    hub?.watcher.stop();
    await hub?.supervisor.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** One raw initialize on an endpoint, the way a minimal client sends it. */
  function initializeOn(pathname: string, offered: string) {
    return request(hub.app)
      .post(pathname)
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        method: 'initialize',
        params: { protocolVersion: offered, capabilities: {}, clientInfo: { name: 'vitest', version: '1.0.0' } },
        id: 1
      });
  }

  it('/hub echoes a 2025-06-18 opening back', async () => {
    const res = await initializeOn('/hub', '2025-06-18');
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.result.protocolVersion).toBe('2025-06-18');
  });

  it('/hub counteroffers 2025-11-25 to an unknown revision — a result, promptly, not a hang', async () => {
    const res = await initializeOn('/hub', '1999-01-01');
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.result.protocolVersion).toBe('2025-11-25');
  });

  it('a per-server route answers the same way', async () => {
    const res = await initializeOn('/everything/mcp', '2025-06-18');
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.result.protocolVersion).toBe('2025-06-18');
  });
});
