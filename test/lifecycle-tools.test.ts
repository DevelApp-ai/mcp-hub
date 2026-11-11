import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { authorizeInBrowser, registerPublicClient } from './auth-flow.js';
import { createHub } from '../src/index.js';
import { createStdioHub } from '../src/stdio.js';

/**
 * `MCP_LIFECYCLE_TOOLS=false` takes `wake_server` and `sleep_server` off the
 * aggregate — the one switch this hub offers a client that manages lifecycle
 * itself.
 *
 * The client that needs it is the spawning kind: a supervisor that already
 * runs its own idle sweep and its own shutdown does not want two wheels
 * behind the same pedals, and every tool on the aggregate costs context in
 * every conversation the client ever has. The four data-plane meta-tools
 * (`list_servers`, `list_tools`, `get_tool_schema`, `call_tool`) are the
 * aggregate's argument; the lifecycle pair is optional equipment, and this
 * file pins what turning it off does on both doors.
 *
 * Default-off assertions live in the other suites, which count six tools —
 * here the point is the trimmed four, per door, and that the switch is read
 * per request/per connection so it can be trusted either way.
 */

const PASSWORD = 'test-password';
const REDIRECT_URI = 'http://localhost:33421/callback';

/** The six the aggregate shows by default, and the four it shows trimmed. */
const SIX = ['call_tool', 'get_tool_schema', 'list_servers', 'list_tools', 'sleep_server', 'wake_server'];
const FOUR = ['call_tool', 'get_tool_schema', 'list_servers', 'list_tools'];

/**
 * HTTP door. `createHub` is built once per file, so the switch has to be read
 * per request for the same hub to serve both shapes — which is also the
 * deployment reality: one hub, many connectors.
 */
let tmpDir: string;
let hub: Awaited<ReturnType<typeof createHub>>;
let httpServer: ReturnType<Awaited<ReturnType<typeof createHub>>['app']['listen']>;
let baseUrl: string;
let token: string;

async function connect(): Promise<Client> {
  const client = new Client({ name: 'lifecycle-tools-test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/hub`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  );
  return client;
}

async function toolNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map(tool => tool.name).toSorted();
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-lifecycle-'));
  const configPath = path.join(tmpDir, 'mcp.json');
  // No children: nothing here is about the children, and a child would make
  // "is the aggregate the right shape" wait on "is the child up".
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
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
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

  const clientId = await registerPublicClient(hub.app, REDIRECT_URI);
  const { code, verifier } = await authorizeInBrowser(hub.app, clientId, { password: PASSWORD, redirectUri: REDIRECT_URI });
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

afterEach(() => {
  delete process.env.MCP_LIFECYCLE_TOOLS;
});

describe('over HTTP', () => {
  it('serves the six when the switch is not set', async () => {
    const client = await connect();
    expect(await toolNames(client)).toEqual(SIX);
    await client.close();
  });

  it('serves only the four data-plane meta-tools when it is false', async () => {
    process.env.MCP_LIFECYCLE_TOOLS = 'false';
    const client = await connect();
    expect(await toolNames(client)).toEqual(FOUR);
    await client.close();
  });

  it('is read per request, so the six come back when it goes away', async () => {
    process.env.MCP_LIFECYCLE_TOOLS = 'false';
    const client = await connect();
    expect(await toolNames(client)).toEqual(FOUR);

    delete process.env.MCP_LIFECYCLE_TOOLS;
    expect(await toolNames(client)).toEqual(SIX);
    await client.close();
  });

  it('answers a call to a trimmed tool the way it answers any name that never existed', async () => {
    process.env.MCP_LIFECYCLE_TOOLS = 'false';
    const client = await connect();
    await expect(client.callTool({ name: 'wake_server', arguments: { server: 'anything' } })).rejects.toThrow(/not found/);
    await client.close();
  });
});

function writeConfig(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-lifecycle-stdio-'));
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }));
  return file;
}

describe('over stdio', () => {
  // The stdio hub is spawned per client session, so a hub trimmed for the
  // client that asked for it is the mode's own shape of the feature.
  const started: Array<Awaited<ReturnType<typeof createStdioHub>>> = [];

  afterEach(async () => {
    for (const stdio of started.splice(0)) {
      stdio.watcher.stop();
      await stdio.supervisor.stop();
    }
  });

  it('serves the six when the switch is not set', async () => {
    const stdio = createStdioHub({ configPath: writeConfig(), idleTimeoutMinutes: 0 });
    started.push(stdio);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await stdio.build('modern').connect(serverTransport);
    const client = new Client({ name: 'vitest', version: '1.0.0' });
    await client.connect(clientTransport);
    expect(await toolNames(client)).toEqual(SIX);
    await client.close();
  });

  it('serves the four through serveStdio, the entry a spawning client meets', async () => {
    process.env.MCP_LIFECYCLE_TOOLS = 'false';
    const stdio = createStdioHub({ configPath: writeConfig(), idleTimeoutMinutes: 0 });
    started.push(stdio);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(ctx => stdio.build(ctx.era), { transport: serverTransport });
    const client = new Client({ name: 'vitest', version: '1.0.0' });
    await client.connect(clientTransport);
    expect(await toolNames(client)).toEqual(FOUR);
    await client.close();
    await handle.close();
  });
});
