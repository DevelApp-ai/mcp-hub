import type { ServerContext, StandardSchemaV1 } from '@modelcontextprotocol/server';

import type { ManagedServer } from './supervisor.js';
import { CALL_TIMEOUT_MS, MAX_CALL_MS, MAX_TIMER_MS, RESET_ON_PROGRESS, assertForwardedResultSize } from './mcp-limits.js';
import { MAX_CHILD_ERROR_CHARS, childText } from './child-text.js';
import { loggableToolName } from './tool-filter.js';

type ChildClient = NonNullable<ManagedServer['client']>;
type RequestOptions = NonNullable<Parameters<ChildClient['request']>[2]>;
type OnProgress = NonNullable<RequestOptions['onprogress']>;

/** What `Client.request` accepts as its result schema. */
export type ClientResultSchema = Parameters<ChildClient['request']>[1] & StandardSchemaV1;

/** The reasons a child is given, in the hub's words and never a caller's. */
export const CLIENT_CANCELLED = 'The client cancelled the request.';
export const PAST_DEADLINE = "The request ran past the hub's deadline.";

/** At most one progress notification per call passes on in this window. */
export const PROGRESS_INTERVAL_MS = 250;

export type Trigger = 'client' | 'deadline' | 'cap';

export interface Deadline {
  readonly signal: AbortSignal;
  /** Which trigger ended the call, if one did. */
  readonly fired: Trigger | undefined;
  /** Starts the deadline over; does nothing once a trigger has fired. */
  restart(): void;
  dispose(): void;
}

/** One abort signal for the three ways a forwarded call ends early. */
export function deadline(caller: AbortSignal, timeoutMs: number, capMs?: number): Deadline {
  const controller = new AbortController();
  let fired: Trigger | undefined;
  const fire = (trigger: Trigger) => {
    if (fired) return;
    fired = trigger;
    controller.abort(trigger === 'client' ? CLIENT_CANCELLED : PAST_DEADLINE);
  };
  const arm = (ms: number, trigger: Trigger) => {
    const timer = setTimeout(() => fire(trigger), ms);
    timer.unref();
    return timer;
  };
  const onCallerAbort = () => fire('client');
  let timer = arm(timeoutMs, 'deadline');
  const cap = capMs === undefined ? undefined : arm(capMs, 'cap');
  if (caller.aborted) fire('client');
  else caller.addEventListener('abort', onCallerAbort, { once: true });
  return {
    signal: controller.signal,
    get fired() {
      return fired;
    },
    restart() {
      if (fired) return;
      clearTimeout(timer);
      timer = arm(timeoutMs, 'deadline');
    },
    dispose() {
      clearTimeout(timer);
      clearTimeout(cap);
      caller.removeEventListener('abort', onCallerAbort);
    }
  };
}

/** True at most once per `intervalMs`. */
export function gate(intervalMs: number, now: () => number = Date.now): () => boolean {
  let last = Number.NEGATIVE_INFINITY;
  return () => {
    const at = now();
    if (at - last < intervalMs) return false;
    last = at;
    return true;
  };
}

/** Whether a JSON-RPC request body carries a progress token. */
export function asksForProgress(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const params = (body as { params?: unknown }).params;
  if (typeof params !== 'object' || params === null) return false;
  const meta = (params as { _meta?: unknown })._meta;
  if (typeof meta !== 'object' || meta === null) return false;
  const token = (meta as { progressToken?: unknown }).progressToken;
  return typeof token === 'string' || Number.isSafeInteger(token);
}

export interface RelayOptions {
  /** Whether the call counts as use, which restarts the server's idle clock when it ends. */
  usage: boolean;
  /** The tool name, for the log line; absent for other methods. */
  tool?: string;
  allowInputRequired?: boolean;
}

function seconds(ms: number): string {
  return ms < 10_000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000));
}

function logEnd(server: string, method: string, tool: string | undefined, trigger: Trigger, elapsedMs: number): void {
  const what = tool === undefined ? method : `${method} "${loggableToolName(tool)}"`;
  const after = `after ${seconds(elapsedMs)}s`;
  if (trigger === 'client') console.log(`[${server}] client cancelled ${what} ${after}`);
  else if (trigger === 'deadline') console.warn(`[${server}] ${what} ran past MCP_CALL_TIMEOUT_MS ${after}, cancelled at the child`);
  else console.warn(`[${server}] ${what} reached MCP_MAX_CALL_MS ${after}, cancelled at the child`);
}

/** Forwards one client request to a child: deadline, cancellation, progress and accounting. */
export async function relay<S extends ClientResultSchema>(
  managed: ManagedServer,
  request: { method: string; params?: unknown },
  resultSchema: S,
  ctx: ServerContext,
  { usage, tool, allowInputRequired }: RelayOptions
): Promise<StandardSchemaV1.InferOutput<S>> {
  const client = managed.client;
  if (!client) throw new Error(`Server "${managed.name}" is not running`);
  // A caller that left while the child was waking: nothing was sent, so nothing is logged.
  if (ctx.mcpReq.signal.aborted) throw new Error(CLIENT_CANCELLED);

  const startedAt = Date.now();
  const limit = deadline(ctx.mcpReq.signal, CALL_TIMEOUT_MS, RESET_ON_PROGRESS ? MAX_CALL_MS : undefined);
  const token = ctx.mcpReq._meta?.progressToken;
  const passes = gate(PROGRESS_INTERVAL_MS);
  const onprogress: OnProgress | undefined =
    token === undefined && !RESET_ON_PROGRESS
      ? undefined
      : progress => {
          if (RESET_ON_PROGRESS) limit.restart();
          if (token === undefined || !passes()) return;
          const message = childText(progress.message, MAX_CHILD_ERROR_CHARS);
          ctx.mcpReq
            .notify({
              method: 'notifications/progress',
              params: {
                progressToken: token,
                progress: progress.progress,
                ...(progress.total === undefined ? {} : { total: progress.total }),
                ...(message ? { message } : {})
              }
            })
            .catch(() => {});
        };

  try {
    return await managed.track(
      client
        .request(request as Parameters<ChildClient['request']>[0], resultSchema, {
          timeout: MAX_TIMER_MS,
          signal: limit.signal,
          ...(onprogress ? { onprogress } : {}),
          ...(allowInputRequired ? { allowInputRequired } : {})
        })
        .then(assertForwardedResultSize)
    );
  } catch (error) {
    if (limit.fired) logEnd(managed.name, request.method, tool, limit.fired, Date.now() - startedAt);
    throw error;
  } finally {
    limit.dispose();
    if (usage) managed.touch();
  }
}
