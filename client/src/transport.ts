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
// Most loss is repaired well before that timer (vrek iss-e58kfkh). Like TCP's
// fast retransmit, a gap that later data has skipped by more than a few
// packets is a loss suspect; once it has stayed missing for a reordering
// window (RACK-style: a quarter of the min RTT, widened whenever a repair
// turns out to have been spurious) it is RESENT straight away. A RESENT range
// isn't requested again until the round trip plus the queue ahead of it has
// had time to deliver it (RepairTracker), and the budget backs off at most
// once per round trip however many gaps are found.
//
// The grant budget and each REQ's initial grant follow the measured
// bandwidth-delay product (budget.ts), so throughput isn't capped at a fixed
// budget ÷ RTT on long paths.
//
// Session sequence numbers (wire v2, vrek iss-fbzcsr1): the client offers
// them with HELLO. A server that supports them numbers every DATA across the
// session (DATA_SEQ), so a lost datagram shows as a missing number as soon as
// later ones arrive, whichever transfer they belong to. That includes a lost
// last packet, which per-transfer detection can only find by probing. The
// client names lost numbers in RESEND_SEQ, and the server resends what they
// carried. A server that doesn't know HELLO drops it as an unknown packet and
// keeps sending plain DATA, so everything above works as before.

import { BudgetController } from "./budget.ts";
import { Reassembly, RepairTracker, SeqTracker, type SeqHint } from "./reassembly.ts";
import { SrptScheduler, type GrantTrace } from "./scheduler.ts";
import { decode, encode, maxPayload, newRpcId, Capability, ErrorCode, MalformedPacketError, type Data, type Packet } from "./wire.ts";

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
  /**
   * RESEND a gap as soon as later data shows it's lost, instead of waiting
   * for the stall timer (default true). Off only to measure the difference.
   */
  earlyResend?: boolean;
  /** How many packets past a gap the frontier must be before it's a loss suspect (default 3). */
  reorderPackets?: number;
  /**
   * Offer session sequence numbers (wire v2) with HELLO (default true). A
   * server that doesn't support them ignores the offer. Off: plain v1.
   */
  sessionSeq?: boolean;
  /**
   * How many body bytes a streaming transfer may queue for a reader that
   * hasn't taken them yet (default 1 MiB). Past it the transfer stops being
   * granted until the reader catches up.
   */
  streamHighWaterMark?: number;
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
  resendsSent: number; // every RESEND packet, early or from the stall timer
  earlyResends: number; // RESENDs sent because later data showed a gap
  tailProbes: number; // RESENDs of a stalled tail's last packet, ahead of the stall timer
  spuriousRepairs: number; // times a repaired range arrived twice (the original was only late)
  reorderWindowMs: number; // how long a skipped-over gap may stay missing before it counts as lost
  hellosSent: number;
  seqNegotiated: boolean; // a DATA_SEQ has arrived: the server numbers this session's DATA
  dataSeqIn: number;
  seqLost: number; // sequence numbers declared lost
  seqResendsSent: number; // RESEND_SEQ packets
  metaIn: number;
  streamPauses: number; // times a slow reader stopped its transfer being granted
  recoveries: number;
  droppedOutgoing: number;
  srttMs: number | null;
  rtoMs: number;
  budget: number; // current grant budget in bytes
  bdpBytes: number; // estimated bandwidth-delay product (0 before an estimate)
  minRttMs: number | null;
  /**
   * The budget while grants were actually being issued, which is what limited
   * the transfer — `budget` alone is read after the fact and says nothing
   * about the ramp. A short transfer can spend all of itself climbing from
   * `budgetFloor`, granting in minIncrement-sized steps and leaving the sender
   * starved, then finish with a large budget it never got to use (vrek
   * iss-pjpnk4q).
   */
  budgetMin: number; // smallest budget seen while a grant was computed (0 = none yet)
  grantsAtFloor: number; // GRANTs issued while the budget was still at its floor
  /**
   * The settings actually in force, echoed back. Without this there is no way
   * to tell a tuning value that was applied from one that was ignored — a
   * typo, a stale cached page, or a config the client never read all look
   * identical in the other counters.
   */
  settings: { minIncrement: number; budgetFloor: number; budgetCap: number; budgetK: number; initialGrant: number | null };
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
 * A request whose body is still arriving: the META fields and total size are
 * known, and `body` yields the bytes in order as they arrive. The stream
 * errors if the transfer fails, so a truncated body never looks complete.
 */
