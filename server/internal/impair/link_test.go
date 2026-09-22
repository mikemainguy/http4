package impair

import (
	"math"
	"testing"
	"time"
)

var t0 = time.Date(2026, 9, 22, 0, 0, 0, 0, time.UTC)

// within reports whether k losses in n trials are consistent with rate p
// (4 standard deviations of the binomial).
func within(k, n int, p float64) bool {
	sd := math.Sqrt(float64(n) * p * (1 - p))
	return math.Abs(float64(k)-float64(n)*p) <= 4*sd
}

func TestLossRate(t *testing.T) {
	for _, p := range []float64{0.01, 0.05} {
		l := newLink(Direction{Loss: p}, 1, 1)
		const n = 100_000
		lost := 0
		for i := range n {
			if v, _ := l.admit(t0.Add(time.Duration(i)*time.Millisecond), 1000); v == DropLoss {
				lost++
			}
		}
		if !within(lost, n, p) {
			t.Errorf("loss %.2f: %d of %d lost", p, lost, n)
		}
	}
}

func TestSameSeedSameDrops(t *testing.T) {
	pattern := func(seed uint64) []bool {
		l := newLink(Direction{Loss: 0.1, Jitter: 5 * time.Millisecond, Burst: &GilbertElliott{P: 0.02, R: 0.3}}, seed, 1)
		out := make([]bool, 5000)
		for i := range out {
			v, _ := l.admit(t0.Add(time.Duration(i)*time.Millisecond), 1200)
			out[i] = v != Deliver
		}
		return out
	}
	a, b, c := pattern(7), pattern(7), pattern(8)
	same := func(x, y []bool) bool {
		for i := range x {
			if x[i] != y[i] {
				return false
			}
		}
		return true
	}
	if !same(a, b) {
		t.Fatal("same seed gave different drop patterns")
	}
	if same(a, c) {
		t.Fatal("different seeds gave the same drop pattern")
	}
}

func TestJitterBoundsAndOrder(t *testing.T) {
	d, j := 25*time.Millisecond, 10*time.Millisecond
	for _, reorder := range []bool{false, true} {
		l := newLink(Direction{Delay: d, Jitter: j, Reorder: reorder}, 3, 1)
		var prev time.Time
		inversions := 0
		for i := range 10_000 {
			now := t0.Add(time.Duration(i) * time.Millisecond) // packets 1 ms apart, jitter 10 ms
			_, at := l.admit(now, 100)
			delay := at.Sub(now)
			if delay < d-j || (reorder && delay > d+j) {
				t.Fatalf("reorder=%v: delay %v outside [%v, %v]", reorder, delay, d-j, d+j)
			}
			if at.Before(prev) {
				inversions++
			}
			prev = at
		}
		if !reorder && inversions != 0 {
			t.Errorf("reorder=false: %d packets delivered out of order", inversions)
		}
		if reorder && inversions == 0 {
			t.Error("reorder=true: jitter never reordered anything")
		}
	}
}

func TestRateCapAndTailDrop(t *testing.T) {
	// 1000 packets of 1000 B arrive at once on a 1 MB/s link: the last
	// leaves 1 s later if the queue can hold them all.
	l := newLink(Direction{RateBytesPerSec: 1_000_000, QueueBytes: 2_000_000}, 1, 1)
	var last time.Time
	for range 1000 {
		v, at := l.admit(t0, 1000)
		if v != Deliver {
			t.Fatal("dropped with a queue big enough for everything")
		}
		last = at
	}
	if got := last.Sub(t0); got != time.Second {
		t.Errorf("last departure after %v, want 1s", got)
	}

	// A 10 KB queue holds 10 packets beyond the one being sent.
	l = newLink(Direction{RateBytesPerSec: 1_000_000, QueueBytes: 10_000}, 1, 1)
	delivered := 0
	for range 100 {
		if v, _ := l.admit(t0, 1000); v == Deliver {
			delivered++
		}
	}
	if delivered < 10 || delivered > 11 {
		t.Errorf("%d delivered through a 10 KB queue, want 10–11", delivered)
	}
}

func TestGilbertElliottBursts(t *testing.T) {
	// Stationary P(bad) = P/(P+R) = 0.02/0.32 = 6.25%; mean burst = 1/R ≈ 3.3.
	ge := &GilbertElliott{P: 0.02, R: 0.3}
	l := newLink(Direction{Burst: ge}, 5, 1)
	const n = 200_000
	lost, bursts := 0, 0
	inBurst := false
	for i := range n {
		v, _ := l.admit(t0.Add(time.Duration(i)*time.Millisecond), 1000)
		if v == DropLoss {
			lost++
			if !inBurst {
				bursts++
			}
		}
		inBurst = v == DropLoss
	}
	rate := float64(lost) / n
	meanBurst := float64(lost) / float64(bursts)
	if math.Abs(rate-0.0625) > 0.005 {
		t.Errorf("loss rate %.4f, want ≈ 0.0625", rate)
	}
	if meanBurst < 2.8 || meanBurst > 3.9 {
		t.Errorf("mean burst %.2f, want ≈ 3.3", meanBurst)
	}
}
