# node-red-contrib-sectoralarm-ng

Node-RED nodes for [Sector Alarm](https://www.sectoralarm.com/) — monitor and
control your alarm panel, door locks and temperature sensors.

A complete rewrite that works with the **current** Sector Alarm service
(My Pages / omatsivut.sectoralarm.fi / minasidor.sectoralarm.se /
minside.sectoralarm.no). It talks directly to the JSON API
(`mypagesapi.sectoralarm.net`) with bearer-token authentication — the same
mechanism the official mobile app uses — and has **zero runtime dependencies**.

> The original `node-red-contrib-sectoralarm` package stopped working when
> Sector Alarm replaced their old website; it scraped the legacy site with
> cookie-based logins. This package does not share any code with it.

## Requirements

- Node.js ≥ 18 (native `fetch`)
- Node-RED ≥ 3.0

## Install

From your Node-RED user directory (`~/.node-red`):

```
npm install node-red-contrib-sectoralarm-ng
```

## Nodes

### sectoralarm config (configuration node)

Holds your My Pages credentials (email + password), the optional **panel code**
(needed for disarm/lock/unlock) and the **panel ID**. After entering
credentials, click **Fetch panels** to pick your panel from a list. All nodes
sharing one config node share a single API session — logins happen only when
the token expires.

### sector status

Polls the armed status on a configurable interval (default 60 s, min 10 s) and
**emits a message only when the status changes**. Optionally emits the current
status once on deploy. Any incoming message triggers an immediate query that
always emits.

Output:

```js
{
  topic: "sectoralarm/status",
  payload: {
    status: "armed" | "partialArmed" | "disarmed" | "unknown",
    previousStatus: "disarmed",   // null on first reading
    changed: true,                // false for forced/manual reads without change
    isOnline: true,
    statusTime: "...",
    panelId: "01234567"
  },
  raw: { /* untouched API response */ }
}
```

### sector control

Arms, disarms and operates door locks. The action can be fixed in the node or
come from the message:

| `msg.payload` | Effect |
|---|---|
| `"arm"` | Fully arm |
| `"partialArm"` | Partial (home) arm |
| `"disarm"` | Disarm (requires panel code) |
| `{ command: "lock", lockSerial: "..." }` | Lock a door |
| `{ command: "unlock", lockSerial: "...", code: "1234" }` | Unlock with explicit code |

The panel code defaults to the config node's credential; `msg.payload.code`
overrides it. On success the node outputs
`{ payload: { command, ok: true, panelId } }`; on failure no message is sent
and the error is raised for **Catch** nodes (with `msg.error = { code,
statusCode, message }`).

**⚠ This node operates a real alarm system — wire it deliberately.**

### sector query

One-shot reads, triggered by any message. Query type from the node config or
`msg.payload`: `status`, `panel`, `panels`, `temperatures`, `logs`
(`{type:"logs", pageSize: 20, pageNumber: 1}`), `locks`. The payload is the
raw API response (shapes vary by panel generation); `status` is normalized.

## Migrating from node-red-contrib-sectoralarm

The old package used a single node with string commands. Equivalents:

| Old (`msg.payload`) | New node | New input |
|---|---|---|
| `status`, `check` | **sector status** | built-in polling + change events (or send any msg for an immediate read) |
| `arm` / `partialArm` / `disarm` | **sector control** | same payload strings |
| `lock(123)` / `unlock(123)` | **sector control** | `{ command: "lock", lockSerial: "123" }` |
| `temperatures`, `history`, `locks`, `info` | **sector query** | `temperatures`, `logs`, `locks`, `panel` |
| `annexArm` / `annexDisarm` | not supported | the new API has no public annex endpoint |
| 4 separate outputs | 1 output + **Catch** node | errors carry `msg.error.code` |

Credentials move from the node itself to the shared config node and are stored
in Node-RED's encrypted credentials file. The panel code lives there too.

## Error handling

All failures carry a stable `code`:

| code | meaning |
|---|---|
| `auth_failed` | wrong email/password, or token rejected twice |
| `timeout` | request exceeded 15 s |
| `network` | DNS/connection failure |
| `bad_request` | HTTP 400 — likely an API contract change |
| `api_error` | other unexpected HTTP response |
| `code_required` / `lock_serial_required` / `invalid_input` | input validation |

After a failed login the client waits **5 minutes** before trying again, so a
fast poller cannot lock your account out.

## Notes & known limitations

- *Temperatures* uses the legacy endpoint; the newest "V2" temperature sensors
  report through a different API and may not appear.
- Smart plugs, cameras, and housecheck sensors (doors/windows, smoke, leakage)
  are intentionally out of scope.
- Sector Alarm may eventually migrate the API login to Auth0 (the web portal
  already uses it). If login starts failing with `bad_request`, check this
  repository for updates.

## Development

```
npm install
npm test            # offline unit + node tests (no real API calls)
npm run smoke       # read-only live test: set SA_EMAIL / SA_PASSWORD first
```

## License

MIT
