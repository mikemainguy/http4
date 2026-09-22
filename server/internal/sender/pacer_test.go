package sender

import (
	"fmt"
	"testing"
	"time"

	"http4/server/internal/wire"
)

var epoch = time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)

// saturate feeds p a run of blocked sends spaced by interval, as a full queue
// does, and returns the time it ended at.
func saturate(p *pacer, at time.Time, interval time.Duration, n int) time.Time {
	for range n {
		at = at.Add(interval)
		p.sent(at, true)
	}
	return at
}

func TestPacerWaitsForNothingUntilItHasMeasured(t *testing.T) {
	p := &pacer{target: 4}
	at := epoch
	for range 100 {
		if d := p.wait(at); d != 0 {
			t.Fatalf("wait = %v before any measurement, want 0", d)
		}
		at = at.Add(time.Millisecond)
		p.sent(at, false)
	}
}

func TestPacerLeavesFastPathsAlone(t *testing.T) {
	p := &pacer{target: 4}
	// A loopback-ish wire: 32 queued datagrams drain in ~2 ms, so pacing them
	// would cost more in timer granularity than the delay it saves.
	at := saturate(p, epoch, 60*time.Microsecond, 8192)
	if p.interval >= pacerMinInterval {
		t.Fatalf("interval %v, want < %v for this test", p.interval, pacerMinInterval)
	}
	if d := p.wait(at); d != 0 {
		t.Errorf("wait = %v on a fast path, want 0", d)
	}
}

func TestPacerMeasuresTheWireAndDrainsAFullQueue(t *testing.T) {
	const interval = 4 * time.Millisecond
	p := &pacer{target: 4}
	at := saturate(p, epoch, interval, 64)

	if got := p.interval; got < 3800*time.Microsecond || got > 4200*time.Microsecond {
		t.Errorf("measured interval %v, want ≈ %v", got, interval)
	}
	// The last send blocked, so the queue is full: it holds off, one capped
	// wait at a time, until enough datagrams have departed.
	drain := time.Duration((quicSendQueue - 4 + 1) * interval) // 29 × 4 ms
	if d := p.wait(at); d != pacerMaxWait {
		t.Errorf("wait = %v after a full queue, want the %v cap", d, pacerMaxWait)
	}
	if d := p.wait(at.Add(pacerMaxWait)); d <= 0 {
		t.Errorf("wait = %v partway through the drain, want it to keep holding off", d)
	}
	// Once those departures have happened, it stops holding off.
	if d := p.wait(at.Add(drain)); d != 0 {
		t.Errorf("wait = %v after the queue drained, want 0", d)
	}
}

// The mistake this cost a benchmark run to find: on a congestion-controlled
// path nothing leaves for an RTT and then a window's worth pops at once, so
// the spacing between two blocked sends is the burst's, not the wire's.
func TestPacerMeasuresTheSustainedRateNotTheBurst(t *testing.T) {
	const burst = 8
	const gap = 50 * time.Millisecond     // an RTT with nothing leaving
	const within = 200 * time.Microsecond // spacing inside a burst

	p := &pacer{target: 4}
	at := epoch
	for range 20 { // a second of bursts
		at = saturate(p, at.Add(gap), within, burst)
	}
	want := (gap + burst*within) / burst // ~6.4 ms, not 200 µs
	if p.interval < want*4/5 || p.interval > want*6/5 {
		t.Errorf("interval %v, want ≈ %v: the wire's rate, not the %v burst spacing", p.interval, want, within)
	}
}

func TestPacerProbesFasterWhileNothingBlocks(t *testing.T) {
	p := &pacer{target: 4}
	at := saturate(p, epoch, 4*time.Millisecond, 64)
	measured := p.interval
	for range 20 { // 20 × 200 ms of sends that find room
		at = at.Add(pacerProbeEvery)
		p.sent(at, false)
	}
	if p.interval >= measured {
		t.Errorf("interval %v did not creep below the measured %v", p.interval, measured)
	}
	if p.interval < measured*3/4 {
		t.Errorf("interval %v crept too far below %v", p.interval, measured)
	}
}

