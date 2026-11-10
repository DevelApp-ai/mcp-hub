# Hub meta-tools

The `/hub` endpoint exposes exactly six tools, regardless of how many servers
are configured. Four of them are how a client reaches everything else; the
remaining two (`wake_server`, `sleep_server`) steer the
[on-demand lifecycle](/guide/on-demand). A seventh,
[`describe_connection`](#describe-connection), appears only where an operator
switched diagnostics on — and in the other direction,
[`MCP_LIFECYCLE_TOOLS=false`](/reference/environment#lifecycle-tools) takes the
lifecycle pair off, for a client that runs its own idle management (see
[clients that own lifecycle](#clients-that-own-lifecycle)).

Servers marked [`"hub": false`](/guide/configuration#hiding-a-server-from-hub)
keep their *tools* out of the aggregate: `list_tools`, `get_tool_schema` and
`call_tool` refuse them with a pointer to the server's own endpoint. Their
*lifecycle* is still the hub's business — `list_servers` shows them with a
`hidden` marker, and `wake_server`/`sleep_server` manage them like any other
on-demand server.

The [stdio mode](/guide/clients#local-clients-over-stdio) serves the same six
tools with the same behaviour — everything on this page applies there too.

**Every answer below arrives twice.** Five of the six declare an `outputSchema`
and return the same object as `structuredContent` *and* as JSON in a text block:
the first for a program that wants to use the answer, the second for a model or
a person reading it. The JSON shown per tool below is that one object. The
exception is `call_tool`, which hands back the child's own result and therefore
cannot promise a shape of its own — the schema a caller needs there is the
child's, and `get_tool_schema` returns it.

The six carry MCP annotations of their own. `list_servers`, `list_tools` and
`get_tool_schema` are `readOnlyHint: true`; `wake_server` and `sleep_server` are
writes that destroy nothing and are idempotent. `call_tool` is
`destructiveHint: true` and `openWorldHint: true`, because whatever the named
tool does, `call_tool` does — the hub cannot know in advance, and forwarding is
not the same as vouching. Read the child's own annotations from `list_tools` for
what a particular call would do.

A server's `allowTools` / `denyTools` filter applies to every meta-tool below:
`list_tools` and `list_servers`' `toolCount` show only what survives it, and
`get_tool_schema` and `call_tool` refuse a filtered name with the same
"unknown tool" they give for a name that never existed — before the server is
woken. See [filtering tools](/guide/configuration#filtering-tools).

## The intended sequence

```
list_servers  →  list_tools(server)  →  get_tool_schema(server, tool)  →  call_tool(...)
```

A model that already knows a tool's schema can skip straight to `call_tool`.
The tool descriptions are written to steer that order, so no client-side
prompting is needed.

## Minimal clients, and clients that own lifecycle

The aggregate is consumable by the smallest client the protocol allows: one
that speaks `initialize`, `tools/list` and `tools/call` and nothing else — no
elicitation, no sampling, no subscriptions. Every meta-tool is an ordinary
tool, so such a client already reaches all of them: `list_servers`,
`list_tools` and `get_tool_schema` are reads, `call_tool` is the write path,
and the two lifecycle tools are optional extras on top. Nothing on this page
needs more than those three methods; elicitation and subscriptions are
capabilities of the connection, not of the aggregate, and a client that never
offered them simply never hears from them.

`wake_server` and `sleep_server` exist for clients that leave the lifecycle to
the hub: they start a server before the first real call and free it early. A
client that manages lifecycle **itself** — its own idle sweep, its own shutdown
— should not have them: a server such a client just decided to stop comes back
on the next `call_tool` anyway, so the wheel behind its own pedals only costs
context in every conversation. Two switches pair up for exactly that client:

- [`IDLE_TIMEOUT_MINUTES=0`](/reference/environment#limits-and-timeouts) — the
  hub never puts a server to sleep on its own, so lifecycle is the client's
  to run.
- [`MCP_LIFECYCLE_TOOLS=false`](/reference/environment#lifecycle-tools) — the
  pair is absent from `tools/list`, and a call to either name fails the way any
  name that never existed does (`Tool … not found`). The aggregate the
  client sees is four tools, and a `"hub": false` server's lifecycle is no
  longer reachable through it at all — the client that owns lifecycle owns
  that too.

Both doors obey the switch: `/hub` (read per request) and `--stdio` (read per
connection, so a hub spawned for one client is shaped for that client).

## `list_servers`

> List all MCP servers available through this hub, with their status. Call this
> first to see what is available.

No input.

Returns one entry per hub-enabled server:

```json
{
  "servers": [
    { "name": "paperless", "description": "Paperless-ngx", "status": "up",       "toolCount": 14 },
    { "name": "calendar",  "description": "CalDAV",        "status": "sleeping", "toolCount": 6, "hidden": true }
  ]
}
```

`description` is the child's advertised title, falling back to its server name.
`status` is `starting`, `up`, `down`, `stopped`, `sleeping` or `unauthorized`. Listing
never wakes anything — `sleeping` entries still show their cached `toolCount`,
and `unauthorized` means a remote server whose
[upstream OAuth](/guide/configuration#upstreams-that-speak-oauth) needs a login. `hidden`
appears only on `"hub": false` servers: their tools are served exclusively by
their own endpoint, but `wake_server`/`sleep_server` accept them.

On a hub with [locked servers](/guide/unlock), an entry for a server with
locked tools also carries `locked` (whether they are locked for you right now),
`lockedTools` (the patterns, absent when every tool is locked) and
`unlockedUntil` (when your unlock ends).

## `list_tools`

> List the tools of one MCP server with one-line descriptions. Use
> `get_tool_schema` before calling a tool for the first time.

| Input | Type | Description |
|---|---|---|
| `server` | string, required | server name from `list_servers` |

Returns names with one-line descriptions — the first line of each tool's
description, truncated at 120 characters — so listing a large server stays
cheap:

```json
{
  "server": "paperless",
  "tools": [
    {
      "name": "search_documents",
      "description": "Full-text search across all documents",
      "annotations": { "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false },
      "hasOutputSchema": true
    },
    {
      "name": "delete_document",
      "description": "Delete one document",
      "annotations": { "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false }
    }
  ]
}
```

`hasOutputSchema` marks a tool that declares one; the schema itself comes from
`get_tool_schema`, so a large server's list stays a list.

Each tool's [MCP annotations](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool-annotations)
come along, **exactly as the child declared them**. Over `/hub` a client never
sees the child's own `tools/list`, so this is the only place it can learn that
one of two similarly named tools deletes and the other does not.

A tool whose child declared no annotations has no `annotations` key here. An
empty object would read as all four defaults — which, since `destructiveHint`
and `openWorldHint` both default to `true`, is a claim the child did not make.

::: warning Whose word this is
These are the **child's** claims, passed on. The hub does not check them, cannot,
and does not summarise them into a marker of its own — that would be the hub's
statement about somebody else's server. The specification is blunt about what
they are worth:

> clients **MUST** consider tool annotations to be untrusted unless they come
> from trusted servers

An annotation is a hint. The thing a well-built child enforces instead is a
confirmation dialog, and the hub
[passes elicitation through](/guide/elicitation) so that still reaches you.
:::

Errors: an unknown server, or an always-running server that is not `up`,
returns a tool error naming the state. A `sleeping` server answers from its
cached snapshot and is [pre-warmed in the background](/guide/on-demand#what-wakes-a-server-and-what-does-not) —
asking for its tools is the strongest hint a call follows.

## `get_tool_schema`

> Get the full description and JSON input schema of one tool, needed to
> construct arguments for `call_tool`.

| Input | Type | Description |
|---|---|---|
| `server` | string, required | server name from `list_servers` |
| `tool` | string, required | tool name from `list_tools` |

Returns the untruncated description and the tool's JSON Schemas:

```json
{
  "server": "paperless",
  "name": "search_documents",
  "description": "Full-text search across all documents…",
  "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] },
  "outputSchema": { "type": "object", "properties": { "hits": { "type": "array" } } },
  "annotations": { "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
}
```

`annotations` is the child's, verbatim, and absent when the child declared none —
see the note under [`list_tools`](#list-tools).

`outputSchema` is the child's too, and absent for a tool that declares none. It
is what makes the `structuredContent` from `call_tool` usable: over `/hub` a
client never sees the child's own `tools/list`, so without this it would be
handed structured data with no way to learn its shape.

This is the step that keeps context small: full schemas are pulled in one at a
time, only for tools actually being used.

## `call_tool`

> Call a tool on one of the MCP servers. Arguments must match the schema from
> `get_tool_schema`.

| Input | Type | Description |
|---|---|---|
| `server` | string, required | server name from `list_servers` |
| `tool` | string, required | tool name from `list_tools` |
| `arguments` | object, optional | arguments matching the tool's input schema |

The child's result is returned unchanged — content blocks, images,
`structuredContent`, `_meta` and `isError` all pass through. This is the one
meta-tool with no `outputSchema` of its own: what comes back is shaped by the
child, not by the hub, and the schema to validate it against is the
`outputSchema` from [`get_tool_schema`](#get-tool-schema).

Timeout: 5 minutes, absolute unless `MCP_RESET_TIMEOUT_ON_PROGRESS` lets
progress extend it. A call that runs out, or that the client cancels, is
cancelled at the child too, and progress the child reports reaches the caller
under the caller's own token. A failure comes back as a tool error (`Tool call
failed: …`) rather than an HTTP error, so the model can react to it.

Calling a `sleeping` server wakes it first and blocks until it is up (120-second
budget) — the call itself then proceeds normally. Only a start that fails for
the whole budget surfaces as a tool error.

## `wake_server`

> Start an on-demand server now so its first tool call is fast. No-op if it is
> already running.

Absent when [`MCP_LIFECYCLE_TOOLS=false`](/reference/environment#lifecycle-tools)
— see [clients that own lifecycle](#clients-that-own-lifecycle).

| Input | Type | Description |
|---|---|---|
| `server` | string, required | server name from `list_servers` |

Blocks until the server is up and returns `{ name, status, toolCount }`. Useful
at the start of a longer workflow: the cold start happens while the model is
still planning instead of inside the first real call. An always-running server
(`keepAlive` or remote/socket) is refused with `… is always running`.

## `sleep_server`

> Stop an on-demand server immediately instead of waiting for its idle timeout.
> It restarts automatically on the next tool call.

Absent when [`MCP_LIFECYCLE_TOOLS=false`](/reference/environment#lifecycle-tools)
— see [clients that own lifecycle](#clients-that-own-lifecycle).

| Input | Type | Description |
|---|---|---|
| `server` | string, required | server name from `list_servers` |

Frees the server's resources right away — the stdio child exits, a sandbox
container is removed. Returns `{ name, status }`; already-sleeping servers are
a no-op. Always-running servers are refused.

## `describe_connection`

Present only when [`MCP_DIAGNOSTICS`](/reference/environment#diagnostics) is
`true`, which is why the endpoint is described above as exactly six tools. With
the switch on it is seven.

> Report how you are connected to this hub right now: the protocol era, and
> whether a server could ask you a question mid-call.

| Input | Type | Description |
|---|---|---|
| `server` | string, optional | server name from `list_servers`; omit to ask about the connection alone |

```json
{
  "era": "legacy",
  "revision": "2025-11-25",
  "hubVersion": "0.11.0",
  "caller": { "declaresElicitation": false },
  "elicitation": {
    "wouldForward": false,
    "reason": "the caller declared no elicitation capability for this request, so a question would have nowhere to go"
  }
}
```

It exists because of one silence that has two causes. When a server that would
normally ask for confirmation falls back to its two-call token instead, the
client cannot tell whether nobody asked or whether *it* cannot be asked — and
the answer decides whether anything is wrong at all. Ask this tool and the hub
says which.

Named without a `server`, the answer covers what does not vary by child: the
era, whether this request carried an elicitation capability, and the operator's
global switch. Whether a *particular* server may ask also depends on that
server's own switch and era, so `wouldForward` is then absent and the reason
says so rather than guessing. Name a server and all four conditions are
answered — the same decision `call_tool` makes, from the same function, so the
explanation cannot drift from the behaviour.

A named server is never woken to answer: a sleeping child has negotiated no era,
and the answer says that instead of starting it. This tool reports, it does not
act.

When the hub does drop a question, it also says so once in its own log — per
client, server and reason. See [Elicitation](/guide/elicitation).

## `request_unlock`

> Get a link the user opens to unlock a locked server for you, before you call
> its tools.

Present only on a hub where some server has `unlock`, and not over stdio.
Input `{ server }`. Returns `status` (`unlocked`, `pending` or `denied`), and
for `pending` the `url` for the user, the matching `code` and when the link
expires. A server hidden from `/hub` is answered with a pointer to its own
connector: an unlock asked for here would belong to the `/hub` authorization,
not to the one that can reach the server.

## `lock_server`

> End your unlocks of a server now, once you are done with it.

Present alongside `request_unlock`. Input `{ server }`. Ends the caller's own
unlocks of that server and nobody else's, and returns how many. It can never
unlock anything.

A call to a locked tool through `call_tool` answers with the link the same way;
see [what a model sees](/guide/unlock#what-a-model-sees).

## Caching

The hub keeps each child's tool list in memory and refreshes it when the child
sends `tools/list_changed`. `list_servers` and `list_tools` are therefore
answered without a round trip to the child. For on-demand servers the same
snapshot is [persisted to disk](/guide/on-demand#the-tool-cache), which is what
lets a sleeping server answer at all.

Clients are not notified of those changes — the [stateless
transport](/guide/architecture#stateless-transport) has no channel for push
traffic — but the next `list_tools` call reflects them.

`call_tool` does carry one thing outward that looks like a push and is not: on
`2026-07-28` a child asking the user something comes back through this
meta-tool as the call's result, and the answer goes in on the retry. See
[Elicitation](/guide/elicitation).

## When to use direct paths instead

`/hub` trades one extra round trip for a much smaller context. For a server you
call constantly, registering `/<name>/mcp` as its own connector puts the native
tools directly in the model's hands. The two mix well: give the daily drivers
their own connectors, mark them `"hub": false`, and let `/hub` cover the long
tail.
