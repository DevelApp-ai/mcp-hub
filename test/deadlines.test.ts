import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { CallToolResultSchema } from '@modelcontextprotocol/core';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

/**
 * The hub's own clocks, against a real child.
 *
 * The deadline, the switch that lets progress restart it and the cap above
 * both are read once when the module loads, so each case builds its own hub
 * from freshly imported modules under its own environment. The stdio entry
 * point keeps OAuth out of it: the relay is the same behind every door.
 */

const FIXTURE = path.resolve('test/fixtures/cancel-server.mjs');
const PAST_DEADLINE = "The request ran past the hub's deadline.";

interface Event {
  at: number;
  event: string;
  what?: string;
  id?: number | string;
  requestId?: number | string;
  reason?: string;
  sawToken?: boolean;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  vi.restoreAllMocks();
});

async function hubWith(env: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  let createStdioHub: typeof import('../src/stdio.js')['createStdioHub'];
  try {
    ({ createStdioHub } = await import('../src/stdio.js'));
  } finally {
    vi.unstubAllEnvs();
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-deadline-'));
  const record = path.join(dir, 'cancel.jsonl');
  const configPath = path.join(dir, 'mcp.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ mcpServers: { cancel: { command: process.execPath, args: [FIXTURE], env: { CANCEL_RECORD: record } } } })
  );
  const hub = createStdioHub({ configPath, idleTimeoutMinutes: 0 });
  await hub.supervisor.waitUntilSettled();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(ctx => hub.build(ctx.era), { transport: serverTransport });
  const client = new Client({ name: 'deadline-test', version: '0.0.0' });
  await client.connect(clientTransport);

  cleanups.push(async () => {
    await client.close();
    await handle.close();
    hub.watcher.stop();
    await hub.supervisor.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const events = (): Event[] =>
    fs.existsSync(record)
      ? fs
          .readFileSync(record, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line) as Event)
      : [];
  const call = (tool: string, args: Record<string, unknown> = {}) =>
    client.request({ method: 'tools/call', params: { name: 'call_tool', arguments: { server: 'cancel', tool, arguments: args } } }, CallToolResultSchema, {
      timeout: 30_000
    });
  return { hub, events, call };
}

async function waitFor<T>(probe: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > until) throw new Error(`waited ${timeoutMs} ms in vain`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe('the deadline', () => {
  it('ends a silent call, cancels it at the child in the hub words and logs it', async () => {
    const warns = vi.spyOn(console, 'warn');
    const { hub, events, call } = await hubWith({ MCP_CALL_TIMEOUT_MS: '1500' });

    const result = await call('wait_for_cancel');
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(PAST_DEADLINE);

    const started = await waitFor(() => events().find(e => e.event === 'started'));
    const aborted = await waitFor(() => events().find(e => e.event === 'aborted' && e.id === started.id));
    expect(aborted.reason).toBe(PAST_DEADLINE);
    expect(events().filter(e => e.event === 'cancel' && e.requestId === started.id)).toHaveLength(1);
    expect(warns.mock.calls.map(c => String(c[0]))).toContainEqual(
      expect.stringMatching(/^\[cancel\] tools\/call "wait_for_cancel" ran past MCP_CALL_TIMEOUT_MS after 1\.\ds, cancelled at the child$/)
    );
    expect(hub.supervisor.get('cancel')!.inFlight).toBe(0);
  }, 30_000);
});

describe('MCP_RESET_TIMEOUT_ON_PROGRESS=true', () => {
  const SWITCH_ON = { MCP_RESET_TIMEOUT_ON_PROGRESS: 'true', MCP_CALL_TIMEOUT_MS: '1000', MCP_MAX_CALL_MS: '3000' };

  it('asks the child for progress itself and lets it outlive the deadline', async () => {
    const { events, call } = await hubWith(SWITCH_ON);

    // Six reports 400 ms apart: 2.4 s in all, well past a 1 s deadline.
    const result = await call('report_progress', { count: 6, intervalMs: 400 });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain('reported');
    expect(events().find(e => e.event === 'progress-call')?.sawToken).toBe(true);
  }, 30_000);

  it('still ends a chatty call at MCP_MAX_CALL_MS, at the child too', async () => {
    const warns = vi.spyOn(console, 'warn');
    const { events, call } = await hubWith(SWITCH_ON);

    const result = await call('report_progress', { count: 20, intervalMs: 400 });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(PAST_DEADLINE);

    const cancel = await waitFor(() => events().find(e => e.event === 'cancel'));
    expect(cancel.reason).toBe(PAST_DEADLINE);
    expect(warns.mock.calls.map(c => String(c[0]))).toContainEqual(
      expect.stringMatching(/^\[cancel\] tools\/call "report_progress" reached MCP_MAX_CALL_MS after 3\.\ds, cancelled at the child$/)
    );
  }, 30_000);

  it('leaves the switch off by default, so the child sees no token nobody asked for', async () => {
    const { events, call } = await hubWith({});
    const result = await call('report_progress', { count: 1, intervalMs: 0 });
    expect(result.isError).toBeFalsy();
    expect(events().find(e => e.event === 'progress-call')?.sawToken).toBe(false);
  }, 30_000);
});
