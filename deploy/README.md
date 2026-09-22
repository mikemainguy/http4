# Deploying an HTTP4 site

`http4d serve` on a small VM, with a real certificate, serving a site over
HTTPS with its assets over HTTP4 (vrek iss-fzz5beq).

Everything below assumes one host with a public IP and a DNS name pointing at
it. HTTP4 needs **inbound UDP**, which is the part most hosting setups get
wrong; see [Why not a reverse proxy or CDN](#why-not-a-reverse-proxy-or-cdn).

## Ports

| Port | Protocol | What uses it |
|---|---|---|
| 443 | **TCP** | The pages, the plain-HTTP fallback for assets, `/config.json` |
| 443 | **UDP** | QUIC: WebTransport (HTTP4) and, with `-h3`, the HTTP/3 baseline |
| 80 | TCP | Redirect to HTTPS, and the ACME HTTP-01 challenge |

TCP 443 and UDP 443 are different things, and a cloud firewall that allows
"HTTPS" usually means only the TCP one. Open both, in the instance firewall
(`ufw allow 443/udp`) and in the cloud security group.

## Build

```sh
npm install
npm run build          # the client bundle; http4d embeds whatever is in client/dist
cd server && go build -o /usr/local/bin/http4d ./cmd/http4d
```

`npm run build` must run before `go build`: the binary embeds the client, and
without it `/http4/*` answers 503 (and `http4d serve` says so at startup).

## Certificates

### Automatic (ACME / Let's Encrypt)

```sh
http4d serve \
  -http :443 -wt :443 \
  -cert acme -domain demo.example -acme-email ops@demo.example \
  -acme-cache /var/lib/http4d/acme \
  -origin https://demo.example \
  /srv/demo-site
```

The first request for the name triggers issuance. `-acme-cache` is required:
without it every restart asks the CA again and runs into its rate limit. Back
that directory up, or at least keep it on the instance's persistent disk.

Challenges are answered two ways, and either alone is enough:

- **HTTP-01** on the redirect listener, which `-cert acme` turns on at `:80` by
  default (`-redirect off` to disable).
- **TLS-ALPN-01** on the HTTPS listener, because the TLS config offers
  `acme-tls/1`.

Rehearse with `-acme-staging` first. It issues untrusted certificates from
Let's Encrypt's staging CA, so browsers will complain, but everything else
(DNS, firewall, challenge routing) is proven without spending the production
rate limit.

### Certificate files

If something else renews (a shared certbot, a company CA, Caddy next door):

```sh
http4d serve -http :443 -wt :443 \
  -cert file:/etc/letsencrypt/live/demo.example/fullchain.pem,/etc/letsencrypt/live/demo.example/privkey.pem \
  -redirect :80 -origin https://demo.example /srv/demo-site
```

Send `SIGHUP` after a renewal and the pair is re-read without dropping
connections (`systemctl reload http4d` with the unit below). A broken pair is
logged and the old certificate stays in use.

### Development

`-cert dev` (the default) generates a throwaway certificate each start and
pins its hash in `/config.json`. Pages stay on plain HTTP, which is a secure
context on loopback. It is localhost-only and will not work for visitors.

## Origins

The server only accepts HTTP4 sessions from pages it recognises. Its own
loopback origin is always allowed; a deployment must name its public one:

```sh
-origin https://demo.example        # repeat for more, e.g. -origin https://www.demo.example
```

Without it, browsers get a 403 on the WebTransport upgrade and the client falls
back to plain HTTP: the site works, but nothing uses HTTP4.

## Metrics

`/metrics.json` defaults to `-metrics local` in serve mode: loopback clients
only, so a stranger can't poll your counters. `-metrics off` removes it
entirely, `-metrics public` exposes it (what the sandbox server does for tests).

## systemd

```ini
# /etc/systemd/system/http4d.service
[Unit]
Description=HTTP4 demo site
After=network-online.target

[Service]
ExecStart=/usr/local/bin/http4d serve -http :443 -wt :443 \
  -cert acme -domain demo.example -acme-email ops@demo.example \
  -acme-cache /var/lib/http4d/acme -origin https://demo.example /srv/demo-site
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
User=http4d
Group=http4d
StateDirectory=http4d
# Binding 80/443 without running as root:
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadOnlyPaths=/srv/demo-site

[Install]
WantedBy=multi-user.target
```

```sh
systemctl daemon-reload && systemctl enable --now http4d
```

## Verifying a deployment

1. **The page is HTTPS and valid.**
   ```sh
   curl -sSI https://demo.example/ | head -1
   curl -sS  http://demo.example/  -o /dev/null -w '%{http_code} %{redirect_url}\n'   # 301 https://demo.example/
   ```
2. **No hash pinning.** `certHash` must be absent; its presence means the dev
   certificate is still in use, and no visitor can open a session.
   ```sh
   curl -sS https://demo.example/config.json | tee /dev/stderr | grep -q certHash && echo 'STILL PINNED'
   ```
3. **UDP really arrives.** From another machine:
   ```sh
   nc -zvu demo.example 443     # nothing proves it like the browser, but a filtered port shows here
   ```
4. **In Chrome:** open the site, reload once (the first visit installs the
   Service Worker), and check the demo's panel, or run in the console:
   ```js
   (await window.http4.report()).map(r => `${r.transport} ${new URL(r.url).pathname}`)
   ```
   Every same-origin subresource should say `http4`. `fallback` means the
   session didn't open: check `-origin`, UDP reachability, and the certificate.
5. **The certificate Chrome sees** (also the SPKI hash, if you ever need to
   pin one in a test):
   ```sh
   openssl s_client -connect demo.example:443 </dev/null 2>/dev/null \
     | openssl x509 -pubkey -noout \
     | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl enc -base64
   ```

## Why not a reverse proxy or CDN

WebTransport runs over QUIC, which is UDP. An ordinary reverse proxy (nginx,
HAProxy, an ALB, most PaaS front ends) terminates TCP and will not forward it,
and a CDN in front of the site will serve the pages happily while the
WebTransport endpoint stays unreachable. The result is not an error: the client
falls back to plain HTTP and the site looks fine, just without HTTP4.

If something must sit in front, it has to pass UDP through to this host
(a UDP load balancer, or a plain IP/NAT forward), and the certificate must be
the one this server presents, because QUIC is terminated here.

## When UDP is blocked at the visitor's end

Some corporate and mobile networks drop UDP 443. Nothing needs to be done: the
client detects the failed session and serves everything over plain HTTP from
the same origin, and the per-request report says `fallback`. The demo shows this
deliberately with `?http4=off`.

## Known gaps

- **Compression.** HTTP4 sends raw bytes; there is no `content-encoding` in the
  wire format, so text assets are not compressed while the HTTP/3 baseline
  compresses them. Images and fonts are unaffected. Consider this before
  comparing byte counts on a text-heavy site.
- **Rate limiting.** There is none. Each session costs server memory, and
  nothing throttles how many a client may open.
- **One certificate.** The TCP and QUIC listeners share it, so both names must
  be in it if you serve more than one.