export interface Http4Stream {
  body: ReadableStream<Uint8Array<ArrayBuffer>>;
  size: number;
  headers: Record<string, string>;
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

/** A streaming transfer's body, and what the reader has taken so far. */
interface StreamState {
  body: ReadableStream<Uint8Array<ArrayBuffer>>;
  controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
  emitted: number; // bytes already enqueued: always the gap-free prefix
  paused: boolean; // the reader is behind, so the transfer takes no new grants
  closed: boolean; // the stream has been closed or errored
}

interface Transfer {
  rpcId: bigint;
  assetId: string;
  initialGrant: number;
  asm?: Reassembly; // set once the first DATA reveals the size
  repair?: RepairTracker; // set with asm
  lastDetect: number; // when early loss detection last ran for it
  tailProbed: boolean; // a tail loss probe went out since the last progress
  headers?: Record<string, string>; // set by the first META
  replied: boolean; // anything has arrived for it (RTT sample taken)
  stream?: StreamState; // streaming mode: the caller gets the body as it arrives
  settled: boolean; // the caller's promise has been resolved or rejected
  resolve(r: Http4Response | Http4Stream): void;
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
// Mirrors budget.ts's DEFAULT_K, so the echoed settings say what is in force
// even when the caller passed nothing.
const DEFAULT_BUDGET_K = 2;
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
const DEFAULT_REORDER_PACKETS = 3; // TCP's duplicate-ACK threshold
const DEFAULT_PAYLOAD = 1183; // server DATA payload at a 1200-byte datagram, until one is seen
// The reordering window is a quarter of the min RTT (RACK), at least this
// long, and grows ×2 per spurious repair up to MAX_REORDER_STEPS quarters.
const MIN_REORDER_WINDOW_MS = 1;
const MAX_REORDER_STEPS = 16;
const DETECT_INTERVAL_MS = 1; // early detection runs at most this often per transfer on arrivals
const MIN_REPAIR_DELAY_MS = 2;
// quic-go queues at most this many datagrams before SendDatagram blocks
// (maxDatagramSendQueueLen), so a repair waits behind no more than that.
const SERVER_SEND_QUEUE_PACKETS = 32;
const MAX_DRAIN_MS = 10_000; // a stall timeout never waits longer than this for queued bytes
// HELLO goes out when the session opens and again with this many REQs, in
// case it was lost, until a DATA_SEQ shows the server took it up.
const HELLO_REPEATS = 3;
// A lost number's RESEND_SEQ goes out at most this many times (the first plus
// repeats a repair delay apart), since nothing shows that a RESEND_SEQ was lost.
const SEQ_RESEND_TRIES = 3;
// Body bytes a streaming transfer may hold for a reader that hasn't taken
// them. Roughly a BDP on a fast path, so a prompt reader never stalls.
const DEFAULT_STREAM_HIGH_WATER_MARK = 1024 * 1024;
// Bytes to gather before enqueueing, while the reader still has something to
// read. One chunk per datagram means thousands of tiny enqueues for a few MiB,
// which costs real throughput; a reader that has caught up is never made to
// wait for this, so it doesn't add latency.
const STREAM_CHUNK = 64 * 1024;

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
  private readonly earlyResend: boolean;
  private readonly reorderPackets: number;
  private readonly sessionSeq: boolean;
  private readonly streamHighWaterMark: number;
  private readonly seq = new SeqTracker();
  private lastSeqDetect = -Infinity;
  private payloadSeen = 0; // largest DATA payload so far: the server's packet size
  private reorderSteps = 1;
  private lastSpuriousAt = -Infinity;
  private lastLossBackoffAt = -Infinity;
  private srtt: number | null = null;
  private rttvar = 0;
  private initialRto = INITIAL_RTO_MS;
  private lastBackoffAt = -Infinity;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private sessionClosed = false;

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
    this.earlyResend = opts.earlyResend ?? true;
    this.reorderPackets = opts.reorderPackets ?? DEFAULT_REORDER_PACKETS;
    this.sessionSeq = opts.sessionSeq ?? true;
    this.streamHighWaterMark = opts.streamHighWaterMark ?? DEFAULT_STREAM_HIGH_WATER_MARK;
    this.stats = {
      packetsIn: 0, malformedIn: 0, dataBytesIn: 0, duplicateBytesIn: 0, grantsSent: 0, reqsSent: 0,
      reqRetransmits: 0, resendsSent: 0, earlyResends: 0, tailProbes: 0, spuriousRepairs: 0, reorderWindowMs: 0,
      hellosSent: 0, seqNegotiated: false, dataSeqIn: 0, seqLost: 0, seqResendsSent: 0,
      metaIn: 0, streamPauses: 0, recoveries: 0, droppedOutgoing: 0, srttMs: null, rtoMs: this.rto(),
      budget: this.budget.budget, bdpBytes: 0, minRttMs: null,
      budgetMin: 0, grantsAtFloor: 0,
      settings: {
        minIncrement: opts.minIncrement ?? DEFAULT_MIN_INCREMENT,
        budgetFloor: opts.budget ?? opts.budgetFloor ?? DEFAULT_BUDGET_FLOOR,
        budgetCap: opts.budget ?? opts.budgetCap ?? DEFAULT_BUDGET_CAP,
        budgetK: opts.budgetK ?? DEFAULT_BUDGET_K,
        initialGrant: opts.initialGrant ?? null,
      },
    };
    this.stats.reorderWindowMs = this.reorderWindow();
    this.sendHello();
    void this.readLoop();
    void wt.closed.finally(() => {
      this.sessionClosed = true;
      this.failAll(new Http4Error("session closed"));
    });
  }

