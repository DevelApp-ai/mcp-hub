import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthStore } from '../src/auth/store.js';
import { parseConfig } from '../src/config.js';
import { ManagedServer, Supervisor } from '../src/supervisor.js';
import { UnlockSweep } from '../src/unlock/sweep.js';

const EVERYTHING = path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js');

let dir: string;
let store: AuthStore;
let supervisor: Supervisor | undefined;
let log: { mockRestore(): void };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-unlock-sweep-'));
  store = new AuthStore(dir);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  log.mockRestore();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function start(entry: Record<string, unknown>, idleTimeoutMinutes = 60) {
  const config = parseConfig(JSON.stringify({ mcpServers: { box: { command: process.execPath, args: [EVERYTHING], ...entry } } }), {});
  supervisor = new Supervisor(config, { idleTimeoutMinutes });
  await supervisor.start();
  await supervisor.waitUntilSettled();
  const managed = supervisor.get('box')!;
  expect(managed.state).toBe('up');
  const sweep = new UnlockSweep({ store, server: name => supervisor!.get(name), intervalMs: 60_000, graceMs: 5_000 });
  return { managed, sweep };
}

const unlock = (clientId = 'c') => store.addUnlockGrant({ server: 'box', clientId, kind: 'window', grantedAt: Date.now(), expiresAt: Date.now() + 60_000, by: 'page' });

describe('when the last unlock of a whole-locked server ends', () => {
  it('puts an on-demand child to sleep', async () => {
    const { managed, sweep } = await start({ unlock: true });
    unlock();
    await sweep.tick();
    store.revokeUnlockGrants({ server: 'box' });
    await sweep.tick();
    expect(managed.state).toBe('sleeping');
  }, 30_000);

  it('restarts an always-on child, so nothing it held survives', async () => {
    const { managed, sweep } = await start({ unlock: true, keepAlive: true });
    const before = managed.client;
    unlock();
    await sweep.tick();
    store.revokeUnlockGrants({ server: 'box' });
    await sweep.tick();
    expect(managed.state).toBe('up');
    expect(managed.client).toBeDefined();
    expect(managed.client).not.toBe(before);
  }, 30_000);

  it('lets the calls already running finish first', async () => {
    const { managed, sweep } = await start({ unlock: true });
    unlock();
    await sweep.tick();
    let finished = false;
    void managed.track(new Promise<void>(resolve => setTimeout(resolve, 300)).then(() => (finished = true)));
    store.revokeUnlockGrants({ server: 'box' });
    await sweep.tick();
    expect(finished).toBe(true);
    expect(managed.state).toBe('sleeping');
  }, 30_000);

  it('comes back for a child that was still starting when the unlock ended', async () => {
    // A call admitted just before the end wakes the child, and the end arrives
    // while it starts. There is nothing to recycle yet, so the sweep has to
    // look again once the child is up instead of forgetting the server.
    const { managed, sweep } = await start({ unlock: true });
    unlock();
    await sweep.tick();
    await managed.sleep();
    const waking = managed.wake();
    expect(managed.state).toBe('starting');
    store.revokeUnlockGrants({ server: 'box' });
    await sweep.tick();
    await waking;
    expect(managed.state).toBe('up');
    await sweep.tick();
    expect(managed.state).toBe('sleeping');
    await sweep.tick();
    const ended = vi.mocked(console.log).mock.calls.filter(([line]) => String(line).includes('last unlock ended'));
    expect(ended).toEqual([[expect.stringContaining('put to sleep')]]);
  }, 30_000);

  it('leaves the child alone while another client still holds an unlock', async () => {
    const { managed, sweep } = await start({ unlock: true });
    unlock('a');
    unlock('b');
    await sweep.tick();
    store.revokeUnlockGrants({ server: 'box', clientId: 'a' });
    await sweep.tick();
    expect(managed.state).toBe('up');
  }, 30_000);

  it('notices an unlock the admin CLI ended, through the shared state file', async () => {
    const { managed, sweep } = await start({ unlock: true });
    unlock();
    await sweep.tick();
    new AuthStore(dir).revokeUnlockGrants({ server: 'box' });
    await sweep.tick();
    expect(managed.state).toBe('sleeping');
  }, 30_000);
});

describe('when the last unlock of a tool-list lock ends', () => {
  it('leaves the child running, since its other tools are free', async () => {
    const { managed, sweep } = await start({ unlock: { tools: ['get-sum'] } });
    unlock();
    await sweep.tick();
    store.revokeUnlockGrants({ server: 'box' });
    await sweep.tick();
    expect(managed.state).toBe('up');
  }, 30_000);
});

describe('ManagedServer.recycle', () => {
  it('leaves a server alone that is not running', async () => {
    const { managed } = await start({});
    await managed.sleep();
    expect(await managed.recycle()).toBe('kept');
    expect(managed.state).toBe('sleeping');
  }, 30_000);

  it('says pending for a child that is starting or waiting for its restart', async () => {
    const server = new ManagedServer('box', { kind: 'stdio', command: '/bin/false', args: [], env: {}, hub: true });
    for (const state of ['starting', 'down'] as const) {
      server.state = state;
      expect(await server.recycle()).toBe('pending');
    }
    await server.stop();
  });

  it('keeps a stopped or unauthorized server, so the sweep does not wait on it forever', async () => {
    const server = new ManagedServer('box', { kind: 'stdio', command: '/bin/false', args: [], env: {}, hub: true });
    for (const state of ['stopped', 'unauthorized'] as const) {
      server.state = state;
      expect(await server.recycle()).toBe('kept');
    }
    await server.stop();
  });

  it('keeps a remote or socket server whatever its state, since there is no child to recycle', async () => {
    const servers = [
      new ManagedServer('far', { kind: 'remote', transport: 'http', url: 'https://mcp.example.com/mcp', headers: {}, hub: true }),
      new ManagedServer('boxed', { kind: 'socket', transport: 'unix', socketPath: path.join(dir, 'mcp.sock'), hub: true })
    ];
    for (const server of servers) {
      for (const state of ['starting', 'down', 'up'] as const) {
        server.state = state;
        expect(await server.recycle()).toBe('kept');
      }
      await server.stop();
    }
  });
});

describe('ManagedServer.whenIdle', () => {
  it('counts a failed request as finished', async () => {
    const { managed } = await start({});
    await managed.track(Promise.reject(new Error('boom'))).catch(() => {});
    const started = Date.now();
    await managed.whenIdle(5_000);
    expect(Date.now() - started).toBeLessThan(1_000);
  }, 30_000);

  it('resolves at once when nothing runs, and at the latest after the timeout', async () => {
    const { managed } = await start({});
    await managed.whenIdle(10);
    void managed.track(new Promise(() => {}));
    const started = Date.now();
    await managed.whenIdle(100);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  }, 30_000);
});
