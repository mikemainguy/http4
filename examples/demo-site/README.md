# Field Notes: the HTTP4 demo site

A small photo-journal page served over HTTP4, with a live panel showing how every resource travelled. The site
is ordinary HTML, CSS and JavaScript. Its only HTTP4 addition is one line, first in `<head>`:

```html
<script src="/http4/auto.js"></script>
```

It also carries an optional second line that saves a round trip on slow links — see below.

`http4d serve` does the rest: it serves the pages, serves the same files over HTTP4, and ships the client and
Service Worker at `/http4/` and `/http4-sw.js`.

## Saving a round trip on a slow link

By default the client discovers where to connect by fetching `/config.json`, which it cannot start until
`auto.js` has loaded. On a fast path that chain costs nothing worth naming. On a slow one it is the difference
between carrying a page's resources and carrying none of them: measured over a throttled link, the session came
up **~8.4 s** in, while the browser had dispatched every image at **3.1 s**, so all of them fell back to plain
HTTP and **0%** of the page's bytes went over HTTP4 (vrek `fnd-sgw2sbh`).

This page removes that round trip by carrying the same JSON inline, before the script tag:

```html
<script type="application/http4-config">{"webTransportUrl": "/wt", "assetPrefix": "/"}</script>
<script src="/http4/auto.js"></script>
```

**A relative URL is the point.** `/wt` resolves against whatever host serves the page, so one line is correct on
every deployment with nothing to keep in sync. Use `assetPrefix` `"/"` for `http4d serve`.

Three things to know:

- **Relative means same port.** `/wt` inherits the page's host *and port*, which is right when the server runs
  `-http :443 -wt :443`. If WebTransport is on its own port, write `//host:4433/wt` or the full URL, and then it
  is pinned to that host again.
- **An unusable block is ignored, not fatal.** Invalid JSON, a missing `webTransportUrl`, a non-https URL, or a
  relative one on a page served over plain HTTP all fall back to fetching `/config.json`. That is exactly what
  happens with `bin/http4d serve` locally, where the dev certificate means the page is plain HTTP — so this line
  costs nothing there and helps in production.
- **A wrong but *usable* URL is still used, not validated.** `https://typo.example/wt` will be dialled, fail, and
  leave the page fallback-only. Relative URLs avoid this whole class of mistake.

## Tuning, without writing JavaScript

The same inline block can carry session settings, so a site can tune HTTP4 from HTML alone:

```html
<script type="application/http4-config">
{"webTransportUrl": "/wt", "assetPrefix": "/",
 "tuning": {"budgetFloor": 524288, "budgetK": 4, "initialGrant": 65536}}
</script>
```

| setting | default | raise it when | lower it when |
|---|---|---|---|
| `budgetFloor` | 128 KiB | a short page load spends itself ramping, so transfers never reach full speed | memory per session matters more than peak throughput |
| `budgetCap` | 16 MiB | a long fat path can hold more in flight | you want a hard ceiling on browser memory |
| `budgetK` | 2 | you want the budget to reach `k × BDP` faster or sit higher | the extra in-flight data is queueing rather than helping |
| `initialGrant` | ~1 BDP, 4–64 KiB | most responses are large, so the first round trip should carry more | the site is mostly small API calls and you want them to share the budget |
| `minIncrement` | 16 KiB | GRANTs are costing more than they are worth | you want the sender fed in finer steps |
| `rtoFloorMs` | | the path's real RTT is well above the default | |
| `maxRecoveries` | 10 | a lossy path should keep trying | a failure should surface sooner |
| `reorderPackets` | 3 | the path reorders heavily and repairs are spurious | | 
| `streamHighWaterMark` | 1 MiB | readers are slow and you want more buffered | memory is tight |
| `earlyResend` | true | | measuring what early repair is worth |
| `sessionSeq` | true | | talking to a server without wire v2 |

The list is an allowlist, and values are type-checked: anything unrecognised, wrongly typed, negative, `NaN` or
infinite is **ignored**, so a typo costs that setting rather than the session. Options passed in JavaScript always
win over the config, so a page can override an embedder.