  static async connect(url: string, certHash?: Uint8Array<ArrayBuffer>, opts: ClientOptions = {}): Promise<Http4Client> {
    // No hash (a CA-trusted certificate): let the browser verify it normally.
    const wt = new WebTransport(url, certHash?.length ? { serverCertificateHashes: [{ algorithm: "sha-256", value: certHash }] } : {});
    await wt.ready;
    return new Http4Client(wt, opts);
  }

  /** False once close() was called or the WebTransport session ended. */
  get isOpen(): boolean {
    return !this.closed && !this.sessionClosed;
  }

  /** Fetch one asset by ID. Resolves with its bytes. */
  fetch(assetId: string): Promise<Uint8Array<ArrayBuffer>> {
    return this.request(assetId).then((r) => r.body);
  }

  /** Fetch one asset by ID. Resolves with its bytes and metadata, once it is all there. */
  request(assetId: string): Promise<Http4Response> {
    return this.start(assetId, false) as Promise<Http4Response>;
  }

  /**
   * Fetch one asset by ID, resolving as soon as its metadata and size are
   * known, with the body as a stream that fills as bytes arrive. The browser
   * can then parse or compile while the transfer is still running.
   *
   * The stream yields the gap-free prefix, so a missing packet pauses it
   * until the repair lands, and a failed transfer errors it: what a reader
   * has consumed is always a correct prefix of the asset, and a truncated
   * body never ends cleanly. A reader that falls `streamHighWaterMark` bytes
   * behind stops the transfer being granted until it catches up.
   */
  requestStream(assetId: string): Promise<Http4Stream> {
    return this.start(assetId, true) as Promise<Http4Stream>;
  }

  private start(assetId: string, streaming: boolean): Promise<Http4Response | Http4Stream> {
    if (!this.isOpen) return Promise.reject(new Http4Error(this.closed ? "client closed" : "session closed"));
    const rpcId = newRpcId();
    const initialGrant = this.nextInitialGrant();
    const req: Packet = { type: "REQ", rpcId, initialGrant, assetId };
    const size = encode(req).length;
    if (size > this.maxDatagramSize) {
      return Promise.reject(new Http4Error(`asset ID too long: REQ is ${size} bytes, datagram limit ${this.maxDatagramSize}`));
    }
    return new Promise((resolve, reject) => {
      const now = performance.now();
      const t: Transfer = {
        rpcId, assetId, initialGrant, replied: false, settled: false, resolve, reject, lastDetect: -Infinity, tailProbed: false,
        reqSentAt: now, reqRetransmitted: false, baseRto: this.rto(), ceiling: initialGrant, lastProgress: now, recoveries: 0,
      };
      if (streaming) t.stream = this.makeStream(t);
      this.transfers.set(rpcId, t);
      this.startTicker();
      this.stats.reqsSent++;
      this.sendHello();
      this.send(req);
    });
  }

