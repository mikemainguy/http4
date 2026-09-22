// HTTP4 client session over WebTransport datagrams: sends REQs, reassembles
// DATA, issues GRANTs from the SRPT scheduler, and recovers lost datagrams.
//
// A transfer completes when it has both every body byte and the META packet
// carrying its response metadata (Content-Type etc.).
//
// Loss recovery: a transfer that has bytes outstanding, or no META yet, but
// hasn't made progress for one RTO is "stalled". If its size or its META is
// still missing (the REQ, META or packet 0 was lost), the REQ is sent again
// under the same rpc_id; the server answers with META and packet 0 again. Otherwise its current
// GRANT is re-sent (a GRANT may have been lost) along with a RESEND for each
// missing range below the grant. The timeout doubles on each attempt without
// progress, and the transfer fails after `maxRecoveries` attempts.
//
// The grant budget and each REQ's initial grant follow the measured
// bandwidth-delay product (budget.ts), so throughput isn't capped at a fixed
// budget ÷ RTT on long paths.

import { BudgetController } from "./budget.ts";
import { Reassembly } from "./reassembly.ts";
import { SrptScheduler, type GrantTrace } from "./scheduler.ts";
import { decode, encode, maxPayload, newRpcId, ErrorCode, MalformedPacketError, type Packet } from "./wire.ts";

export interface ClientOptions {
  /**
   * Fixed max bytes granted but not yet received, across all transfers.
   * Leave unset to size it from the measured bandwidth-delay product,
   * between `budgetFloor` and `budgetCap`.
   */
  budget?: number;
  /** Adaptive budget: never below this (default 128 KiB). */
  budgetFloor?: number;
  /** Adaptive budget: never above this (default 16 MiB). */
  budgetCap?: number;
  /** Adaptive budget: budget = k × BDP (default 2). */
  budgetK?: number;
  /** Smallest GRANT increment worth sending, unless it completes a transfer. */
  minIncrement?: number;
  /**
   * Fixed bytes each REQ lets the server send before any GRANT
   * (`initial_grant`). Leave unset for ~one BDP, between 4 KiB (a typical API
   * reply arrives in one round trip) and 64 KiB.
   */
  initialGrant?: number;
  /** Lower bound on the retransmission timeout. */
  rtoFloorMs?: number;
  /** Recovery attempts without progress before a transfer fails. */
  maxRecoveries?: number;
  /** Record every grant decision (for tests). */
  trace?: GrantTrace[];
  /** TESTING ONLY: return true to drop an outgoing packet, simulating loss. */
  dropOutgoing?: (p: Packet) => boolean;
}

export interface ClientStats {
  packetsIn: number;
  malformedIn: number;
  dataBytesIn: number;
  duplicateBytesIn: number;
  grantsSent: number;
  reqsSent: number;
  reqRetransmits: number;
  resendsSent: number;
  metaIn: number;
  recoveries: number;
  droppedOutgoing: number;
  srttMs: number | null;
  rtoMs: number;
  budget: number; // current grant budget in bytes
  bdpBytes: number; // estimated bandwidth-delay product (0 before an estimate)
  minRttMs: number | null;
}