func TestPacerForgetsTheQueueAfterAnIdle(t *testing.T) {
	p := &pacer{target: 4}
	at := saturate(p, epoch, 4*time.Millisecond, 64)
	if d := p.wait(at.Add(time.Second)); d != 0 {
		t.Errorf("wait = %v a second after the last send, want 0: the queue has long drained", d)
	}
}

// sendQueue models quic-go's datagram queue: 32 deep, one departure per
// interval, and an enqueue that blocks while it is full.
type sendQueue struct {
	interval time.Duration
	queued   int
	nextPop  time.Time
}

func (w *sendQueue) drain(now time.Time) {
	for w.queued > 0 && !now.Before(w.nextPop) {
		w.queued--
		w.nextPop = w.nextPop.Add(w.interval)
	}
	if w.queued == 0 && now.After(w.nextPop) {
		w.nextPop = now // an idle wire starts the next datagram when it arrives
	}
}

// push enqueues one datagram, waiting if the queue is full. It returns the
// time the enqueue completed and whether it had to wait.
func (w *sendQueue) push(now time.Time) (time.Time, bool) {
	w.drain(now)
	blocked := w.queued >= quicSendQueue
	if blocked {
		now = w.nextPop
		w.drain(now)
	}
	if w.queued == 0 {
		w.nextPop = now.Add(w.interval)
	}
	w.queued++
	return now, blocked
}

// The control loop against that wire: the queue should stay near the target
// without giving up throughput, which is the whole point (iss-dy53a59).
func TestPacerKeepsTheQueueShallowWithoutLosingThroughput(t *testing.T) {
	const interval = 4 * time.Millisecond
	const run = 30 * time.Second
	p := &pacer{target: 4}
	w := &sendQueue{interval: interval, nextPop: epoch}

	now, sends, blocks, deep := epoch, 0, 0, 0
	depth := 0
	for now.Sub(epoch) < run {
		if d := p.wait(now); d > 0 {
			now = now.Add(d)
		}
		at, blocked := w.push(now)
		now = at
		p.sent(now, blocked)
		sends++
		depth += w.queued
		if blocked {
			blocks++
		}
		if w.queued > p.target+2 {
			deep++
		}
	}

	// Throughput: the wire could carry run/interval datagrams; pacing must not
	// give much of that up.
	capacity := int(run / interval)
	if sends < capacity*9/10 {
		t.Errorf("sent %d datagrams, want ≥ 90%% of the wire's %d", sends, capacity)
	}
	// Depth: the point of the exercise. Averaged, and however often it is
	// allowed to run deep while the estimate re-syncs.
	if avg := float64(depth) / float64(sends); avg > float64(p.target)+3 {
		t.Errorf("average queue depth %.1f, want ≲ %d", avg, p.target+3)
	}
	if got := 100 * deep / sends; got > 20 {
		t.Errorf("queue was deeper than target+2 for %d%% of sends, want ≤ 20%%", got)
	}
	t.Logf("%d sends (wire capacity %d), %d blocked, avg depth %.1f, %d%% deep, final interval %v",
		sends, capacity, blocks, float64(depth)/float64(sends), 100*deep/sends, p.interval)
}

// queueDatagrams puts QUIC's send queue between the sender and the test: it
// holds quicSendQueue datagrams, releases one every interval and blocks the
// sender once it is full. Packets then reach the test in departure order,
// which is the order a client sees them in.
func (h harness) queueDatagrams(interval time.Duration) {
	q := make(chan []byte, quicSendQueue)
	h.mu.Lock()
	h.queue = q
	h.mu.Unlock()
	go func() {
		for {
			select {
			case b := <-q:
				select {
				case <-time.After(interval):
				case <-h.closed:
					return
				}
				if err := h.deliver(b); err != nil {
					return
				}
			case <-h.closed:
				return
			}
		}
	}()
}

