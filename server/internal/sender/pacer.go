package sender

import "time"

// quicSendQueue mirrors quic-go's unexported maxDatagramSendQueueLen: how many
// datagrams it buffers before SendDatagram blocks.
const quicSendQueue = 32

const (
	// DefaultSendQueueTarget is how many datagrams the sender is willing to
	// leave sitting in that queue ahead of the one it picks next.
	DefaultSendQueueTarget = 4
	// pacerMinInterval is the departure interval below which pacing is not
	// worth it: a full queue then drains in under ~8 ms, less than the timer
	// granularity pacing would spend on it.
	pacerMinInterval = 250 * time.Microsecond
	// pacerBlocked is how slow a SendDatagram has to be to mean "the queue was
	// full". An enqueue that finds room takes microseconds.
	pacerBlocked = 250 * time.Microsecond
	// A departure-rate sample spans at least pacerSample and pacerMinSends, so
	// it averages over several congestion bursts. Measured burst by burst the
	// rate is wildly wrong: on a 1% / 50 ms path quic-go pops a window's worth
	// of datagrams in a few hundred microseconds and then waits an RTT, so
	// consecutive blocked sends are ~250 µs apart on a wire carrying one
	// datagram every ~7 ms (vrek iss-dy53a59).
	pacerSample   = 200 * time.Millisecond
	pacerMinSends = 16
	// When the queue looks empty the pacer, not the wire, is the bottleneck, so
	// the estimate is nudged faster by pacerProbeNum / pacerProbeDen, at most
	// once per pacerProbeEvery. Tying it to an empty queue is what keeps it
	// from inflating a queue that is already the right depth.
	pacerProbeEvery = 200 * time.Millisecond
	pacerProbeNum   = 99
	pacerProbeDen   = 100
)

// pacer keeps quic-go's datagram send queue shallow, so a packet the send loop
// picks now is not stuck behind bulk datagrams queued earlier (vrek
// iss-dy53a59, fnd-pp7zab7).
//
// quic-go buffers up to 32 datagrams and SendDatagram only blocks once that
// queue is full, so a sender with bulk always ready keeps it full. The queue is
// FIFO, so SRPT at pick time decides the order *into* the queue, not the order
// onto the wire: on a slow path those 32 datagrams are ~125 ms of head-of-line
// delay for a small reply granted now.
//
// Nothing reports "this datagram left", so the depth is inferred:
//   - A send that blocks waited for a datagram to leave, so at that instant the
//     queue is full: the depth is known exactly, and it is 32.
//   - Between two blocked sends the depth therefore starts and ends at 32, so
//     however bursty the wire was in between, exactly as many datagrams left as
//     were handed over. Counting sends between two blocks, over a span long
//     enough to cover several bursts, measures the departure rate.
//   - Between departures the depth is dead-reckoned from that rate.
//
// The estimate is self-correcting in both directions. Too fast fills the queue,
// which blocks, which re-measures the rate and re-syncs the depth. Too slow
// empties the queue, which is the only case where pacing costs throughput, and
// that is exactly when probing nudges it faster.
//
// Pure logic with the clock passed in, so it can be tested without a network.
type pacer struct {
	target   int           // datagrams allowed to sit in the queue
	interval time.Duration // estimated time between departures; 0 until measured
	depth    float64       // estimated datagrams queued
	at       time.Time     // when depth was last brought up to date

	since   time.Time // the blocked send the current sample counts from
	sends   int       // datagrams handed over since then, which is how many left
	probeAt time.Time // when the interval was last nudged
}

// wait reports how long to hold off before handing quic-go another datagram.
// The send loop waits *before* picking, so the wait ends with a fresh choice:
// a packet that becomes due while waiting goes out first.
func (p *pacer) wait(now time.Time) time.Duration {
	if p.target < 0 {
		return 0 // pacing off: the queue runs as deep as QUIC allows
	}
	if p.interval < pacerMinInterval {
		return 0 // the queue drains faster than pacing could usefully hold it
	}
	p.advance(now)
	over := p.depth - float64(p.target)
	if over < 0 {
		return 0
	}
	// Hold off for the departures that bring the queue back under target.
	return time.Duration((over + 1) * float64(p.interval))
}

// sent records one datagram handed to quic-go, and whether that blocked.
func (p *pacer) sent(now time.Time, blocked bool) {
	p.advance(now)
	p.depth++
	p.sends++
	if !blocked {
		p.probe(now)
		return
	}
	// It blocked, so the queue was full and one datagram left to make room:
	// the depth is exactly the queue length again.
	p.depth = quicSendQueue
	p.at = now
	if p.since.IsZero() {
		p.since, p.sends = now, 0
		return
	}
	// The queue was full then and is full now, so p.sends datagrams left in
	// between. Long samples only: a short one measures a burst, not the wire.
	if d := now.Sub(p.since); d >= pacerSample && p.sends >= pacerMinSends {
		p.observe(d / time.Duration(p.sends))
		p.since, p.sends = now, 0
	}
}

// advance brings the depth estimate up to date: the wire has been draining the
// queue since it was last evaluated.
func (p *pacer) advance(now time.Time) {
	if p.interval <= 0 {
		p.at = now
		return
	}
	if d := now.Sub(p.at); d > 0 && !p.at.IsZero() {
		p.depth -= float64(d) / float64(p.interval)
	}
	p.depth = max(p.depth, 0)
	p.at = now
}

// observe folds one departure-interval sample into the estimate.
func (p *pacer) observe(sample time.Duration) {
	switch {
	case sample <= 0:
	case p.interval <= 0:
		p.interval = sample
	default:
		p.interval = (3*p.interval + sample) / 4 // EWMA, α = ¼
	}
}

// probe nudges the estimate faster when the queue looks empty: the wire is
// then waiting on us rather than the other way round.
func (p *pacer) probe(now time.Time) {
	if p.interval <= 0 || p.depth > 1 {
		return
	}
	if p.probeAt.IsZero() || now.Sub(p.probeAt) >= pacerProbeEvery {
		if !p.probeAt.IsZero() {
			p.interval = p.interval * pacerProbeNum / pacerProbeDen
		}
		p.probeAt = now
	}
}