export class Http4Error extends Error {
  override name = "Http4Error";
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

/** A completed HTTP4 request: the body and the server's META fields. */
export interface Http4Response {
  body: Uint8Array<ArrayBuffer>;
  headers: Record<string, string>; // lowercase names, e.g. "content-type"
}

/**
 * HTTP status to report for a failed HTTP4 request, e.g. when building a
 * platform Response:
 *
 *   NOT_FOUND   → 404
 *   BAD_REQUEST → 400
 *   UNKNOWN_RPC → 503  the server dropped the request's state (idle
 *                      eviction); retrying with a new REQ can succeed
 *   anything else, including stalls, session loss and unknown codes → 502
 */
export function httpStatusFor(err: unknown): number {
  if (err instanceof Http4Error) {
    switch (err.code) {
      case ErrorCode.NOT_FOUND:
        return 404;
      case ErrorCode.BAD_REQUEST:
        return 400;
      case ErrorCode.UNKNOWN_RPC:
        return 503;
    }
  }
  return 502;
}

interface Transfer {
  rpcId: bigint;
  assetId: string;
  initialGrant: number;
  asm?: Reassembly; // set once the first DATA reveals the size
  headers?: Record<string, string>; // set by the first META
  replied: boolean; // anything has arrived for it (RTT sample taken)
  resolve(r: Http4Response): void;
  reject(e: Error): void;
  reqSentAt: number;
  reqRetransmitted: boolean; // Karn: no RTT sample from an ambiguous REQ
  baseRto: number; // the RTO when the REQ went out; its timeouts back off from this
  ceiling: number; // highest grant sent so far (initial grant, then GRANTs)
  // An RTT probe for the budget's minRtt: the GRANT sent at `at` raised the
  // ceiling above `from`, so the first byte at or past `from` can only have
  // left the server after that GRANT arrived. The sample also includes
  // however much was already granted ahead of it (up to ~k × BDP when the
  // pipe is full), so it feeds only the min filter, never srtt/RTO. Cleared
  // once sampled, or when recovery re-sends a GRANT and the timing becomes
  // ambiguous.
  probe?: { from: number; at: number };
  lastProgress: number;
  recoveries: number; // consecutive attempts without progress
}

const DEFAULT_BUDGET_FLOOR = 128 * 1024;
// 16 MiB is about 17k datagrams in Chrome's incoming queue at the worst case of
// 1007-byte payloads; quic-go's congestion window tops out below that anyway.
const DEFAULT_BUDGET_CAP = 16 * 1024 * 1024;
const MIN_INITIAL_GRANT = 4096; // a 4 KiB API reply completes in one round trip
const MAX_INITIAL_GRANT = 64 * 1024; // bounds what a burst of REQs pre-authorizes
const DEFAULT_MIN_INCREMENT = 16 * 1024;
const DEFAULT_RTO_FLOOR_MS = 20;
// Before any RTT sample. It starts short so a lost first REQ on a fast path is
// retried quickly, and doubles after each timeout until a sample arrives
// (RFC 6298 §5.5), so on a slower path later REQs wait long enough to yield
// one. 1 s is RFC 6298's initial RTO.
const INITIAL_RTO_MS = 100;
const MAX_INITIAL_RTO_MS = 1000;
const DEFAULT_MAX_RECOVERIES = 10;
const MAX_RTO_MS = 2000;
const MAX_RESEND_RANGES = 16; // per recovery attempt

export class Http4Client {
  readonly maxDatagramSize: number;
  readonly stats: ClientStats;

  private readonly wt: WebTransport;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly transfers = new Map<bigint, Transfer>();
  private readonly scheduler: SrptScheduler;
  private readonly budget: BudgetController;
  private readonly fixedInitialGrant: number | undefined;
  private readonly rtoFloor: number;
  private readonly maxRecoveries: number;
  private readonly dropOutgoing: ((p: Packet) => boolean) | undefined;
  private srtt: number | null = null;
  private rttvar = 0;
  private initialRto = INITIAL_RTO_MS;
  private lastBackoffAt = -Infinity;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  private constructor(wt: WebTransport, opts: ClientOptions) {
    this.wt = wt;
    this.maxDatagramSize = wt.datagrams.maxDatagramSize;
    // A fixed budget is an adaptive one whose floor and cap are equal.
    this.budget = new BudgetController({
      floor: opts.budget ?? opts.budgetFloor ?? DEFAULT_BUDGET_FLOOR,
      cap: opts.budget ?? opts.budgetCap ?? DEFAULT_BUDGET_CAP,
      ...(opts.budgetK !== undefined ? { k: opts.budgetK } : {}),
    });
    this.writer = wt.datagrams.writable.getWriter();
    this.scheduler = new SrptScheduler({
      budget: this.budget.budget,
      minIncrement: opts.minIncrement ?? DEFAULT_MIN_INCREMENT,
      ...(opts.trace ? { trace: opts.trace } : {}),
    });
    this.syncQueueLimit();
    this.fixedInitialGrant = opts.initialGrant;
    this.rtoFloor = opts.rtoFloorMs ?? DEFAULT_RTO_FLOOR_MS;
    this.maxRecoveries = opts.maxRecoveries ?? DEFAULT_MAX_RECOVERIES;
    this.dropOutgoing = opts.dropOutgoing;
    this.stats = {
      packetsIn: 0, malformedIn: 0, dataBytesIn: 0, duplicateBytesIn: 0, grantsSent: 0, reqsSent: 0,
      reqRetransmits: 0, resendsSent: 0, metaIn: 0, recoveries: 0, droppedOutgoing: 0, srttMs: null, rtoMs: this.rto(),
      budget: this.budget.budget, bdpBytes: 0, minRttMs: null,
    };
    void this.readLoop();
    void wt.closed.finally(() => this.failAll(new Http4Error("session closed")));
  }