  /**
   * The body stream of a streaming transfer. Its queue is measured in bytes,
   * so backpressure is about how much the reader is behind, not how many
   * chunks: `pull` means the reader has taken some, so grants resume.
   */
  private makeStream(t: Transfer): StreamState {
    let st!: StreamState;
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>(
      {
        start: (controller) => {
          st = { body: undefined as unknown as ReadableStream<Uint8Array<ArrayBuffer>>, controller, emitted: 0, paused: false, closed: false };
        },
        pull: () => {
          if (st.paused) {
            st.paused = false;
            this.scheduler.setPaused(t.rpcId, false);
            this.pumpGrants();
          }
        },
        cancel: () => {
          // Nothing can un-cancel a reader, and the protocol has no cancel:
          // stop granting and let the server's idle eviction clear its state.
          st.closed = true;
          this.drop(t);
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark: this.streamHighWaterMark }),
    );
    st.body = body;
    return st;
  }

  /** Offer session sequence numbers, until the server has taken them up or we've asked enough. */
  private sendHello(): void {
    if (!this.sessionSeq || this.stats.seqNegotiated || this.stats.hellosSent > HELLO_REPEATS) return;
    this.stats.hellosSent++;
    this.send({ type: "HELLO", rpcId: 0n, caps: Capability.SESSION_SEQ });
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

  private handle(packet: Packet): void {
    let p = packet;
    if (p.type === "DATA_SEQ") {
      // Record the number before looking up the transfer: a datagram for a
      // finished transfer still used a number up, and must not look lost.
      const now = performance.now();
      this.stats.dataSeqIn++;
      this.stats.seqNegotiated = true;
      const where = { rpcId: p.rpcId, start: p.offset, end: p.offset + p.payload.length };
      if (this.seq.arrive(p.seq, now, where) === "spurious") this.noteSpurious(now);
      if (now - this.lastSeqDetect >= DETECT_INTERVAL_MS) this.detectSeqLoss(now);
      // From here on it is DATA.
      const data: Data = { type: "DATA", rpcId: p.rpcId, totalSize: p.totalSize, offset: p.offset, payload: p.payload };
      p = data;
    }
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
        this.maybeStart(t);
        if (t.asm?.complete) this.finish(t);
        return;
      }
      case "DATA": {
        if (!t.asm) {
          t.asm = new Reassembly(p.totalSize);
          t.repair = new RepairTracker();
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
        this.payloadSeen = Math.max(this.payloadSeen, p.payload.length);
        if (fresh < p.payload.length && t.repair!.requested) this.noteSpurious(performance.now());
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
          t.tailProbed = false;
        }
        this.maybeStart(t);
        this.flushStream(t);
        if (t.asm.complete && t.headers) return this.finish(t);
        const now = performance.now();
        if (now - t.lastDetect >= DETECT_INTERVAL_MS) this.detectLoss(t, now);
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
    const budget = this.budget.budget;
    // Sampled here, not after the fact: this is the budget the grants below
    // are computed from, which is the one that limited the transfer.
    this.stats.budgetMin = this.stats.budgetMin === 0 ? budget : Math.min(this.stats.budgetMin, budget);
    const atFloor = budget <= this.budget.floorBytes;
    this.scheduler.setBudget(budget);
    this.syncQueueLimit();
    for (const g of this.scheduler.grants(this.reserved())) {
      this.stats.grantsSent++;
      if (atFloor) this.stats.grantsAtFloor++;
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
    // A missing number's reordering window can end without another packet
    // arriving, so the tick runs session-wide detection too.
    if (this.stats.seqNegotiated) this.detectSeqLoss(now);
    for (const t of [...this.transfers.values()]) {
      // A suspect gap's reordering window can end without another packet
      // arriving for its transfer, so the tick runs detection too.
      if (t.asm) this.detectLoss(t, now);
      const granted = t.asm ? (this.scheduler.granted(t.rpcId) ?? 0) : 0;
      // Nothing outstanding: it's queued behind shorter transfers, not stalled.
      // A paused transfer is waiting on its own reader, which is not a stall
      // either, however long the reader takes.
      const waiting = (t.asm !== undefined && t.headers !== undefined && t.asm.received >= granted) || t.stream?.paused === true;
      if (waiting) {
        t.lastProgress = now;
        continue;
      }
      // Tail loss probe (RACK-TLP): if the tail stops arriving for about two
      // round trips plus the queue ahead, re-request its last packet once,
      // well before the stall timer. If that packet was lost too, its repair
      // moves the frontier to the end and early detection finds the rest.
      if (this.earlyResend && t.asm && t.repair && !t.tailProbed && this.srtt !== null) {
        const pto = Math.max(MIN_REPAIR_DELAY_MS, 2 * this.srtt) + this.drainMs();
        if (t.asm.frontier < granted && now - t.lastProgress >= pto) {
          t.tailProbed = true;
          const p = this.payloadSeen || DEFAULT_PAYLOAD;
          const last = { start: Math.max(t.asm.frontier, granted - p), end: granted };
          for (const gap of t.repair.claim(t.asm, [last], now, this.repairDelay())) {
            this.stats.resendsSent++;
            this.stats.tailProbes++;
            this.send({ type: "RESEND", rpcId: t.rpcId, start: gap.start, end: gap.end });
          }
        }
      }
      // Before an RTT sample, a transfer backs off from the RTO it started
      // with, so the initial-RTO backoff (below) only slows later REQs.
      const base = this.srtt === null ? Math.min(t.baseRto, this.rto()) : this.rto();
      // A big budget can hold more in flight than one RTO drains, so bytes
      // merely queued ahead aren't a stall until they've had time to arrive.
      const timeout = Math.max(Math.min(MAX_RTO_MS, base * 2 ** t.recoveries), this.drainMs());
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
    this.lossBackoff(now);
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
    // Real gaps (missing below data that has arrived) are RESENT whole. The
    // tail past the frontier may simply still be in flight, so rather than
    // re-requesting all of it, probe its first and last packet (RACK-TLP's
    // tail loss probe): if the last one was lost too, its repair moves the
    // frontier to the end and early detection finds the rest.
    const frontier = t.asm.frontier;
    const gaps = t.asm.missing(Math.min(frontier, granted)).slice(0, MAX_RESEND_RANGES);
    if (frontier < granted) {
      const p = this.payloadSeen || DEFAULT_PAYLOAD;
      const first = { start: frontier, end: Math.min(granted, frontier + p) };
      const last = { start: Math.max(first.end, granted - p), end: granted };
      gaps.push(first);
      if (last.start < last.end) gaps.push(last);
    }
    for (const gap of t.repair!.claim(t.asm, gaps, now, this.repairDelay())) {
      this.stats.resendsSent++;
      this.send({ type: "RESEND", rpcId: t.rpcId, start: gap.start, end: gap.end });
    }
  }

  /**
   * Early loss detection for one transfer: RESEND the gaps that data past
   * them (by more than `reorderPackets` packets) shows are lost, once they've
   * stayed missing for the reordering window.
   */
  private detectLoss(t: Transfer, now: number): void {
    t.lastDetect = now;
    if (!this.earlyResend || !t.asm || !t.repair) return;
    // With session sequence numbers every gap this could find is also a
    // missing number (data past it arrived, so later numbers did), and
    // detectSeqLoss repairs it by number. Running both re-requested bytes
    // whose repair was still queued behind in-flight data, so here the tail
    // probe and the stall timer are the only fallback.
    if (this.stats.seqNegotiated) return;
    // While more data is still expected past the frontier, a gap must be
    // skipped by a few packets before it's a suspect. Once the frontier has
    // reached the grant nothing later will arrive to show it, so only the
    // reordering window applies.
    const frontier = t.asm.frontier;
    const granted = this.scheduler.granted(t.rpcId) ?? t.asm.size;
    const limit = frontier < granted ? frontier - this.reorderPackets * (this.payloadSeen || DEFAULT_PAYLOAD) : frontier;
    if (limit <= 0) return;
    const lost = t.repair.detect(t.asm, limit, now, this.reorderWindow(), this.repairDelay());
    // No budget backoff here: an isolated loss is already handled by QUIC's
    // congestion control, and the delivery-rate estimate the budget follows
    // falls on its own if the path slows. Shrinking per loss as well pinned
    // the budget at its floor under steady random loss. Only a real stall
    // (the timer path) backs off.
    for (const gap of lost) {
      this.stats.resendsSent++;
      this.stats.earlyResends++;
      this.send({ type: "RESEND", rpcId: t.rpcId, start: gap.start, end: gap.end });
    }
  }

  /**
   * Session-wide early loss detection (wire v2): RESEND_SEQ every sequence
   * number that `reorderPackets` later numbers have passed and that stayed
   * missing for the reordering window. The server resends what it carried
   * under new numbers, so a lost repair is detected the same way. No budget
   * backoff, for the same reason as detectLoss.
   */
  private detectSeqLoss(now: number): void {
    this.lastSeqDetect = now;
    if (!this.earlyResend) return;
    // Near the end of a burst fewer than `reorderPackets` numbers may follow a
    // loss; then a round trip more of waiting stands in for them (RACK's time
    // threshold), well before a tail probe would.
    const window = this.reorderWindow();
    const tail = window + (this.srtt ?? this.budget.minRttMs ?? this.rto());
    for (const r of this.seq.detect(now, this.reorderPackets, window, tail)) {
      this.stats.seqLost += r.end - r.start;
      this.sendResendSeq(r);
      this.stats.earlyResends++;
    }
    // A RESEND_SEQ can be lost on the way up; ask again once a repair has had
    // two repair delays to arrive (one is often too soon: the repair queues
    // behind data already in flight). The server ignores repeats of a number
    // it already resent, and a number whose bytes have arrived isn't repeated.
    const again = 2 * this.repairDelay();
    for (const r of this.seq.repeats(now, again, SEQ_RESEND_TRIES, (h) => this.repaired(h))) this.sendResendSeq(r);
  }

  /** Whether the bytes a hint names have all arrived, or their transfer is over. */
  private repaired(h: SeqHint): boolean {
    const t = this.transfers.get(h.rpcId);
    if (!t?.asm) return !t; // finished (or failed): nothing left to repair
    return t.asm.missing(Math.min(h.end, t.asm.size)).every((g) => g.end <= h.start);
  }

  private sendResendSeq(r: { start: number; end: number }): void {
    this.stats.seqResendsSent++;
    this.stats.resendsSent++;
    this.send({ type: "RESEND_SEQ", rpcId: 0n, start: r.start, end: r.end });
  }

  /**
   * RACK's reordering window: a quarter of the min RTT, at least 1 ms, times
   * a step count that doubles on each spurious repair, never beyond one srtt.
   */
  private reorderWindow(): number {
    const rtt = this.budget.minRttMs ?? this.srtt;
    const quarter = Math.max(MIN_REORDER_WINDOW_MS, (rtt ?? 0) / 4);
    return Math.min(quarter * this.reorderSteps, Math.max(quarter, this.srtt ?? quarter));
  }

  /**
   * How long a RESENT range gets before it may be requested again: 1.5 round
   * trips plus the time to drain the server's datagram send queue at the
   * measured delivery rate. The server sends repairs ahead of new data, so
   * only what's already queued there is ahead of one, not the whole budget.
   * Without a rate yet, the RTO.
   */
  private repairDelay(): number {
    const rtt = this.srtt ?? this.budget.minRttMs ?? this.rto();
    const rate = this.budget.maxRate; // bytes per ms
    const queued = SERVER_SEND_QUEUE_PACKETS * (this.payloadSeen || DEFAULT_PAYLOAD);
    const drain = rate > 0 ? queued / rate : this.rto();
    return Math.min(MAX_RTO_MS, Math.max(MIN_REPAIR_DELAY_MS, 1.5 * rtt + drain));
  }

  /**
   * How long everything granted but not yet received needs to arrive at the
   * measured delivery rate (0 before there's a rate), capped so a genuine
   * stall is still noticed.
   */
  private drainMs(): number {
    const rate = this.budget.maxRate;
    return rate > 0 ? Math.min(MAX_DRAIN_MS, this.scheduler.outstanding() / rate) : 0;
  }

  /**
   * A repaired range arrived twice: the original was only late. Widen the
   * reordering window, at most once per round trip.
   */
  private noteSpurious(now: number): void {
    this.stats.spuriousRepairs++;
    if (now - this.lastSpuriousAt < (this.srtt ?? MIN_REORDER_WINDOW_MS)) return;
    this.lastSpuriousAt = now;
    this.reorderSteps = Math.min(MAX_REORDER_STEPS, this.reorderSteps * 2);
    this.stats.reorderWindowMs = this.reorderWindow();
  }

  /**
   * Shrink the budget for a loss, but only once per round trip, as TCP
   * reduces once per window: a burst of gaps found together is one event.
   */
  private lossBackoff(now: number): void {
    if (now - this.lastLossBackoffAt < Math.max(MIN_REORDER_WINDOW_MS, this.srtt ?? this.budget.minRttMs ?? 0)) return;
    this.lastLossBackoffAt = now;
    this.budget.onLoss(now);
    this.stats.reorderWindowMs = this.reorderWindow();
  }

  /**
   * Hand a streaming caller its body as soon as the size (first DATA) and the
   * META fields are both known. The bytes keep arriving into the same stream.
   */
  private maybeStart(t: Transfer): void {
    const st = t.stream;
    if (!st || t.settled || !t.asm || !t.headers) return;
    t.settled = true;
    t.resolve({ body: st.body, size: t.asm.size, headers: t.headers });
  }

  /**
   * Enqueue the bytes that have become contiguous since the last flush, and
   * pause the transfer if that puts the reader too far behind. The chunk is a
   * view on the reassembly buffer: those bytes are already final, and a
   * duplicate packet only ever rewrites them with the same content.
   */
  private flushStream(t: Transfer): void {
    const st = t.stream;
    if (!st || st.closed || !t.asm) return;
    const to = t.asm.contiguous;
    const pending = to - st.emitted;
    // Hand the first bytes over the moment they exist, so the consumer can
    // start; after that coalesce, because a chunk per packet costs far more in
    // queue and Service Worker overhead than it saves in latency. Anything
    // left under a chunk is flushed when the transfer completes or fails.
    if (pending > 0 && (st.emitted === 0 || pending >= STREAM_CHUNK || t.asm.complete)) {
      const chunk = t.asm.bytes.subarray(st.emitted, to) as Uint8Array<ArrayBuffer>;
      st.emitted = to;
      st.controller.enqueue(chunk);
    }
    const behind = (st.controller.desiredSize ?? 0) <= 0;
    if (behind && !st.paused) {
      st.paused = true;
      this.stats.streamPauses++;
      this.scheduler.setPaused(t.rpcId, true);
    }
  }

  /** Forget a transfer without settling it: its reader cancelled the stream. */
  private drop(t: Transfer): void {
    this.transfers.delete(t.rpcId);
    this.scheduler.remove(t.rpcId);
    this.pumpGrants();
  }

  private finish(t: Transfer, err?: Error): void {
    this.transfers.delete(t.rpcId);
    this.scheduler.remove(t.rpcId);
    const st = t.stream;
    if (st) {
      if (!err) this.flushStream(t);
      if (!st.closed) {
        st.closed = true;
        // A failed transfer errors the stream, so a truncated body can never
        // be mistaken for a complete one. A caller that hasn't been answered
        // yet (no META, or no size) gets the failure as a rejection instead,
        // and never sees the stream.
        if (err) st.controller.error(err);
        else st.controller.close();
      }
    }
    if (!t.settled) {
      t.settled = true;
      if (err) t.reject(err);
      else if (st) t.resolve({ body: st.body, size: t.asm!.size, headers: t.headers! });
      else t.resolve({ body: t.asm!.bytes, headers: t.headers! });
    }
    this.pumpGrants(); // its budget is free for the others
  }

  private failAll(err: Error): void {
    for (const t of [...this.transfers.values()]) this.finish(t, err);
    clearInterval(this.ticker);
    this.ticker = undefined;
  }
}
