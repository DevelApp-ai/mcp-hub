/**
 * Budgets for everything a child server sends back.
 *
 * The hub forwards what an MCP server produces, so an oversized or endless
 * response is the child's way of exhausting the hub's memory and, through it,
 * every other server's availability. These are the ceilings; they are not
 * meant to be reached by anything legitimate.
 */
export const MAX_TOOL_LIST_PAGES = 100;
export const MAX_TOOLS = 10_000;
export const MAX_TOOL_METADATA_BYTES = 16 * 1024 * 1024;
export const MAX_FORWARDED_RESULT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_CALL_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_MAX_CALL_MS = 30 * 60_000;

/** The longest delay a Node timer holds; a larger one fires after 1 ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** Deadline of one forwarded call; with progress resets on, MAX_CALL_MS still bounds it. */
export const CALL_TIMEOUT_MS = timerEnv('MCP_CALL_TIMEOUT_MS', DEFAULT_CALL_TIMEOUT_MS);
export const RESET_ON_PROGRESS = booleanEnv('MCP_RESET_TIMEOUT_ON_PROGRESS', false);
export const MAX_CALL_MS = Math.max(timerEnv('MCP_MAX_CALL_MS', DEFAULT_MAX_CALL_MS), CALL_TIMEOUT_MS);

/** `positiveIntegerEnv`, cut to what a timer can wait; also past 2^53, where it would fall back. */
function timerEnv(name: string, fallback: number): number {
  const asked = Number(process.env[name]);
  const value = Number.isInteger(asked) && asked > MAX_TIMER_MS ? asked : positiveIntegerEnv(name, fallback);
  if (value <= MAX_TIMER_MS) return value;
  console.error(`mcp-hub: ${name} is longer than a timer can wait, using ${MAX_TIMER_MS}`);
  return MAX_TIMER_MS;
}

/**
 * Warn and fall back rather than exit: this module is imported by the request
 * path and by the tests, and index.ts is the only place allowed to end the
 * process over a bad environment.
 */
export function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    console.error(`mcp-hub: ${name} must be a positive integer, using ${fallback}`);
    return fallback;
  }
  return value;
}

/** Same contract as `positiveIntegerEnv`, for the knobs where `0` means "off". */
export function nonNegativeIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    console.error(`mcp-hub: ${name} must be a non-negative integer, using ${fallback}`);
    return fallback;
  }
  return value;
}

export function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  console.error(`mcp-hub: ${name} must be true or false, using ${fallback}`);
  return fallback;
}

export function jsonSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function assertForwardedResultSize<T>(result: T): T {
  const size = jsonSize(result);
  if (size > MAX_FORWARDED_RESULT_BYTES) {
    throw new Error(`MCP result exceeds the ${MAX_FORWARDED_RESULT_BYTES} byte forwarding limit`);
  }
  return result;
}