  static async connect(url: string, certHash?: Uint8Array<ArrayBuffer>, opts: ClientOptions = {}): Promise<Http4Client> {
    const wt = new WebTransport(url, certHash ? { serverCertificateHashes: [{ algorithm: "sha-256", value: certHash }] } : {});
    await wt.ready;
    return new Http4Client(wt, opts);
  }

  /** Fetch one asset by ID. Resolves with its bytes. */
  fetch(assetId: string): Promise<Uint8Array<ArrayBuffer>> {
    return this.request(assetId).then((r) => r.body);
  }

  /** Fetch one asset by ID. Resolves with its bytes and metadata. */
  request(assetId: string): Promise<Http4Response> {
    if (this.closed) return Promise.reject(new Http4Error("client closed"));
    const rpcId = newRpcId();
    const initialGrant = this.nextInitialGrant();
    const req: Packet = { type: "REQ", rpcId, initialGrant, assetId };
    const size = encode(req).length;
    if (size > this.maxDatagramSize) {
      return Promise.reject(new Http4Error(`asset ID too long: REQ is ${size} bytes, datagram limit ${this.maxDatagramSize}`));
    }
    return new Promise((resolve, reject) => {
      const now = performance.now();
      this.transfers.set(rpcId, {
        rpcId, assetId, initialGrant, replied: false, resolve, reject,
        reqSentAt: now, reqRetransmitted: false, baseRto: this.rto(), ceiling: initialGrant, lastProgress: now, recoveries: 0,
      });
      this.startTicker();
      this.stats.reqsSent++;
      this.send(req);
    });
  }

  close(): void {
    this.closed = true;
    this.wt.close();
  }

  /**
   * Retransmission timeout: RFC 6298 over REQ → first-reply samples, with a
   * floor. Before the first such sample: 3 × the budget's minRtt if GRANT
   * probes have measured one (they never underestimate the RTT), else the
   * initial RTO.
   */
  private rto(): number {
    if (this.srtt === null) {
      const minRtt = this.budget.minRttMs;
      return Math.max(this.rtoFloor, minRtt !== null ? Math.min(MAX_INITIAL_RTO_MS, 3 * minRtt) : this.initialRto);
    }
    return Math.min(MAX_RTO_MS, Math.max(this.rtoFloor, this.srtt + 4 * this.rttvar));
  }

  private sampleRtt(r: number): void {
    this.budget.onRttSample(r, performance.now());
    this.stats.minRttMs = this.budget.minRttMs;
    if (this.srtt === null) {
      this.srtt = r;
      this.rttvar = r / 2;
    } else {
      this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - r);
      this.srtt = 0.875 * this.srtt + 0.125 * r;
    }
    this.stats.srttMs = this.srtt;
    this.stats.rtoMs = this.rto();
  }

  private send(p: Packet): void {
    if (this.dropOutgoing?.(p)) {
      this.stats.droppedOutgoing++;
      return;
    }
    // Datagram writes resolve once queued; a failure means the session is gone,
    // which wt.closed reports.
    this.writer.write(encode(p)).catch(() => {});
  }

