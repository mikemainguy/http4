// Scaffold client: connect to the sandbox server over WebTransport and bounce
// one datagram off it. The result is rendered and also published on
// window.__echo so the headless acceptance test can read it.

interface ClientConfig {
  webTransportUrl: string;
  certHash: string; // base64 SHA-256 of the server certificate DER
}

export type EchoResult =
  | { ok: true; attempts: number; rttMs: number; maxDatagramSize: number }
  | { ok: false; error: string };

declare global {
  interface Window {
    __echo?: EchoResult;
  }
}

const ATTEMPTS = 25;
const ATTEMPT_TIMEOUT_MS = 200;

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function connect(): Promise<WebTransport> {
  const res = await fetch("/config.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`GET /config.json: ${res.status}`);
  const cfg = (await res.json()) as ClientConfig;
  const wt = new WebTransport(cfg.webTransportUrl, {
    serverCertificateHashes: [{ algorithm: "sha-256", value: base64ToBytes(cfg.certHash) }],
  });
  await wt.ready;
  return wt;
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

async function main(): Promise<void> {
  const status = document.getElementById("status")!;
  let result: EchoResult;
  try {
    const wt = await connect();
    result = await echoOnce(wt);
    wt.close();
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  window.__echo = result;
  status.textContent = result.ok
    ? `echo ok in ${result.rttMs} ms (${result.attempts} attempt(s)), maxDatagramSize ${result.maxDatagramSize}`
    : `echo failed: ${result.error}`;
  status.dataset.ok = String(result.ok);
}

void main();
