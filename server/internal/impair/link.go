// Package impair is a user-space UDP impairment proxy: it forwards datagrams
// between clients and one target while adding delay, jitter, reordering,
// random or bursty loss, and a bandwidth cap, independently per direction and
// deterministically from a seed. It impairs every packet QUIC sends
// (handshake, ACKs, DATA), with no root privileges or kernel configuration.
//
// link.go is the per-direction model: given a packet's arrival time and size
// it decides whether the packet is dropped and, if not, when it is delivered.
// It has no sockets or clock of its own, so it can be tested exactly.
package impair

import (
	"math/rand/v2"
	"time"
)

// Direction configures one direction of the path.
type Direction struct {
	Delay  time.Duration // one-way propagation delay
	Jitter time.Duration // each packet's delay varies uniformly in [Delay-Jitter, Delay+Jitter]
	// Reorder lets jitter change packet order. When false, a packet is never
	// delivered before one that arrived earlier, as on a single FIFO path.
	Reorder bool
	Loss    float64 // independent loss probability (the "good" state's loss if Burst is set)
	Burst   *GilbertElliott
	// RateBytesPerSec caps throughput (0 = unlimited). Packets wait in a FIFO
	// queue of at most QueueBytes; a packet that doesn't fit is tail-dropped.
	RateBytesPerSec int64
	QueueBytes      int
}

// GilbertElliott is a two-state burst-loss model. Each packet first moves
// the chain (good→bad with P, bad→good with R), then is lost with LossBad
// in the bad state or Direction.Loss in the good state.
type GilbertElliott struct {
	P, R    float64
	LossBad float64 // 0 means 1: everything is lost while bad
}

// Verdict is what the link decided for one packet.
type Verdict int

const (
	Deliver Verdict = iota
	DropLoss
	DropQueue
)

type link struct {
	d   Direction
	rng *rand.Rand

	bad         bool      // Gilbert-Elliott state
	linkFreeAt  time.Time // when the rate-limited transmitter finishes its queue
	lastDeliver time.Time // latest delivery time so far, for FIFO order
}

func newLink(d Direction, seed, stream uint64) *link {
	if d.Burst != nil && d.Burst.LossBad == 0 {
		b := *d.Burst
		b.LossBad = 1
		d.Burst = &b
	}
	return &link{d: d, rng: rand.New(rand.NewPCG(seed, stream))}
}

// admit decides the fate of a packet of size bytes arriving at now. Calls
// must come in arrival order; the random stream is consumed identically for
// identical call sequences, which is what makes a seed reproducible.
func (l *link) admit(now time.Time, size int) (Verdict, time.Time) {
	loss := l.d.Loss
	if ge := l.d.Burst; ge != nil {
		if l.bad {
			l.bad = l.rng.Float64() >= ge.R
		} else {
			l.bad = l.rng.Float64() < ge.P
		}
		if l.bad {
			loss = ge.LossBad
		}
	}
	if loss > 0 && l.rng.Float64() < loss {
		return DropLoss, time.Time{}
	}

	depart := now
	if rate := l.d.RateBytesPerSec; rate > 0 {
		start := now
		if l.linkFreeAt.After(now) {
			start = l.linkFreeAt
		}
		queued := int64(start.Sub(now)) * rate / int64(time.Second) // bytes still ahead of this one
		if l.d.QueueBytes > 0 && queued+int64(size) > int64(l.d.QueueBytes) {
			return DropQueue, time.Time{}
		}
		depart = start.Add(time.Duration(int64(size) * int64(time.Second) / rate))
		l.linkFreeAt = depart
	}

	delay := l.d.Delay
	if j := l.d.Jitter; j > 0 {
		delay += time.Duration(l.rng.Int64N(int64(2*j)+1)) - j
		delay = max(delay, 0)
	}
	at := depart.Add(delay)
	if !l.d.Reorder && at.Before(l.lastDeliver) {
		at = l.lastDeliver
	}
	if at.After(l.lastDeliver) {
		l.lastDeliver = at
	}
	return Deliver, at
}
