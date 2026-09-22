package impair

import (
	"container/heap"
	"errors"
	"net"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

type Config struct {
	Listen string // UDP address clients send to, e.g. 127.0.0.1:0
	Target string // UDP address everything is forwarded to
	Up     Direction
	Down   Direction // target → client
	Seed   uint64
	// IdleTimeout closes a client's mapping after this long without traffic
	// in either direction (default 2 minutes, longer than QUIC's idle timeout).
	IdleTimeout time.Duration
}

// Proxy forwards datagrams like a NAT: each client source address gets its
// own upstream socket to the target, so the target sees one peer per client.
type Proxy struct {
	cfg    Config
	ln     *net.UDPConn
	target *net.UDPAddr
	up     *pipe
	down   *pipe

	mu   sync.Mutex
	maps map[string]*mapping

	done chan struct{}
	wg   sync.WaitGroup
}

type mapping struct {
	client *net.UDPAddr
	conn   *net.UDPConn // connected to the target
	last   atomic.Int64 // unix nanos of the latest packet either way
}

func Start(cfg Config) (*Proxy, error) {
	if cfg.IdleTimeout == 0 {
		cfg.IdleTimeout = 2 * time.Minute
	}
	target, err := net.ResolveUDPAddr("udp", cfg.Target)
	if err != nil {
		return nil, err
	}
	laddr, err := net.ResolveUDPAddr("udp", cfg.Listen)
	if err != nil {
		return nil, err
	}
	ln, err := net.ListenUDP("udp", laddr)
	if err != nil {
		return nil, err
	}
	p := &Proxy{
		cfg:    cfg,
		ln:     ln,
		target: target,
		up:     newPipe(newLink(cfg.Up, cfg.Seed, 1)),
		down:   newPipe(newLink(cfg.Down, cfg.Seed, 2)),
		maps:   make(map[string]*mapping),
		done:   make(chan struct{}),
	}
	p.wg.Go(func() { p.up.run(p.done) })
	p.wg.Go(func() { p.down.run(p.done) })
	p.wg.Go(p.readClients)
	p.wg.Go(p.expireIdle)
	return p, nil
}

func (p *Proxy) Addr() *net.UDPAddr { return p.ln.LocalAddr().(*net.UDPAddr) }

// Close stops forwarding. Packets still in flight are discarded.
func (p *Proxy) Close() error {
	close(p.done)
	err := p.ln.Close()
	p.mu.Lock()
	for _, m := range p.maps {
		m.conn.Close()
	}
	p.mu.Unlock()
	p.wg.Wait()
	return err
}

func (p *Proxy) readClients() {
	buf := make([]byte, 64<<10)
	for {
		n, from, err := p.ln.ReadFromUDP(buf)
		if err != nil {
			return
		}
		m, err := p.mapping(from)
		if err != nil {
			continue
		}
		m.last.Store(time.Now().UnixNano())
		p.up.push(buf[:n], func(b []byte) { m.conn.Write(b) })
	}
}

func (p *Proxy) mapping(client *net.UDPAddr) (*mapping, error) {
	key := client.String()
	p.mu.Lock()
	defer p.mu.Unlock()
	if m := p.maps[key]; m != nil {
		return m, nil
	}
	conn, err := net.DialUDP("udp", nil, p.target)
	if err != nil {
		return nil, err
	}
	m := &mapping{client: client, conn: conn}
	p.maps[key] = m
	p.wg.Go(func() { p.readTarget(m) })
	return m, nil
}

func (p *Proxy) readTarget(m *mapping) {
	buf := make([]byte, 64<<10)
	for {
		n, err := m.conn.Read(buf)
		if err != nil {
			if isClosed(err) {
				return
			}
			continue // e.g. ICMP port unreachable while the target restarts
		}
		m.last.Store(time.Now().UnixNano())
		p.down.push(buf[:n], func(b []byte) { p.ln.WriteToUDP(b, m.client) })
	}
}

func (p *Proxy) expireIdle() {
	t := time.NewTicker(max(p.cfg.IdleTimeout/4, 10*time.Millisecond))
	defer t.Stop()
	for {
		select {
		case <-p.done:
			return
		case <-t.C:
		}
		cutoff := time.Now().Add(-p.cfg.IdleTimeout).UnixNano()
		p.mu.Lock()
		for key, m := range p.maps {
			if m.last.Load() < cutoff {
				m.conn.Close()
				delete(p.maps, key)
			}
		}
		p.mu.Unlock()
	}
}

func isClosed(err error) bool { return errors.Is(err, net.ErrClosed) }

// Stats counts packets per direction.
type Stats struct {
	Up       DirStats `json:"up"`
	Down     DirStats `json:"down"`
	Mappings int      `json:"mappings"`
}

type DirStats struct {
	In           int64 `json:"in"`
	Forwarded    int64 `json:"forwarded"`
	DroppedLoss  int64 `json:"dropped_loss"`
	DroppedQueue int64 `json:"dropped_queue"`
}

func (p *Proxy) Stats() Stats {
	p.mu.Lock()
	n := len(p.maps)
	p.mu.Unlock()
	return Stats{Up: p.up.stats(), Down: p.down.stats(), Mappings: n}
}

// pipe is one direction: packets are admitted by the link model in arrival
// order and sent by a single goroutine at their delivery times.
type pipe struct {
	mu    sync.Mutex
	link  *link
	queue pktHeap
	seq   uint64
	wake  chan struct{}

	in, forwarded, droppedLoss, droppedQueue atomic.Int64
}

type pkt struct {
	at   time.Time
	seq  uint64 // arrival order, breaks ties so equal times stay FIFO
	b    []byte
	send func([]byte)
}

func newPipe(l *link) *pipe {
	return &pipe{link: l, wake: make(chan struct{}, 1)}
}

func (p *pipe) push(b []byte, send func([]byte)) {
	p.in.Add(1)
	p.mu.Lock()
	v, at := p.link.admit(time.Now(), len(b))
	switch v {
	case DropLoss:
		p.mu.Unlock()
		p.droppedLoss.Add(1)
		return
	case DropQueue:
		p.mu.Unlock()
		p.droppedQueue.Add(1)
		return
	}
	p.seq++
	heap.Push(&p.queue, &pkt{at: at, seq: p.seq, b: append([]byte(nil), b...), send: send})
	p.mu.Unlock()
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

// spinWindow is how close to a delivery time the pipe stops sleeping on a
// timer and spins instead.
const spinWindow = 2 * time.Millisecond

func (p *pipe) run(done <-chan struct{}) {
	timer := time.NewTimer(time.Hour)
	defer timer.Stop()
	for {
		p.mu.Lock()
		var next *pkt
		if len(p.queue) > 0 {
			next = p.queue[0]
		}
		if next != nil && !next.at.After(time.Now()) {
			heap.Pop(&p.queue)
			p.mu.Unlock()
			next.send(next.b)
			p.forwarded.Add(1)
			continue
		}
		p.mu.Unlock()

		wait := time.Hour
		if next != nil {
			wait = time.Until(next.at)
			if wait <= spinWindow {
				// Timers can wake ~1 ms late (measured on macOS), which would
				// add that much to every hop. Spin for the last stretch.
				select {
				case <-done:
					return
				default:
				}
				runtime.Gosched()
				continue
			}
		}
		timer.Reset(wait - spinWindow)
		select {
		case <-done:
			return
		case <-p.wake:
		case <-timer.C:
		}
	}
}

func (p *pipe) stats() DirStats {
	return DirStats{In: p.in.Load(), Forwarded: p.forwarded.Load(), DroppedLoss: p.droppedLoss.Load(), DroppedQueue: p.droppedQueue.Load()}
}

type pktHeap []*pkt

func (h pktHeap) Len() int { return len(h) }
func (h pktHeap) Less(i, j int) bool {
	if !h[i].at.Equal(h[j].at) {
		return h[i].at.Before(h[j].at)
	}
	return h[i].seq < h[j].seq
}
func (h pktHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *pktHeap) Push(x any)   { *h = append(*h, x.(*pkt)) }
func (h *pktHeap) Pop() any {
	old := *h
	x := old[len(old)-1]
	*h = old[:len(old)-1]
	return x
}
