#!/usr/bin/env node
/**
 * A child that notices when the hub gives up on a call, for
 * test/cancellation-e2e.test.ts.
 *
 * Every observation is one JSON line appended to `$CANCEL_RECORD`, written
 * synchronously because the hub may kill this process right after:
 *
 * - `request`: a `tools/call` or `resources/read` arrived, with its JSON-RPC id
 *   and whether it carried a progress token;
 * - `cancel`: a `notifications/cancelled` arrived, with the id it names and the
 *   reason it gave;
 * - `started` / `aborted`: a waiting handler began, and saw its signal fire.
 *
 * The first two come from a second `data` listener on stdin, beside the SDK's
 * own: both see every chunk, and only this one keeps notes. Matching goes by
 * request id, because a listen stream ending sends a cancellation too.
 *
 * `START_DELAY_MS` holds the handshake back, so a test can act while the hub
 * is still waking this child. `serveStdio`, so the hub negotiates the modern
 * era with it like with any current server.
 */
import fs from 'node:fs';

import { McpServer, acceptedContent, inputRequired } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const RECORD = process.env.CANCEL_RECORD;
const record = (entry) => {
  if (RECORD) fs.appendFileSync(RECORD, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
};

let buffered = '';
function tee(chunk) {
  buffered += chunk.toString('utf8');
  let newline;
  while ((newline = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.method === 'notifications/cancelled') {
      record({ event: 'cancel', requestId: message.params?.requestId, reason: message.params?.reason });
    } else if (message.method === 'tools/call' || message.method === 'resources/read') {
      record({
        event: 'request',
        method: message.method,
        id: message.id,
        name: message.params?.name ?? message.params?.uri,
        progressToken: message.params?._meta?.progressToken ?? null
      });
    }
  }
}

/**
 * Listens only once the SDK does: the first `data` listener starts the stream
 * flowing, and whatever it emits before the SDK's own listener exists is lost
 * to the SDK. The handshake happens before any call this file records.
 */
function attachTee() {
  if (process.stdin.listenerCount('data') > 0) process.stdin.on('data', tee);
  else setImmediate(attachTee);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves 'aborted' when the call is cancelled, or 'timeout' after a safety margin. */
function untilAborted(signal, ms = 20_000) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve('aborted');
    const timer = setTimeout(() => resolve('timeout'), ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve('aborted');
    }, { once: true });
  });
}

async function waitHere(ctx, what) {
  record({ event: 'started', what, id: ctx.mcpReq.id });
  const outcome = await untilAborted(ctx.mcpReq.signal);
  record({ event: outcome === 'aborted' ? 'aborted' : 'not-cancelled', what, id: ctx.mcpReq.id, reason: String(ctx.mcpReq.signal.reason ?? '') });
  return outcome;
}

async function report(ctx, count, intervalMs) {
  const token = ctx.mcpReq._meta?.progressToken;
  if (token === undefined) return;
  for (let i = 1; i <= count; i++) {
    await ctx.mcpReq.notify({
      method: 'notifications/progress',
      params: { progressToken: token, progress: i, total: count, message: `step ${i}\u202e of ${count}` }
    });
    if (intervalMs > 0) await sleep(intervalMs);
  }
}

const ASK = {
  type: 'object',
  properties: { go: { type: 'boolean', title: 'Go on?' } },
  required: ['go']
};

await sleep(Number(process.env.START_DELAY_MS ?? 0));

serveStdio(() => {
  const server = new McpServer({ name: 'cancel-fixture', version: '1.0.0' });

  server.registerTool(
    'wait_for_cancel',
    { description: 'Waits until the call is cancelled.', inputSchema: z.object({ label: z.string().optional() }) },
    async (_args, ctx) => {
      const outcome = await waitHere(ctx, 'wait_for_cancel');
      return { content: [{ type: 'text', text: outcome }] };
    }
  );

  server.registerTool('quick', { description: 'Answers at once.', inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'quick' }]
  }));

  server.registerTool(
    'sleep_for',
    { description: 'Answers after a while, or when cancelled.', inputSchema: z.object({ ms: z.number().int() }) },
    async ({ ms }, ctx) => {
      const outcome = await untilAborted(ctx.mcpReq.signal, ms);
      return { content: [{ type: 'text', text: outcome === 'aborted' ? 'aborted' : 'slept' }] };
    }
  );

  server.registerTool(
    'report_progress',
    {
      description: 'Reports progress if asked to, then answers or waits.',
      inputSchema: z.object({ count: z.number().int(), intervalMs: z.number().int(), thenWait: z.boolean().optional() })
    },
    async ({ count, intervalMs, thenWait }, ctx) => {
      record({ event: 'progress-call', id: ctx.mcpReq.id, sawToken: ctx.mcpReq._meta?.progressToken !== undefined });
      await report(ctx, count, intervalMs);
      if (thenWait) await waitHere(ctx, 'report_progress');
      return { content: [{ type: 'text', text: 'reported' }] };
    }
  );

  server.registerTool(
    'ask_then_wait',
    { description: 'Asks first; the answered round waits only when told to.', inputSchema: z.object({ wait: z.boolean() }) },
    async ({ wait }, ctx) => {
      const answer = acceptedContent(ctx.mcpReq.inputResponses, 'go');
      if (answer === undefined) {
        return inputRequired({
          inputRequests: { go: inputRequired.elicit({ message: 'Go on?', requestedSchema: ASK }) },
          requestState: 'asked'
        });
      }
      if (wait) await waitHere(ctx, 'ask_then_wait');
      return { content: [{ type: 'text', text: 'answered' }] };
    }
  );

  server.registerResource('slow-wait', 'slow://wait', { description: 'Waits until the read is cancelled.' }, async (uri, ctx) => {
    await waitHere(ctx, 'slow://wait');
    return { contents: [{ uri: uri.href, text: 'never read' }] };
  });

  server.registerResource('slow-progress', 'slow://progress', { description: 'Reports progress, then answers.' }, async (uri, ctx) => {
    await report(ctx, 3, 300);
    return { contents: [{ uri: uri.href, text: 'read' }] };
  });

  return server;
});

attachTee();
