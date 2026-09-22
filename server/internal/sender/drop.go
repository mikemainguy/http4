package sender

import (
	"fmt"
	"math/rand/v2"
	"strconv"
	"strings"
)

// DropInfo describes an outgoing DATA or META packet to a loss-injection rule.
type DropInfo struct {
	Meta    bool // a META packet; every other field describes DATA
	Packet0 bool // offset 0
	Final   bool // ends at total_size (and the asset is not empty)
	Resend  bool // a retransmission, not the first time these bytes go out
}

// Dropper decides whether to drop an outgoing packet, simulating loss
// on the wire. The sender treats a dropped packet as sent. Testing only.
type Dropper func(DropInfo) bool

// ParseDropSpec parses a loss-injection spec into a factory that makes one
// Dropper per session, so counters and random streams don't leak between
// sessions. Rules are comma-separated and a packet is dropped if any rule matches:
//
//	every=N   drop every Nth DATA packet sent in the session (N >= 2)
//	packet0   drop the first transmission of each RPC's packet 0
//	final     drop the first transmission of each RPC's final chunk
//	meta      drop the first transmission of each RPC's META
//	rate=P    drop each DATA packet with probability P (0 < P < 1)
//	seed=S    seed for rate (default 1)
//
// Only first transmissions are targeted by packet0/final/meta, so recovery
// can succeed. every and rate count DATA packets only.
func ParseDropSpec(spec string) (func() Dropper, error) {
	var every int
	var packet0, final, meta bool
	var rate float64
	var seed uint64 = 1
	for part := range strings.SplitSeq(spec, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		key, val, _ := strings.Cut(part, "=")
		var err error
		switch key {
		case "every":
			every, err = strconv.Atoi(val)
			if err == nil && every < 2 {
				err = fmt.Errorf("must be >= 2")
			}
		case "packet0":
			packet0 = true
		case "final":
			final = true
		case "meta":
			meta = true
		case "rate":
			rate, err = strconv.ParseFloat(val, 64)
			if err == nil && (rate <= 0 || rate >= 1) {
				err = fmt.Errorf("must be in (0, 1)")
			}
		case "seed":
			seed, err = strconv.ParseUint(val, 10, 64)
		default:
			err = fmt.Errorf("unknown rule")
		}
		if err != nil {
			return nil, fmt.Errorf("drop spec %q: %w", part, err)
		}
	}
	if every == 0 && !packet0 && !final && !meta && rate == 0 {
		return nil, nil
	}
	return func() Dropper {
		n := 0
		rng := rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15))
		return func(d DropInfo) bool {
			if d.Meta {
				return meta && !d.Resend
			}
			n++
			switch {
			case every > 0 && n%every == 0:
				return true
			case packet0 && d.Packet0 && !d.Resend:
				return true
			case final && d.Final && !d.Resend:
				return true
			case rate > 0 && rng.Float64() < rate:
				return true
			}
			return false
		}
	}, nil
}
