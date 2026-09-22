package server

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"http4/server/internal/impair"
)

// With AdvertiseWT pointing at an impairment proxy, clients reach the server
// through the proxy (and pay its RTT) while the certificate hash still verifies.
func TestAdvertisedWebTransportThroughProxy(t *testing.T) {
	// Reserve a UDP port for the proxy so it can be advertised before the
	// proxy exists (the proxy needs the server's listener address as target).
	probe, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	proxyAddr := probe.LocalAddr().String()
	probe.Close()

	static := t.TempDir()
	os.WriteFile(filepath.Join(static, "index.html"), []byte("<p>hi</p>"), 0o644)
	s, err := Start(Config{HTTPAddr: "127.0.0.1:0", WTAddr: "127.0.0.1:0", StaticDir: static, AssetsDir: t.TempDir(), AdvertiseWT: proxyAddr})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })

	const rtt = 30 * time.Millisecond
	p, err := impair.Start(impair.Config{
		Listen: proxyAddr, Target: s.WTListenAddr,
		Up: impair.Direction{Delay: rtt / 2}, Down: impair.Direction{Delay: rtt / 2},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close() })

	cfg := fetchConfig(t, s)
	for _, u := range []string{cfg.WebTransportURL, cfg.EchoURL} {
		if !strings.Contains(u, proxyAddr) {
			t.Fatalf("advertised URL %s does not point at the proxy %s", u, proxyAddr)
		}
	}
	if s.WTListenAddr == proxyAddr {
		t.Fatal("listener moved to the advertised address")
	}

	_, sess, err := dial(t, cfg, cfg.EchoURL, s.HTTPURL)
	if err != nil {
		t.Fatal(err)
	}
	defer sess.CloseWithError(0, "")
	start := time.Now()
	if err := sess.SendDatagram([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := sess.ReceiveDatagram(ctx); err != nil {
		t.Fatal(err)
	}
	if got := time.Since(start); got < rtt {
		t.Errorf("echo took %v through a %v-RTT proxy", got, rtt)
	}
	if st := p.Stats(); st.Up.Forwarded == 0 || st.Down.Forwarded == 0 {
		t.Errorf("proxy saw no traffic: %+v", st)
	}
}
