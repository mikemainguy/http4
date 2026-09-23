// Grant budget sized from the measured bandwidth-delay product (vrek
// iss-66pc8rp). Pure logic with the clock passed in, so it can be tested in
// Node against a simulated link.
//
// The budget caps bytes granted but not yet received across all transfers. A
// fixed budget B caps throughput at B / RTT, so at 50 ms a 128 KiB budget
// can't exceed ~2.6 MB/s however fast the path is. Like Homa's RTTbytes and
// BBR's BDP estimate, the controller keeps
//
//   budget = clamp(k × maxRate × minRtt, floor, cap)
//
// maxRate is a windowed max of delivery-rate samples, one per ~minRtt interval
// of receiving data. minRtt is the smallest RTT sample seen in the last
// MIN_RTT_WINDOW_MS; the min is used rather than srtt because queueing (in
// QUIC's send queue, or a rate-limited path) inflates srtt exactly when the
// pipe is full, and a budget sized from inflated RTTs would only add more
// queueing.
//
// Growth needs no separate slow-start rule: while the budget limits delivery,
// each interval delivers about budget / RTT, so the next BDP estimate is about
// the budget itself and k = 2 doubles it per round trip. Once the path (in
// practice QUIC's congestion window) stops delivering faster, maxRate levels
// off and the budget settles at k × BDP, enough to keep the pipe full while
// grants are in flight. QUIC still does the congestion control; this only
// keeps enough granted that it's never starved.
//
// Samples from intervals where the budget wasn't the limit (the app had
// nothing more to fetch) only count if they raise the max, so a quiet period
// doesn't shrink the estimate. The window counts delivery rounds, not wall
// time, so the estimate survives idle gaps between requests.

export interface BudgetOptions {
  floor: number; // never below this: keeps small-RTT paths as fast as a fixed budget
  cap: number; // never above this: bounds the browser's datagram queue and memory
  k?: number; // budget = k × BDP (default 2)
  lossFactor?: number; // multiply the budget by this on a loss recovery (default 0.85)
}

const DEFAULT_K = 2;
const DEFAULT_LOSS_FACTOR = 0.85;
const RATE_WINDOW_ROUNDS = 10; // BBR's max-bandwidth window
const MIN_RTT_WINDOW_MS = 10_000; // BBR's min-RTT window
const MIN_INTERVAL_MS = 4; // below this, timer and event-loop jitter dominate a sample

interface RateSample {
  round: number;
  rate: number; // bytes per ms
}

export class BudgetController {
  private readonly floor: number;
  private readonly cap: number;
  private readonly k: number;
  private readonly lossFactor: number;

  private minRtt: number | null = null;
  private minRttAt = 0;
  private samples: RateSample[] = [];
  private round = 0;
  private intervalStart: number | null = null;
  private intervalBytes = 0;
  private intervalLimited = false;
  private holdUntil = 0; // no growth before this, after a loss
  private current: number;

  constructor(opts: BudgetOptions) {
    this.floor = opts.floor;
    this.cap = Math.max(opts.floor, opts.cap);
    this.k = opts.k ?? DEFAULT_K;
    this.lossFactor = opts.lossFactor ?? DEFAULT_LOSS_FACTOR;
    this.current = this.floor;
  }

  /** The budget to use now. */
  /** The configured lower bound, so callers can tell a ramping budget from a settled one. */
  get floorBytes(): number {
    return this.floor;
  }

  get budget(): number {
    return this.current;
  }

  /** Smallest recent RTT sample in ms, or null before the first. */
  get minRttMs(): number | null {
    return this.minRtt;
  }

  /** Windowed max delivery rate in bytes per ms (0 before the first sample). */
  get maxRate(): number {
    let m = 0;
    for (const s of this.samples) m = Math.max(m, s.rate);
    return m;
  }

  /** Estimated bandwidth-delay product in bytes, or 0 before there is one. */
  get bdp(): number {
    return this.minRtt === null ? 0 : this.maxRate * this.minRtt;
  }

  onRttSample(rttMs: number, now: number): void {
    if (this.minRtt === null || rttMs <= this.minRtt || now - this.minRttAt > MIN_RTT_WINDOW_MS) {
      this.minRtt = rttMs;
      this.minRttAt = now;
    }
  }

  /** The budget was the limit: some transfer wanted a grant and there was no room. */
  noteLimited(): void {
    this.intervalLimited = true;
  }

  /** `bytes` new body bytes arrived at `now`. */
  onDelivered(bytes: number, now: number): void {
    if (this.intervalStart === null) {
      // The first delivery opens an interval; its bytes left before it began.
      this.intervalStart = now;
      return;
    }
    this.intervalBytes += bytes;
    const elapsed = now - this.intervalStart;
    if (elapsed < Math.max(MIN_INTERVAL_MS, this.minRtt ?? 0)) return;

    const rate = this.intervalBytes / elapsed;
    this.round++;
    this.samples = this.samples.filter((s) => this.round - s.round < RATE_WINDOW_ROUNDS);
    if (this.intervalLimited || rate > this.maxRate) this.samples.push({ round: this.round, rate });
    this.intervalStart = now;
    this.intervalBytes = 0;
    this.intervalLimited = false;
    this.update(now);
  }

  /** Loss recovery ran: shrink a little and don't grow for one round trip. */
  onLoss(now: number): void {
    this.current = Math.max(this.floor, Math.floor(this.current * this.lossFactor));
    this.holdUntil = now + (this.minRtt ?? 0);
  }

  private update(now: number): void {
    const target = Math.min(this.cap, Math.max(this.floor, Math.floor(this.k * this.bdp)));
    this.current = now < this.holdUntil ? Math.min(this.current, target) : target;
  }
}