The two worth reaching for first, on the evidence so far: `budgetFloor`, because a short transfer can spend all of
itself climbing from 128 KiB (vrek `iss-pjpnk4q`), and `initialGrant`, because it decides how much arrives in the
first round trip before any GRANT.

## Priority classes

By default the client schedules shortest-remaining-first, which is a guess about *size*, not importance: a 400 KB
critical bundle loses to a 4 KB tracking pixel. Classes let the page say which matters. There are three —
`critical`, `normal`, `background` — and shortest-first still applies *within* each one.

**Level 0 — nothing to write.** Every request gets a class from its `destination`:

| destination | class | why |
|---|---|---|
| `style`, `script`, `font` | critical | the page cannot paint without them |
| `image`, `video`, `audio` | background | nothing waits on them to become interactive |
| everything else, including `fetch`/XHR | normal | the app is running and can say better |

**Level 2 — a `classes` map in the config block**, when the defaults are wrong for your site:

```html
<script type="application/http4-config">
{"webTransportUrl": "/wt", "assetPrefix": "/",
 "classes": {"/api/": "critical", "/images/hero": "critical", "/images/": "background"}}
</script>
```

Longest matching prefix wins, so `/images/hero` beats `/images/` whatever order you write them in. Anything that
isn't a `/`-prefixed key mapped to one of the three class names is **ignored**, so a typo costs that rule and not
the session.

Two things worth knowing:

- **A background transfer is deferred, not starved.** It gets nothing while critical work wants the whole budget,
  and its turn comes when that work finishes.
- **This changes which resource finishes when, never when the page finishes.** Under a saturated link the last byte
  lands at total bytes ÷ throughput whatever the order (vrek `fnd-m1r3sdp`). Classes decide who waits, not how long
  everyone waits in total.

## Run it

```sh
npm run demo                                  # builds; never starts anything
bin/http4d serve examples/demo-site           # start the server yourself; Ctrl-C to stop
```

Open <http://127.0.0.1:8080/> in Chrome and **reload once**. The first visit installs the Service Worker and loads
over plain HTTP. From the second load on, the stylesheet, script, font, images and JSON calls all come over HTTP4.

## What you'll see

```
┌──────────────────────────── Field Notes ────────────────────────────┐
│   Twelve landscapes from a year of walking…                          │
│        [ HTTP4 ]  ( Plain HTTP )  ( HTTP/3 )                         │
│                                                                       │
│   ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐     Latest notes   Comments    │
│   │ img  │ │ img  │ │ img  │ │ img  │     …              …           │
│   └──────┘ └──────┘ └──────┘ └──────┘                                 │
│                            ┌─────────── HTTP4 · 20 resources · 100% ─┐│
│                            │ srtt 0.4 ms   min RTT 0.3 ms            ││
│                            │ budget 128 KB BDP –  resends 0          ││
│                            │ #  resource      via    size  done  ▭▭▭ ││
│                            │ 1  style.css     http4  3.9 KB  12  ▬   ││
│                            │ 2  app.js        http4  8.1 KB  14  ▬   ││
│                            │ 3  lora-…woff2   http4 21.2 KB  18  ▬   ││
│                            │ 4  meadow.png    http4  154 KB  27   ▬  ││
│                            │ …                                        ││
│                            │ 18 lagoon.png    http4 1.08 MB 110    ▬▬││
│                            └──────────────────────────────────────────┘│
└───────────────────────────────────────────────────────────────────────┘
```

- **The switcher** reloads the same page three ways:
  - **HTTP4** (the default);
  - **Plain HTTP** (`?http4=off`: the page answers the worker at once, so everything goes to the network);
  - **HTTP/3**, shown only when it really works (see below).