  private async readLoop(): Promise<void> {
    const reader = this.wt.datagrams.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        this.stats.packetsIn++;
        let p: Packet;
        try {
          p = decode(value as Uint8Array);
        } catch (e) {
          if (!(e instanceof MalformedPacketError)) throw e;
          this.stats.malformedIn++;
          continue;
        }
        this.handle(p);
        this.pumpGrants();
      }
    } catch (e) {
      this.failAll(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private handle(p: Packet): void {
    const t = this.transfers.get(p.rpcId);
    if (!t) return; // finished, failed, or not ours
    if (!t.replied && (p.type === "META" || p.type === "DATA")) {
      t.replied = true;
      if (!t.reqRetransmitted) this.sampleRtt(performance.now() - t.reqSentAt);
    }
    switch (p.type) {
      case "META": {
        this.stats.metaIn++;
        if (t.headers) return; // a repeat, after a retransmitted REQ
        t.headers = Object.fromEntries(p.fields);
        t.lastProgress = performance.now();
        t.recoveries = 0;
        if (t.asm?.complete) this.finish(t);
        return;
      }
      case "DATA": {
        if (!t.asm) {
          t.asm = new Reassembly(p.totalSize);
          this.scheduler.add(t.rpcId, p.totalSize, t.initialGrant, 0);
        } else if (p.totalSize !== t.asm.size) {
          return this.finish(t, new Http4Error(`total_size changed from ${t.asm.size} to ${p.totalSize}`));
        }
        let fresh: number;
        try {
          fresh = t.asm.add(p.offset, p.payload);
        } catch (e) {
          return this.finish(t, e as Error);
        }
        this.stats.dataBytesIn += p.payload.length;
        this.stats.duplicateBytesIn += p.payload.length - fresh;
        this.scheduler.onData(t.rpcId, fresh);
        if (t.probe && p.offset + p.payload.length > t.probe.from) {
          const now = performance.now();
          this.budget.onRttSample(now - t.probe.at, now);
          this.stats.minRttMs = this.budget.minRttMs;
          t.probe = undefined;
        }
        if (fresh > 0) {
          this.budget.onDelivered(fresh, performance.now());
          t.lastProgress = performance.now();
          t.recoveries = 0;
        }
        if (t.asm.complete && t.headers) this.finish(t);
        return;
      }
      case "ERROR": {
        const name = Object.entries(ErrorCode).find(([, c]) => c === p.code)?.[0] ?? `code ${p.code}`;
        return this.finish(t, new Http4Error(`${t.assetId}: ${name}`, p.code));
      }
      default:
        this.stats.malformedIn++; // REQ/GRANT/RESEND only flow client → server
    }
  }

  private pumpGrants(): void {
    this.scheduler.setBudget(this.budget.budget);
    this.syncQueueLimit();
    for (const g of this.scheduler.grants(this.reserved())) {
      this.stats.grantsSent++;
      const t = this.transfers.get(g.rpcId);
      if (t) {
        // Keep an older probe: it's still the GRANT that allowed its bytes.
        t.probe ??= { from: t.ceiling, at: performance.now() };
        t.ceiling = g.maxOffset;
      }
      this.send({ type: "GRANT", rpcId: g.rpcId, maxOffset: g.maxOffset, priority: g.priority });
    }
    if (this.scheduler.budgetLimited) this.budget.noteLimited();
    this.stats.budget = this.budget.budget;
    this.stats.bdpBytes = Math.round(this.budget.bdp);
  }

  /** Initial grants of transfers whose size isn't known yet: in flight, but not scheduled. */
  private reserved(): number {
    let n = 0;
    for (const t of this.transfers.values()) if (!t.asm) n += t.initialGrant;
    return n;
  }

  /**
   * initial_grant for a new REQ: about one BDP, between 4 KiB and 64 KiB. It
   * counts against the budget, so a burst of REQs doesn't pre-authorize much
   * more than the budget allows; each still gets at least 4 KiB.
   */
  private nextInitialGrant(): number {
    if (this.fixedInitialGrant !== undefined) return this.fixedInitialGrant;
    const want = Math.min(MAX_INITIAL_GRANT, Math.max(MIN_INITIAL_GRANT, Math.floor(this.budget.bdp)));
    const free = this.budget.budget - this.scheduler.outstanding() - this.reserved();
    return Math.max(MIN_INITIAL_GRANT, Math.min(want, free));
  }

  /**
   * Chrome drops incoming datagrams beyond this queue length, so leave room
   * for two budgets' worth arriving before the page reads any of it. Sized
   * for the smallest payload the server might use (Chrome's own datagram
   * limit), so it errs large.
   */
  private syncQueueLimit(): void {
    const want = 2 * Math.ceil(this.budget.budget / maxPayload(this.maxDatagramSize));
    if (want > this.wt.datagrams.incomingHighWaterMark) this.wt.datagrams.incomingHighWaterMark = want;
  }

  private startTicker(): void {
    this.ticker ??= setInterval(() => this.tick(), Math.max(5, this.rtoFloor / 2));
  }

  private tick(): void {
    const now = performance.now();
    for (const t of [...this.transfers.values()]) {
      const granted = t.asm ? (this.scheduler.granted(t.rpcId) ?? 0) : 0;
      const waiting = t.asm !== undefined && t.headers !== undefined && t.asm.received >= granted;
      if (waiting) {
        // Nothing outstanding: it's queued behind shorter transfers, not stalled.
        t.lastProgress = now;
        continue;
      }
      // Before an RTT sample, a transfer backs off from the RTO it started
      // with, so the initial-RTO backoff (below) only slows later REQs.
      const base = this.srtt === null ? Math.min(t.baseRto, this.rto()) : this.rto();
      const timeout = Math.min(MAX_RTO_MS, base * 2 ** t.recoveries);
      if (now - t.lastProgress >= timeout) this.recover(t, granted, now);
    }
    if (this.transfers.size === 0) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  private recover(t: Transfer, granted: number, now: number): void {
    if (++t.recoveries > this.maxRecoveries) {
      const got = t.asm ? `${t.asm.received}/${t.asm.size} bytes` : "no size yet";
      return this.finish(t, new Http4Error(`${t.assetId}: no progress after ${this.maxRecoveries} recovery attempts (${got})`));
    }
    this.stats.recoveries++;
    this.budget.onLoss(now);
    // A timeout before any RTT sample means the initial RTO may be shorter
    // than the path's RTT: back it off for later transfers too. Many
    // transfers timing out together count once.
    if (this.srtt === null && now - this.lastBackoffAt >= this.initialRto) {
      this.initialRto = Math.min(MAX_INITIAL_RTO_MS, this.initialRto * 2);
      this.lastBackoffAt = now;
    }
    // Recovery re-sends the GRANT, which makes the probe's timing ambiguous.
    t.probe = undefined;
    t.lastProgress = now; // the next attempt waits a (doubled) timeout from here
    if (!t.asm || !t.headers) {
      // No size or no META yet: the REQ or part of its reply was lost. A
      // repeated REQ makes the server send META and packet 0 again.
      t.reqRetransmitted = true;
      this.stats.reqRetransmits++;
      this.send({ type: "REQ", rpcId: t.rpcId, initialGrant: t.initialGrant, assetId: t.assetId });
      if (!t.asm) return;
    }
    // The server may never have seen our latest GRANT; grants are idempotent.
    if (granted > t.initialGrant) this.send({ type: "GRANT", rpcId: t.rpcId, maxOffset: granted, priority: 0 });
    for (const gap of t.asm.missing(granted).slice(0, MAX_RESEND_RANGES)) {
      this.stats.resendsSent++;
      this.send({ type: "RESEND", rpcId: t.rpcId, start: gap.start, end: gap.end });
    }
  }

  private finish(t: Transfer, err?: Error): void {
    this.transfers.delete(t.rpcId);
    this.scheduler.remove(t.rpcId);
    if (err) t.reject(err);
    else t.resolve({ body: t.asm!.bytes, headers: t.headers! });
    this.pumpGrants(); // its budget is free for the others
  }

  private failAll(err: Error): void {
    for (const t of [...this.transfers.values()]) this.finish(t, err);
    clearInterval(this.ticker);
    this.ticker = undefined;
  }
}