// bulkAhead saturates the wire with a bulk transfer, then asks for a small
// asset and returns how many bulk datagrams depart before its first one.
func bulkAhead(t *testing.T, target int, interval time.Duration) int {
	t.Helper()
	h := start(t, MapAssets{"bulk": asset(1 << 20), "small": asset(900)},
		func(c *Config) { c.SendQueueTarget = target })
	h.queueDatagrams(interval)
	h.send(&wire.Req{RPCID: 1, InitialGrant: 1 << 20, AssetID: "bulk"})

	// Long enough to fill the queue, for the pacer to measure the wire (a
	// sample spans pacerSample) and for the queue to drain to the target.
	time.Sleep(pacerSample + 500*time.Millisecond)
	for len(h.out) > 0 { // what has already departed is ahead of nothing
		<-h.out
	}
	h.send(&wire.Req{RPCID: 2, InitialGrant: 900, AssetID: "small"})

	n := 0
	deadline := time.After(5 * time.Second)
	for {
		select {
		case p := <-h.out:
			var d *wire.Data
			switch p := p.(type) {
			case *wire.Data:
				d = p
			case *wire.DataSeq:
				d = &p.Data
			default:
				continue
			}
			if d.RPCID == 2 {
				return n
			}
			n++
		case <-deadline:
			t.Fatalf("the small reply never came; %d bulk datagrams departed", n)
		}
	}
}

// The other half of it, and what a 7 s p90 in the benchmark looked like: a
// session with nothing but small replies must not be held back at all. They
// are what the pacer exists to protect, and making them wait throttles the
// sender below its own offered load for no benefit at all.
func TestSmallRepliesAreNeverHeldBack(t *testing.T) {
	const interval = 2 * time.Millisecond
	const n = 150

	elapsed := func(target int) time.Duration {
		assets := MapAssets{}
		for i := range n {
			assets[fmt.Sprintf("a%d", i)] = asset(900)
		}
		h := start(t, assets, func(c *Config) { c.SendQueueTarget = target })
		h.queueDatagrams(interval)
		t0 := time.Now()
		for i := range n {
			h.send(&wire.Req{RPCID: wire.RPCID(i + 1), InitialGrant: 900, AssetID: fmt.Sprintf("a%d", i)})
		}
		for got := 0; got < n; {
			select {
			case p := <-h.out:
				switch p.(type) {
				case *wire.Data, *wire.DataSeq:
					got++
				}
			case <-time.After(30 * time.Second):
				t.Fatalf("only %d of %d replies arrived", got, n)
			}
		}
		return time.Since(t0)
	}

	unpaced, paced := elapsed(-1), elapsed(DefaultSendQueueTarget)
	t.Logf("%d small replies took %v unpaced, %v paced", n, unpaced, paced)
	if paced > unpaced*5/4 {
		t.Errorf("pacing made %d small replies take %v against %v unpaced: it is throttling the traffic it exists to protect", n, paced, unpaced)
	}
}

// The point of the whole exercise, end to end: a small reply asked for while
// bulk saturates the wire must not depart behind a queue full of bulk
// (vrek iss-dy53a59, fnd-pp7zab7).
func TestSmallReplyDoesNotDepartBehindAFullQueueOfBulk(t *testing.T) {
	const interval = 2 * time.Millisecond // 32 queued datagrams = 64 ms of wire

	unpaced := bulkAhead(t, -1, interval)
	paced := bulkAhead(t, DefaultSendQueueTarget, interval)
	t.Logf("bulk datagrams ahead of the small reply: %d unpaced, %d paced", unpaced, paced)

	if unpaced < quicSendQueue*2/3 {
		t.Errorf("unpaced, only %d bulk datagrams preceded the small reply; expected a nearly full queue (%d)", unpaced, quicSendQueue)
	}
	if want := DefaultSendQueueTarget + 4; paced > want {
		t.Errorf("paced, %d bulk datagrams preceded the small reply, want ≤ %d", paced, want)
	}
}
