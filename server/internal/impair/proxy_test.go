package impair

import (
	"encoding/binary"
	"net"
	"sort"
	"sync/atomic"
	"testing"
	"time"
)

// echoTarget is a UDP server on loopback that sends every datagram back and
// counts them.
type echoTarget struct {
	conn  *net.UDPConn
	count atomic.Int64
}

func startEcho(t *testing.T, reply bool) *echoTarget {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	e := &echoTarget{conn: conn}
	go func() {
		buf := make([]byte, 64<<10)
		for {
			n, from, err := conn.ReadFromUDP(buf)
			if err != nil {
				return
			}
			e.count.Add(1)
			if reply {
				conn.WriteToUDP(buf[:n], from)
			}
		}
	}()
	t.Cleanup(func() { conn.Close() })
	return e
}

func startProxy(t *testing.T, target *net.UDPConn, cfg Config) (*Proxy, *net.UDPConn) {
	t.Helper()
	cfg.Listen = "127.0.0.1:0"
	cfg.Target = target.LocalAddr().String()
	p, err := Start(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close() })
	client, err := net.DialUDP("udp", nil, p.Addr())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close() })
	return p, client
}

// The RTT added by the proxy matches the configured one-way delays within ±2 ms.
func TestAddedRTT(t *testing.T) {
	echo := startEcho(t, true)
	for _, rtt := range []time.Duration{20 * time.Millisecond, 50 * time.Millisecond} {
		_, client := startProxy(t, echo.conn, Config{
			Up:   Direction{Delay: rtt / 2},
			Down: Direction{Delay: rtt / 2},
		})
		var samples []time.Duration
		buf := make([]byte, 1500)
		for i := range 40 {
			msg := binary.BigEndian.AppendUint32(nil, uint32(i))
			start := time.Now()
			client.Write(msg)
			client.SetReadDeadline(time.Now().Add(time.Second))
			if _, err := client.Read(buf); err != nil {
				t.Fatalf("rtt %v: ping %d: %v", rtt, i, err)
			}
			samples = append(samples, time.Since(start))
		}
		sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
		median := samples[len(samples)/2]
		t.Logf("configured RTT %v: measured median %v (min %v, max %v)", rtt, median, samples[0], samples[len(samples)-1])
		if d := median - rtt; d < -2*time.Millisecond || d > 2*time.Millisecond {
			t.Errorf("configured RTT %v, measured median %v", rtt, median)
		}
	}
}

// Packets lost at the proxy never reach the target, the rate matches the
// configured probability, and the counters add up.
func TestLossOnTheWire(t *testing.T) {
	for _, loss := range []float64{0.01, 0.05} {
		target := startEcho(t, false)
		p, client := startProxy(t, target.conn, Config{Up: Direction{Loss: loss}, Seed: 11})
		const n = 20_000
		msg := make([]byte, 200)
		for i := range n {
			client.Write(msg)
			if i%100 == 99 {
				time.Sleep(time.Millisecond) // stay well below socket buffer limits
			}
		}
		deadline := time.Now().Add(2 * time.Second)
		for p.Stats().Up.Forwarded != target.count.Load() || p.Stats().Up.In < n {
			if time.Now().After(deadline) {
				break
			}
			time.Sleep(5 * time.Millisecond)
		}
		s := p.Stats().Up
		t.Logf("loss %.2f: in %d, forwarded %d, lost %d (%.3f%%), target got %d", loss, s.In, s.Forwarded, s.DroppedLoss, 100*float64(s.DroppedLoss)/float64(s.In), target.count.Load())
		if s.In != n || s.In != s.Forwarded+s.DroppedLoss || s.Forwarded != target.count.Load() {
			t.Fatalf("counters don't add up: %+v, target got %d", s, target.count.Load())
		}
		if !within(int(s.DroppedLoss), n, loss) {
			t.Errorf("loss %.2f: %d of %d dropped", loss, s.DroppedLoss, n)
		}
	}
}

// With jitter but Reorder=false the target sees packets in send order;
// with Reorder=true some arrive out of order.
func TestJitterOrderOnTheWire(t *testing.T) {
	for _, reorder := range []bool{false, true} {
		target, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { target.Close() })
		_, client := startProxy(t, target, Config{Up: Direction{Delay: 5 * time.Millisecond, Jitter: 4 * time.Millisecond, Reorder: reorder}, Seed: 2})
		const n = 300
		for i := range n {
			client.Write(binary.BigEndian.AppendUint32(nil, uint32(i)))
			time.Sleep(200 * time.Microsecond)
		}
		buf := make([]byte, 64)
		prev, inversions := -1, 0
		for range n {
			target.SetReadDeadline(time.Now().Add(time.Second))
			if _, err := target.Read(buf); err != nil {
				t.Fatalf("reorder=%v: %v", reorder, err)
			}
			seq := int(binary.BigEndian.Uint32(buf))
			if seq < prev {
				inversions++
			}
			prev = seq
		}
		if !reorder && inversions != 0 {
			t.Errorf("reorder=false: %d inversions", inversions)
		}
		if reorder && inversions == 0 {
			t.Error("reorder=true: no inversions")
		}
	}
}

// A 500 KB/s cap stretches a 300 KB burst to ~0.6 s.
func TestBandwidthCapOnTheWire(t *testing.T) {
	target := startEcho(t, false)
	p, client := startProxy(t, target.conn, Config{Up: Direction{RateBytesPerSec: 500_000, QueueBytes: 1 << 20}})
	start := time.Now()
	msg := make([]byte, 1000)
	for range 300 {
		client.Write(msg)
	}
	for target.count.Load() < 300 {
		if time.Since(start) > 3*time.Second {
			t.Fatalf("only %d of 300 arrived", target.count.Load())
		}
		time.Sleep(2 * time.Millisecond)
	}
	elapsed := time.Since(start)
	t.Logf("300 KB through a 500 KB/s cap in %v (%+v)", elapsed, p.Stats().Up)
	if elapsed < 510*time.Millisecond || elapsed > 690*time.Millisecond {
		t.Errorf("took %v, want ≈ 600 ms", elapsed)
	}
}

func TestMappingPerClientAndIdleExpiry(t *testing.T) {
	echo := startEcho(t, true)
	p, a := startProxy(t, echo.conn, Config{IdleTimeout: 100 * time.Millisecond})
	b, err := net.DialUDP("udp", nil, p.Addr())
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	buf := make([]byte, 16)
	for _, c := range []*net.UDPConn{a, b} {
		c.Write([]byte("hi"))
		c.SetReadDeadline(time.Now().Add(time.Second))
		if _, err := c.Read(buf); err != nil {
			t.Fatal(err)
		}
	}
	if n := p.Stats().Mappings; n != 2 {
		t.Fatalf("%d mappings for 2 clients", n)
	}
	time.Sleep(300 * time.Millisecond)
	if n := p.Stats().Mappings; n != 0 {
		t.Fatalf("%d mappings left after idle timeout", n)
	}
	a.Write([]byte("again")) // a new mapping is created on demand
	a.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := a.Read(buf); err != nil {
		t.Fatal("no reply after the mapping was re-created:", err)
	}
}
