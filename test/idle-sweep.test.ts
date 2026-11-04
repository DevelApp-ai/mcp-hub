import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CallToolResultSchema } from '@modelcontextprotocol/core';

import { parseConfig } from '../src/config.js';
import { serverRequestHandler } from '../src/proxy.js';
import { Supervisor, type ManagedServer } from '../src/supervisor.js';

/**
 * The idle sweep and the calls still running on a server.
 *
 * The sweep used to look only at when a server was last used, and a call marks
 * that when it starts — so a call that outlasted the idle timeout had its child
 * put to sleep under it, and failed. A server with a call in flight now stays
 * up, and the end of a call counts as use. What never counted as use, the
 * tools/list every client sends on connect, still does not.
 */

const FIXTURE = path.resolve('test/fixtures/cancel-server.mjs');
const IDLE_MS = 400;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  vi.restoreAllMocks();
});

async function waitFor(probe: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > until) throw new Error(`waited ${timeoutMs} ms in vain`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** One on-demand server behind its own route, with an idle timeout short enough to watch. */
async function start(): Promise<{ managed: ManagedServer; client: Client }> {
  // The sweep announces every nap.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-idle-'));
  const config = parseConfig(
    JSON.stringify({ mcpServers: { box: { command: process.execPath, args: [FIXTURE], env: { CANCEL_RECORD: path.join(dir, 'box.jsonl') } } } }),
    {}
  );
  const supervisor = new Supervisor(config, { idleTimeoutMs: IDLE_MS, sweepIntervalMs: 50 });
  await supervisor.start();
  await supervisor.waitUntilSettled();
  const managed = supervisor.get('box')!;
  expect(managed.onDemand).toBe(true);

  const app = express();
  app.use(express.json());
  app.all('/box/mcp', serverRequestHandler(managed, 'request-state-secret'));
  const server = await new Promise<http.Server>(resolve => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const client = new Client({ name: 'idle-test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/box/mcp`)));

  cleanups.push(async () => {
    await client.close();
    server.close();
    await supervisor.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { managed, client };
}

const toolCall = (name: string, args: Record<string, unknown> = {}) => ({ method: 'tools/call' as const, params: { name, arguments: args } });

describe('the idle sweep', () => {
  it('keeps a server up while a call outlasts the idle timeout, and starts the clock when the call ends', async () => {
    const { managed, client } = await start();
    const states: string[] = [];
    const sampler = setInterval(() => states.push(managed.state), 20);
    const result = await client
      .request(toolCall('sleep_for', { ms: 3 * IDLE_MS }), CallToolResultSchema, { timeout: 20_000 })
      .finally(() => clearInterval(sampler));
    const endedAt = Date.now();
    expect(JSON.stringify(result.content)).toContain('slept');
    // The call may have had to wake it first; from the moment it was up, it stayed up.
    expect(states.slice(states.indexOf('up'))).not.toContain('sleeping');

    await waitFor(() => managed.state === 'sleeping');
    expect(Date.now() - endedAt).toBeGreaterThanOrEqual(IDLE_MS - 100);
  }, 30_000);

  it('does not keep a server up for a call its client cancelled', async () => {
    const { managed, client } = await start();
    const abort = new AbortController();
    const pending = client.request(toolCall('wait_for_cancel'), CallToolResultSchema, { signal: abort.signal });
    await waitFor(() => managed.inFlight === 1);
    abort.abort();
    await expect(pending).rejects.toThrow();
    const cancelledAt = Date.now();

    await waitFor(() => managed.inFlight === 0);
    await waitFor(() => managed.state === 'sleeping');
    expect(Date.now() - cancelledAt).toBeLessThan(3_000);
  }, 30_000);

  it('does not count the tools/list a client sends on connect as use', async () => {
    const { managed, client } = await start();
    await client.request(toolCall('quick'), CallToolResultSchema);
    const lastUse = Date.now();
    const lister = setInterval(() => void client.listTools().catch(() => {}), 50);
    try {
      await waitFor(() => managed.state === 'sleeping');
    } finally {
      clearInterval(lister);
    }
    expect(Date.now() - lastUse).toBeLessThan(3_000);
  }, 30_000);
});
