# The HTTP layer

There's no Express/Fastify/Koa anywhere in this codebase. `ActiveHttpd` (`packages/httpd/src/httpd.ts`) is a small custom server built directly on [`uWebSockets.js`](https://github.com/uNetworking/uWebSockets.js) (`TemplatedApp`), used by the network host's HTTP transport, the self-hosted storage engine's internal API, and `core`'s REST API. There's no existing doc for this layer at all — this is new.

## Why a native binding, and the version constraint that comes with it

`uWebSockets.js` wraps a native C++ HTTP/WebSocket implementation for throughput reasons — it's meaningfully faster than Node's built-in `http` module for this kind of high-frequency, small-payload traffic. The cost is a native binding constraint worth knowing before you hit it: **it only supports Node 18/20/22/23**. This monorepo has been built and tested specifically against `20.11.0`. If your global Node install is on a newer or odd-numbered version, put a `20.x` install first on `PATH` — child processes this codebase spawns (the restore engine, self-hosted storage) resolve `node` from `PATH` rather than inheriting the parent's `process.execPath`, so having the right binary just on your interactive shell isn't enough.

## Routing

`use(url, method, handler)` registers routes; `findHandler()`/`selectSingleHandler()` do path matching recursively per path segment. There's a known inefficiency here worth knowing about if you're ever tempted to "just presort the routes": the route list gets walked (`while(i--)`, reversing order) at *every level* of the recursion, so a single global presort on registration doesn't survive that — a real fix means restructuring the matcher itself. In practice this hasn't mattered: route counts are small (around 18) and usually only 1-2 candidates match at any level, so it's been left alone rather than risk a routing regression for a marginal gain.

## Request bodies: `readBuffer()`

Both `httpd.ts` and `network/host.ts` have their own copy of this function (parallel implementations, not shared code — worth being aware of if you're fixing something here, since the same fix may need to land in both places, which is exactly what happened during the `hpe-11a` merge). Current behaviour, as of `v4.1.0`:

- Copies each chunk out of the request's `ArrayBuffer` synchronously as it arrives (`onData`'s buffer is neutered — reused for the next chunk — the instant the callback returns, so this copy has to happen immediately, not lazily).
- Uses `Buffer.allocUnsafe` + `.set()` rather than `Buffer.from(ab.slice(0))` — faster, since it skips an intermediate copy.
- Checks `res.aborted` and rejects immediately if the client disconnected mid-request, rather than leaving the promise unresolved forever. This specific check was missing until the `hpe-11a` merge and is a real correctness fix, not just a nice-to-have — without it, an aborted upload could hang whatever was awaiting the body indefinitely.
- Skips `Buffer.concat` entirely for the common case of a single-chunk body (small requests, which is most of them), and `host.ts`'s copy additionally short-circuits a genuinely empty body to `Buffer.alloc(0)`.

## Compression

Bodies are gzip'd/ungzip'd via `ActiveGZip` (`packages/utilities/src/gzip.ts`). On the send side (`request.ts`, the client used for inter-node HTTP calls — see [transport.md](transport.md)), compression is skipped entirely for payloads under 1KB (`GZIP_MIN_BYTES`), since the CPU cost of compressing a small consensus message outweighs the bytes it'd save. The receiving side already branches on the `content-encoding: gzip` header with a graceful fallback if decompression fails ("just in case the magic number [is] still invalid gzip, ... with the original non-gzip[ped] data"), so the threshold is a pure sender-side optimisation — it doesn't change the wire protocol.

## A known, deliberately-unfixed quirk: `enableCORS`

`ActiveHttpd`'s constructor takes an `enableCORS` flag, but as of `v4.1.0` it's effectively dead — CORS headers get written regardless of its value. Two of the three call sites (`core/src/index.ts`, `hybrid/src/server.ts`) pass `true` anyway, so it doesn't matter there. The third, `storage/src/selfhost.ts`, calls `new ActiveHttpd()` with no argument (defaults `false`) and **currently relies on the flag being dead** — CORS headers being written unconditionally is what makes the self-hosted storage API usable cross-origin at all right now. Gating the headers behind the flag properly (the "obviously correct" fix) would silently break that call site. If you want to fix this properly: pass `true` explicitly at the `selfhost.ts` call site first, confirm nothing depends on CORS being absent there, and only then make the flag actually gate the headers.
