// Sandbox page: checks connectivity with a datagram echo, then opens an HTTP4
// session. Both are published on window (__echo, __http4) so headless tests
// can drive and inspect them.

import { Http4Client, type ClientOptions, type ClientStats } from "./transport.ts";
import type { GrantTrace } from "./scheduler.ts";

interface ClientConfig {
  webTransportUrl: string; // HTTP4
  echoUrl: string; // datagram echo, a connectivity check
  certHash: string; // base64 SHA-256 of the server certificate DER
}

export type EchoResult =
  | { ok: true; attempts: number; rttMs: number; maxDatagramSize: number }
  | { ok: false; error: string };

export interface Http4Handle {
  client: Http4Client;
  trace: GrantTrace[];
  stats(): ClientStats;
  /** Open another session with its own options (tests use it to inject loss). */
  connect(opts: ClientOptions): Promise<Http4Client>;
}

declare global {
  interface Window {
    __echo?: EchoResult;
    __http4?: Http4Handle | { error: string };
  }
}

const ATTEMPTS = 25;
const ATTEMPT_TIMEOUT_MS = 200;

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function loadConfig(): Promise<ClientConfig> {
  const res = await fetch("/config.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`GET /config.json: ${res.status}`);
  return (await res.json()) as ClientConfig;
}

// Datagrams are unreliable, so send until one comes back or we run out of attempts.
async function echoOnce(wt: WebTransport): Promise<EchoResult> {
  const writer = wt.datagrams.writable.getWriter();
  const reader = wt.datagrams.readable.getReader();
  const ping = new TextEncoder().encode("ping");
  const start = performance.now();
  // A read can't be cancelled without releasing the reader, so one pending
  // read carries across attempts.
  const pending = reader.read();
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    await writer.write(ping);
    const got = await Promise.race([
      pending,
      new Promise<null>((r) => setTimeout(() => r(null), ATTEMPT_TIMEOUT_MS)),
    ]);
    if (got === null) continue;
    if (got.done) return { ok: false, error: "datagram stream closed" };
    const text = new TextDecoder().decode(got.value);
    if (text !== "ping") return { ok: false, error: `echo was ${JSON.stringify(text)}` };
    return {
      ok: true,
      attempts: attempt,
      rttMs: Math.round(performance.now() - start),
      maxDatagramSize: wt.datagrams.maxDatagramSize,
    };
  }
  return { ok: false, error: `no echo after ${ATTEMPTS} attempts` };
}

async function runEcho(cfg: ClientConfig, hash: Uint8Array<ArrayBuffer>): Promise<EchoResult> {
  try {
    const wt = new WebTransport(cfg.echoUrl, { serverCertificateHashes: [{ algorithm: "sha-256", value: hash }] });
    await wt.ready;
    const result = await echoOnce(wt);
    wt.close();
    return result;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  const status = document.getElementById("status")!;
  let cfg: ClientConfig;
  try {
    cfg = await loadConfig();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    window.__echo = { ok: false, error };
    window.__http4 = { error };
    status.textContent = error;
    return;
  }
  const hash = base64ToBytes(cfg.certHash);

  const echo = await runEcho(cfg, hash);
  window.__echo = echo;
  status.textContent = echo.ok
    ? `echo ok in ${echo.rttMs} ms (${echo.attempts} attempt(s)), maxDatagramSize ${echo.maxDatagramSize}`
    : `echo failed: ${echo.error}`;
  status.dataset.ok = String(echo.ok);

  try {
    const trace: GrantTrace[] = [];
    const client = await Http4Client.connect(cfg.webTransportUrl, hash, { trace });
    window.__http4 = {
      client,
      trace,
      stats: () => ({ ...client.stats }),
      connect: (opts) => Http4Client.connect(cfg.webTransportUrl, hash, opts),
    };
    status.textContent += " · HTTP4 session open";
  } catch (err) {
    window.__http4 = { error: err instanceof Error ? err.message : String(err) };
  }
}

void main();
