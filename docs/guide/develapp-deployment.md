# DevelApp: networked deployment

::: info Status: evaluated — not needed now
This page records the evaluation so it never has to be re-derived. Nothing in
the hub's code exists because of it; the fork is kept as the documented answer
for the day a networked, multi-client MCP surface is actually needed.
:::

DevelApp keeps this fork as the recorded alternative from Taskhandler's TDS
§8A.7: an external MCP gateway was **rejected** for the aggregation boundary
Taskhandler already owns in-process, and this hub stays as the documented
answer should a networked, multi-client MCP surface ever be needed.
Taskhandler's own client (TDS §8A.1) speaks JSON-RPC 2.0 over stdio at revision
2025-06-18 and spawns its servers as child processes — it needs none of what
this page describes. Everything below is what adopting the hub's HTTP mode
would mean, and the recommendation.

## The recommendation: no-go, recorded

**Not now.** Three reasons, each enough on its own:

- **The boundary already has an owner.** Taskhandler aggregates in-process; the
  hub would be a second process and a second protocol bridge for a boundary
  that is already served, which is the exact shape §8A.7 rejected.
- **The machines bind nothing.** Taskhandler runs on the Z13 pair —
  shift-based desktops that are off when nobody works, and whose TDS §10
  posture binds nothing by default. The HTTP mode is a listener plus TLS plus
  proxy trust plus rate-limit hygiene plus fail2ban wiring plus an OAuth admin:
  exactly the standing surface that posture exists to avoid, proposed for
  hardware that powers off at the end of a shift.
- **No client is asking.** A networked surface pays for clients that cannot
  spawn processes — hosted assistants, agents on other machines. None exists
  today; Taskhandler spawns, and nothing else has asked.

The trigger to revisit is singular: **a client that cannot spawn a process
needs MCP.** Nothing short of it is worth the listener.

## Where it would run, if ever

Not on a Z13. A shift-based desktop is the wrong home for an always-on
listener — the hub's whole value is that it is always there, and the desktop is
not. The right home is the DevelApp standard platform, where an always-on
service already has a shape: container orchestration, TLS terminated at the
edge, deny-by-default network policy. The hub binds `127.0.0.1:7690` on its own
host and the reverse proxy is the only network-facing surface.

A Z13 is acceptable only under an explicit recorded exception to the TDS §10
posture that names the host, the hostname and who administers it — and accepts
in writing that the surface disappears when the shift ends. If that sentence
reads badly, that is the point: it is the sentence that stops the exception
from being taken quietly.

## The binds-nothing exception, precisely

TDS §10 binds nothing by default. Adopting the HTTP mode is exactly one
exception — a listener — and everything else follows from keeping it small:

- the hub itself never faces the network; it binds loopback and the proxy
  fronts it,
- the proxy terminates TLS and is the only entry in `TRUSTED_PROXIES`,
- every other port the deployment touches stays bound where it was.

The exception to record before anything is started: which host, which
hostname, who holds the password and the TOTP secret, and who watches the logs.
That is the whole decision; the rest of this page is the recipe for it.

## The recipe, if it ever flips to go

The operational detail lives on the existing pages; this is the DevelApp
shaping of it, in the order the [deployment checklist](/guide/security#deployment-checklist)
already assumes:

- **Reverse proxy + TLS.** Use the
  [nginx or Caddy config](/guide/deployment#reverse-proxy) as written: SSE
  answers must stream (`proxy_buffering off`, `flush_interval -1`), and the
  proxy read timeout must sit above the hub's silent-answer bound —
  `HTTP_REQUEST_TIMEOUT_MS` (310 s) bounds the request, but a silent tool
  answer may legitimately run to `MCP_CALL_TIMEOUT_MS` (5 min) or
  `MCP_MAX_CALL_MS` (30 min with progress resets). The example's 330 s covers
  the defaults; raise proxy and call deadlines together.
- **`EXTERNAL_URL`** set to the exact public HTTPS origin, so the
  authorization server builds correct redirect URLs.
- **`TRUSTED_PROXIES`** holding only the proxy's address, with the proxy
  *overwriting* (not appending to) `X-Forwarded-For` — otherwise the per-caller
  login rate limiter degrades to one global counter
  ([details](/guide/security#trusted-proxies)).
- **Rate limits.** Failed logins are already capped at 10 per 15 min per
  caller and logged as `authentication failure from <ip>` — that line is the
  fail2ban anchor, not an extra feature to build.
- **fail2ban.** Set `LOG_FILE`, then install the
  [filter and jail](/guide/deployment#fail2ban); when the proxy is
  container-based, bans must land in `DOCKER-USER`, and any generic 401 jail
  must exclude the hub's vhost (the OAuth flow produces legitimate 401s).
- **Login and admin.** `PASSWORD_HASH` (bcrypt), [two-factor
  login](/guide/two-factor) with `TOTP_SECRET` kept apart from the password,
  resource-bound tokens left at their default, the [admin CLI](/reference/admin-cli)
  for client/token/unlock administration, and API tokens for clients that
  cannot do OAuth.
- **Compose skeleton.** The [example](/guide/deployment#docker-compose) is the
  starting point — loopback bind, read-only root filesystem, `/data` on a
  persistent private volume.

## What changes in the code

Nothing. This page is the deliverable: the evaluation says the hub's HTTP mode
is not deployed, and the code already ships everything the recipe above needs.
If the evaluation ever flips to go, the work is operational — a host, a proxy, a
certificate, the environment variables above — and the first code change, if
any, gets its own issue.
