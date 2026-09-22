# Spike: HTTP4 from a Service Worker

Throwaway research code, not part of the product. It answers vrek question
`que-hj4664k`: can a Service Worker serve a site's subresources over HTTP4?
The answer informed decision `dec-sf6t0g6`: an explicit API with a
page-owned session, plus a Service Worker that forwards to it.

The worker (`sw-src.js`) bundles the real client (`client/src/transport.ts`),
opens a WebTransport session with `serverCertificateHashes`, and answers
same-origin `/assets/*` fetch events with Responses built from HTTP4 bytes.
The assets are deliberately not under `www/`, so anything that loads came over
HTTP4.

| Run | What it checks | Findings |
|---|---|---|
| `node spikes/sw-webtransport/run.ts` (~10 s) | WebTransport inside the worker; img, stylesheet, module script, fetch() and 3 MB served over HTTP4; first-visit behaviour; recovery after the worker is killed; strict MIME on a module script with no Content-Type | `fnd-q99xxg1`, `fnd-hnymjv8`, `fnd-7ecs69k` |
| `spikes/sw-webtransport/idle-probe.sh` (~2 min) | Whether Chrome terminates an idle worker holding an open session. It runs Chrome without DevTools, because Playwright's DevTools attachment keeps workers alive. | `fnd-f844ews` |

Results on 2026-09-22 (Chrome 153.0.8010.53, macOS arm64, loopback):

- The worker had WebTransport and served every resource type over HTTP4.
  3 MB took ~40 ms. The server sent 0 un-granted bytes.
- On first visit, the `<img>` in the initial HTML loaded before the worker took
  control and went to the network (404). After a reload it was served over HTTP4.
- A module script without Content-Type was rejected (strict MIME checking).
- An idle worker was terminated and restarted within a 45 s gap, and again
  within 75 s. The session dies with the worker; the next request reconnects
  (~10 ms on loopback, ≥2 RTT on a real path).

Not covered: Firefox/Safari, forwarding from the worker to a page-owned
session (the chosen design; verified first in `iss-s05bzsh`), Range requests,
and the Cache API.
