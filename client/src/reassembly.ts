// Rebuilds one asset from DATA payloads that may arrive out of order or more
// than once, and tracks exactly which bytes have arrived.

export interface Range {
  start: number;
  end: number; // exclusive
}

export class Reassembly {
  readonly size: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
  // Disjoint, sorted, non-adjacent ranges that have arrived.
  private ranges: Range[] = [];
  private _received = 0;

  constructor(size: number) {
    this.size = size;
    this.bytes = new Uint8Array(size);
  }

  /** Unique bytes received so far. */
  get received(): number {
    return this._received;
  }

  get complete(): boolean {
    return this._received === this.size;
  }

  /** End of the gap-free prefix: every byte in [0, contiguous) has arrived. */
  get contiguous(): number {
    const first = this.ranges[0];
    return first && first.start === 0 ? first.end : 0;
  }

  /**
   * Store a payload at `offset` and return how many of its bytes were new.
   * Throws if it doesn't fit inside the asset.
   */
  add(offset: number, payload: Uint8Array): number {
    const end = offset + payload.length;
    if (offset < 0 || end > this.size) throw new RangeError(`[${offset}, ${end}) outside asset of ${this.size} bytes`);
    if (payload.length === 0) return 0;
    this.bytes.set(payload, offset);

    // Merge [offset, end) into the range list and count how much was new.
    let covered = 0;
    let start = offset;
    let stop = end;
    let i = 0;
    while (i < this.ranges.length && this.ranges[i]!.end < offset) i++;
    let j = i;
    while (j < this.ranges.length && this.ranges[j]!.start <= end) {
      const r = this.ranges[j]!;
      covered += Math.max(0, Math.min(r.end, end) - Math.max(r.start, offset));
      start = Math.min(start, r.start);
      stop = Math.max(stop, r.end);
      j++;
    }
    this.ranges.splice(i, j - i, { start, end: stop });
    const fresh = payload.length - covered;
    this._received += fresh;
    return fresh;
  }

  /** Gaps below `limit` (e.g. the grant): what should have arrived and hasn't. */
  missing(limit: number = this.size): Range[] {
    const gaps: Range[] = [];
    let at = 0;
    for (const r of this.ranges) {
      if (at >= limit) break;
      if (r.start > at) gaps.push({ start: at, end: Math.min(r.start, limit) });
      at = r.end;
    }
    if (at < limit) gaps.push({ start: at, end: limit });
    return gaps;
  }
}
