// The deployment path (vrek iss-fzz5beq): `http4d serve -cert file:...`. The
// page is HTTPS, a secure context, the Service Worker installs, and
// /config.json advertises no certHash, so the client opens the session without
// serverCertificateHashes and lets the browser validate the certificate.
//
// The certificate here is self-signed. Chrome refuses WebTransport to a
// certificate it does not genuinely trust — --ignore-certificate-errors and
// --ignore-certificate-errors-spki-list do not change that, unlike for h3
// fetches — so a real CA is the only way to complete a session in a browser.
// That leg is covered by the Go test TestWebTransportWithoutPinning, which
// verifies the chain properly. What this test proves is the rest, including
// what a visitor gets when the session cannot open: the library falls back and
// the site still works.
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { insecureGet, startHarness, type Harness } from "../support/harness.ts";

const site = path.join(import.meta.dirname, "..", "servesw", "site");
const SUBRESOURCES = ["/style.css", "/img/pic.png", "/app.js", "/data.json"];
let dir: string;
let h: Harness;
let redirectPort: number;

/** A certificate for localhost, and the SPKI hash that lets Chrome load the page. */
function makeCert(dir: string): { certFile: string; keyFile: string; spki: string } {
  const certFile = path.join(dir, "cert.pem");
  const keyFile = path.join(dir, "key.pem");
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
      "-keyout", keyFile, "-out", certFile, "-days", "1", "-nodes",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  // The same recipe deploy/README.md gives for checking a deployed certificate.
  const spki = execFileSync(
    "sh",
    ["-c", `openssl x509 -in '${certFile}' -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl enc -base64`],
    { encoding: "utf8" },
  ).trim();
  return { certFile, keyFile, spki };
}

async function freeTcpPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as { port: number };
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "http4-tls-"));
  const { certFile, keyFile, spki } = makeCert(dir);
  redirectPort = await freeTcpPort();
  h = await startHarness(site, ["-cert", `file:${certFile},${keyFile}`, "-redirect", `127.0.0.1:${redirectPort}`], {
    serve: true,
    https: true,
    chromeArgs: [`--ignore-certificate-errors-spki-list=${spki}`],
  });
});

after(async () => {
  await h?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("the site is HTTPS, a secure context, and advertises no certificate hash", async () => {
  assert.ok(h.http.startsWith("https://"), `page origin ${h.http}`);
  assert.ok(h.webtransport.startsWith("https://"), `webtransport ${h.webtransport}`);

  const ctx = await h.browser.newContext();
  const page = await ctx.newPage();
  await page.goto(h.http + "/");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 15_000 });
  await page.reload();
  await page.waitForFunction(
    () => (window as any).__data && (document.getElementById("pic") as HTMLImageElement).complete,
    undefined,
    { timeout: 15_000 },
  );

  const seen = await page.evaluate(async () => {
    const cfg = (await (await fetch("/config.json", { cache: "no-store" })).json()) as Record<string, unknown>;
    return {
      origin: location.origin,
      secure: window.isSecureContext,
      hasCertHash: "certHash" in cfg,
      webTransportUrl: cfg.webTransportUrl as string,
      assetPrefix: cfg.assetPrefix as string,
      controlled: navigator.serviceWorker.controller !== null,
      bg: getComputedStyle(document.body).backgroundColor,
      img: (document.getElementById("pic") as HTMLImageElement).naturalWidth,
      data: (window as any).__data,
      report: ((await window.http4!.report()) as any[]).map((r) => ({ path: new URL(r.url).pathname, transport: r.transport, reason: r.reason as string | undefined })),
    };
  });

  assert.ok(seen.origin.startsWith("https://"), `page origin ${seen.origin}`);
  assert.ok(seen.secure, "an https page is a secure context, which the Service Worker needs");
  assert.equal(seen.hasCertHash, false, "a CA-validated certificate must not be pinned in config.json");
  assert.ok(seen.webTransportUrl.startsWith("https://"), seen.webTransportUrl);
  assert.equal(seen.assetPrefix, "/");
  assert.ok(seen.controlled, "the Service Worker controls the page");

  // The site renders whether or not the session opened: over HTTP4 with a real
  // certificate, over the network here.
  assert.equal(seen.bg, "rgb(7, 8, 9)", "stylesheet applied");
  assert.ok(seen.img > 0, "image decoded");
  assert.deepEqual(seen.data, { ok: true }, "JSON fetched");
  for (const p of SUBRESOURCES) {
    const r = seen.report.find((x) => x.path === p);
    assert.ok(r, `${p} missing from the report`);
    assert.ok(["http4", "fallback"].includes(r.transport), `${p}: ${JSON.stringify(r)}`);
  }
  const fellBack = seen.report.filter((r) => r.transport === "fallback");
  console.log(
    `https page ${seen.origin}, session ${seen.webTransportUrl}, certHash absent; ` +
      (fellBack.length
        ? `session refused by Chrome for this self-signed certificate (${fellBack[0]!.reason}), ${fellBack.length} assets over the network`
        : `${seen.report.filter((r) => r.transport === "http4").length} assets over HTTP4`),
  );
  await ctx.close();
});

test("the plain-HTTP listener only redirects to HTTPS", async () => {
  const res = await fetch(`http://127.0.0.1:${redirectPort}/style.css?x=1`, { redirect: "manual" });
  assert.equal(res.status, 301);
  const location = res.headers.get("location") ?? "";
  assert.ok(location.startsWith("https://"), `Location ${location}`);
  assert.ok(location.endsWith("/style.css?x=1"), `Location ${location}`);
  // It serves nothing itself, so a stray plain-HTTP fetch can't bypass TLS.
  assert.equal((await res.text()).includes("rgb(7, 8, 9)"), false);
});

test("metrics answer on loopback and report zero un-granted bytes", async () => {
  const m = await h.metrics();
  assert.equal(m.ungranted_bytes_sent, 0);
  const body = await insecureGet(h.http + "/metrics.json");
  assert.ok(body.includes("ungranted_bytes_sent"));
  // Refusing a non-loopback client is the same handler with a different
  // RemoteAddr, covered by TestMetricsAccess in Go.
});
