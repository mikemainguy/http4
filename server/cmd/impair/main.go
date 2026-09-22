// Command impair is a UDP impairment proxy for testing HTTP4 over realistic
// paths: point clients at -listen and it forwards to -target, adding delay,
// jitter, loss and a bandwidth cap per direction ("up" = client → target).
//
//	impair -listen 127.0.0.1:0 -target 127.0.0.1:4433 -rtt 50ms -loss 0.01 -seed 1
//
// It prints one JSON ready line on stdout with the bound address, and one
// JSON stats line on SIGINT/SIGTERM before exiting.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"http4/server/internal/impair"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:0", "UDP address to accept clients on")
	target := flag.String("target", "", "UDP address to forward to (required)")
	rtt := flag.Duration("rtt", 0, "added round-trip time, split evenly between directions")
	delayUp := flag.Duration("delay-up", 0, "one-way delay client → target (overrides -rtt)")
	delayDown := flag.Duration("delay-down", 0, "one-way delay target → client (overrides -rtt)")
	jitter := flag.Duration("jitter", 0, "delay varies uniformly by ± this much, both directions")
	reorder := flag.Bool("reorder", false, "let jitter reorder packets (default: keep FIFO order)")
	loss := flag.Float64("loss", 0, "random loss probability, both directions")
	lossUp := flag.Float64("loss-up", 0, "loss client → target (overrides -loss)")
	lossDown := flag.Float64("loss-down", 0, "loss target → client (overrides -loss)")
	burst := flag.String("burst", "", "Gilbert-Elliott burst loss P,R[,lossBad] (good→bad, bad→good, loss while bad; default 1)")
	rate := flag.Int64("rate", 0, "bandwidth cap in bytes/second, each direction (0 = none)")
	queue := flag.Int("queue", 64<<10, "bytes of queue in front of the -rate cap before tail drop")
	seed := flag.Uint64("seed", 1, "seed for every random choice")
	idle := flag.Duration("idle", 2*time.Minute, "close a client mapping after this long without traffic")
	flag.Parse()
	if *target == "" {
		log.Fatal("-target is required")
	}
	set := map[string]bool{}
	flag.Visit(func(f *flag.Flag) { set[f.Name] = true })

	ge, err := parseBurst(*burst)
	if err != nil {
		log.Fatal(err)
	}
	dir := func(delay time.Duration, delayFlag string, l float64, lossFlag string) impair.Direction {
		d := impair.Direction{
			Delay: *rtt / 2, Jitter: *jitter, Reorder: *reorder, Loss: *loss, Burst: ge,
			RateBytesPerSec: *rate, QueueBytes: *queue,
		}
		if set[delayFlag] {
			d.Delay = delay
		}
		if set[lossFlag] {
			d.Loss = l
		}
		return d
	}
	p, err := impair.Start(impair.Config{
		Listen:      *listen,
		Target:      *target,
		Up:          dir(*delayUp, "delay-up", *lossUp, "loss-up"),
		Down:        dir(*delayDown, "delay-down", *lossDown, "loss-down"),
		Seed:        *seed,
		IdleTimeout: *idle,
	})
	if err != nil {
		log.Fatal(err)
	}
	out := json.NewEncoder(os.Stdout)
	out.Encode(map[string]string{"event": "ready", "listen": p.Addr().String(), "target": *target})

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	stats := p.Stats()
	p.Close()
	out.Encode(map[string]any{"event": "stats", "up": stats.Up, "down": stats.Down})
}

func parseBurst(s string) (*impair.GilbertElliott, error) {
	if s == "" {
		return nil, nil
	}
	parts := strings.Split(s, ",")
	if len(parts) < 2 || len(parts) > 3 {
		return nil, fmt.Errorf("-burst %q: want P,R[,lossBad]", s)
	}
	var v [3]float64
	for i, p := range parts {
		f, err := strconv.ParseFloat(strings.TrimSpace(p), 64)
		if err != nil || f < 0 || f > 1 {
			return nil, fmt.Errorf("-burst %q: %q is not a probability", s, p)
		}
		v[i] = f
	}
	return &impair.GilbertElliott{P: v[0], R: v[1], LossBad: v[2]}, nil
}
