# http4-client

Browser client for HTTP4: fetch a site's assets over a receiver-driven,
SRPT-scheduled transport on WebTransport datagrams, and fall back to the
normal `fetch()` whenever HTTP4 can't be used.

Build with `npm run build` at the repo root. It writes `client/dist/http4.js`
(ESM, no dependencies) and `client/dist/types/` (declarations).

```js
import { connect } from "./http4.js";

const http4 = await connect();                 // reads /config.json
const res = await http4.fetch("/assets/app.css");
console.log(res.headers.get("content-type"));  // from the server's META
console.log(http4.report().at(-1));            // { transport: "http4", ms, bytes, … }
```

## What goes over HTTP4

`http4.fetch(input, init)` takes the same arguments as `fetch` and returns a
real `Response`. A request goes over HTTP4 when it is a same-origin `GET` or
`HEAD` with no body and no `Range` header, and its path maps to an asset ID.
By default a path maps if it starts with `/assets/`: `/assets/img/a.png` is
asset `img/a.png`, and the query string is ignored. Change that with
`assetPrefix` or `pathToAssetId(url)`. Everything else is handed to the
platform `fetch` unchanged.

The server (`http4d`) serves the same asset directory over plain HTTP at
`/assets/`, so both paths return the same bytes and headers.

## Fallback

`connect()` never rejects. If WebTransport is missing, the config or the
connection fails (`connectTimeoutMs`, default 5 s), or the session closes
later, requests go to the platform `fetch`. A single transfer that fails also
falls back, except `NOT_FOUND`: the server answered authoritatively, so the
result is a 404 `Response`. `http4.available` and `http4.unavailableReason`
show the current state.

## Report

Every request is recorded (`report()`, last 1000, or the `onRequest` callback)
as `{ url, method, transport, reason?, status, ms, bytes }`. `transport` is one
of:

- `"http4"`: served over HTTP4.
- `"fallback"`: eligible for HTTP4, but served by `fetch`; `reason` says why.
- `"platform"`: not an HTTP4 request (cross-origin, POST, other path, Range).

## Options

`connect()` takes:

- `webTransportUrl` and `certHash`: `certHash` (bytes or base64) is for
  development only, with a self-signed certificate. Without `webTransportUrl`,
  both are read from `configUrl`.
- `configUrl`, `assetPrefix`, `pathToAssetId`, `baseUrl`, `onRequest`,
  `reportLimit`, `connectTimeoutMs`, and `fetch` (the fallback fetch).
- Transport tuning, passed through to `Http4Client`: `budget`, `minIncrement`,
  `initialGrant`, `rtoFloorMs`, `maxRecoveries`. `trace` and `dropOutgoing`
  are for tests only.

## Drop-in: Service Worker

For a site to load its own markup-referenced resources over HTTP4 (img, CSS,
scripts, fonts, fetch) without code changes, serve two built files and add
one tag, first in `<head>`:

- `dist/http4-sw.js` at the site root, as `/http4-sw.js` (its scope must cover the site);
- `dist/auto.js` as `/http4/auto.js`.

```html
<script src="/http4/auto.js"></script>
```

`auto.js` opens this tab's HTTP4 session, registers the worker, and exposes
`window.http4`: `ready` (the tab's `Http4` handle), `registration`,
`controlled`, and `report({ all? })` (how the worker served each request).
`install(opts)` does the same programmatically; the tag also accepts
`data-config-url` and `data-asset-prefix`.

The worker holds no session. It forwards each same-origin GET/HEAD
subresource to the tab that made it, and that tab's session answers, with the
body transferred back, not copied. The session therefore lives as long as the
tab, not the worker, which Chrome stops after ~30 s idle. The worker goes to
the network for:

- navigations;
- the first visit, before it controls the page;
- tabs without the bridge;
- sessions that are down or not up within 2 s;
- failed transfers.

It never forwards `/http4/*`, `/http4-sw.js` or `/config.json`. Forwarding
costs about 1 ms per small request on loopback.

## Limits

- An aborted request stops waiting, but its HTTP4 transfer runs to completion,
  because the protocol has no cancel.
- `HEAD` transfers the whole body over HTTP4 and discards it.
- A closed session is not reopened: later requests fall back until you call
  `connect()` again.