- **The panel** (click its header to fold it):
  - One row per resource, in the order they finished, with how each travelled: `http4`, `network`, `fallback`,
    `h3`, or `cache` for Chrome's memory cache.
  - A timeline bar per resource, and the session's srtt, grant budget, BDP estimate and resends.
  - With HTTP4 you can watch the scheduler's shortest-first order: the stylesheet, script, font and small JSON
    calls finish first, then the photos from smallest to largest.
  - It updates from events (Resource Timing and the page's HTTP4 report), not by polling, so it doesn't slow the
    page it measures.

## The HTTP/3 comparison

The same page also loads over plain HTTP/3 from `/h3/index.html` on the QUIC port. That's why every URL in the site
is relative. Chrome only uses HTTP/3 against the dev server's self-signed certificate when launched with two flags:

```sh
bin/http4d serve -h3 examples/demo-site
# copy "spki" from the JSON ready line it prints (it changes on every start), then:
open -na "Google Chrome" --args --user-data-dir="$(mktemp -d)" \
  --origin-to-force-quic-on=127.0.0.1:4433 \
  --ignore-certificate-errors-spki-list=<spki> \
  http://127.0.0.1:8080/
```

The switcher then shows **HTTP/3**. It probes after the page has loaded, and shows the link only if a real `h3`
request succeeded.

## What's in it

| Path | What | Size | Source / licence |
|---|---|---|---|
| `index.html` | the page: 12 photos, notes, comments | 4 KB | this repo |
| `text-only.html` | the same page without photos (G4 baseline) | 2 KB | this repo |
| `style.css` | layout-blocking stylesheet | 4 KB | this repo |
| `app.js` | JSON rendering and the panel (ES module) | 9 KB | this repo |
| `api/*.json` | three small API responses | < 1 KB | this repo |
| `fonts/lora-latin-400.woff2` | Lora Regular, Latin subset | 21 KB | [Lora](https://github.com/cyrealtype/Lora-Cyrillic), SIL Open Font License 1.1 (`fonts/OFL.txt`), fetched from Google Fonts |
| `img/*.png` | 12 photos, 300×200 to 768×512 | 154 KB – 1.08 MB, 6.4 MB total | generated by `gen-images.ts` (not committed) |

The images are procedural: smooth colour fields plus fine grain, drawn from a fixed seed, so every machine generates
the same bytes. The grain keeps them from compressing, so on the wire they behave like photos. `npm run demo` (and
the tests) generate them into `img/`, which is gitignored.

## Measuring it without fooling yourself

Three DevTools settings change what a load actually does, and each has produced a misleading result here:

- **"Disable cache"** (Network panel) — leave it **on** for any measurement. Otherwise Chrome's memory cache serves
  the reload's images and stylesheet itself, they never reach the Service Worker, and the page looks instant while
  transferring almost nothing. A load reporting a handful of grants is usually this.
- **"Update on reload"** (Application → Service Workers) — turn it **off** except when you are deliberately picking
  up a new worker build. With it on, the worker is torn down and re-installed on every load, so it loses the cached
  per-tab answer to its `hello` handshake. Every request then waits for that handshake or falls back, which looks
  like the site hanging.
- **Throttling** (Network panel, and Performance → CPU) — it persists across sessions, so one left on from an
  earlier experiment silently applies to everything afterwards. It also may not apply to WebTransport at all, which
  would flatter HTTP4 while capping the baseline; impair the path outside the browser instead (`tc`/netem on the
  server, or the `impair` proxy in front of both stacks).

Check the panel's **"% of bytes over HTTP4"** before trusting any timing. If it is low, the comparison is measuring
the fallback path on both sides and the numbers mean nothing.

## Tests

`tests/demo/demo.test.ts` loads this site in headless Chrome under `http4d serve -h3`. It measures G7 (the share of
eligible subresource bytes delivered over HTTP4 after the first visit) and the page-load version of G4 (stylesheet
and first-paint timing with and without the photos, over HTTP4, plain HTTP and HTTP/3). It also checks that the
site contains no protocol code. Measured loads turn the browser cache off: otherwise Chrome's memory cache serves a
reload's images and stylesheet by itself, and they never reach the Service Worker.
