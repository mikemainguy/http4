package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/webtransport-go"

	"http4/server/internal/wire"
)

func startTestServer(t *testing.T, assets map[string][]byte) *Server {
	t.Helper()
	static, assetDir := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(static, "index.html"), []byte("<p>hi</p>"), 0o644); err != nil {
		t.Fatal(err)
	}
	for name, b := range assets {
		if err := os.WriteFile(filepath.Join(assetDir, name), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	s, err := Start(Config{HTTPAddr: "127.0.0.1:0", WTAddr: "127.0.0.1:0", StaticDir: static, AssetsDir: assetDir})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func fetchConfig(t *testing.T, s *Server) ClientConfig {
	t.Helper()
	rsp, err := http.Get(s.HTTPURL + "/config.json")
	if err != nil {
		t.Fatal(err)
	}
	defer rsp.Body.Close()
	var cfg ClientConfig
	if err := json.NewDecoder(rsp.Body).Decode(&cfg); err != nil {
		t.Fatal(err)
	}
	return cfg
}

// dial connects the way a browser using serverCertificateHashes would: the
// certificate is trusted only because its SHA-256 matches the advertised hash.
func dial(t *testing.T, cfg ClientConfig, url, origin string) (*http.Response, *webtransport.Session, error) {
	t.Helper()
	want, err := base64.StdEncoding.DecodeString(cfg.CertHash)
	if err != nil {
		t.Fatal(err)
	}
	tr := &webtransport.Transport{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: true,
			VerifyConnection: func(st tls.ConnectionState) error {
				got := sha256.Sum256(st.PeerCertificates[0].Raw)
				if !bytes.Equal(got[:], want) {
					return errors.New("certificate hash mismatch")
				}
				return nil
			},
		},
		QUICConfig: &quic.Config{EnableDatagrams: true, EnableStreamResetPartialDelivery: true},
	}
	t.Cleanup(func() { tr.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return tr.Dial(ctx, url, http.Header{"Origin": {origin}})
}

func TestServesStaticClient(t *testing.T) {
	s := startTestServer(t, nil)
	rsp, err := http.Get(s.HTTPURL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer rsp.Body.Close()
	if rsp.StatusCode != http.StatusOK {
		t.Fatalf("GET /: %s", rsp.Status)
	}
}

func TestDatagramEcho(t *testing.T) {
	s := startTestServer(t, nil)
	cfg := fetchConfig(t, s)
	_, sess, err := dial(t, cfg, cfg.EchoURL, s.HTTPURL)
	if err != nil {
		t.Fatal(err)
	}
	defer sess.CloseWithError(0, "")

	ping := []byte("ping")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Datagrams are unreliable, so resend until the echo arrives.
	for {
		if err := sess.SendDatagram(ping); err != nil {
			t.Fatal(err)
		}
		rctx, rcancel := context.WithTimeout(ctx, 200*time.Millisecond)
		got, err := sess.ReceiveDatagram(rctx)
		rcancel()
		if err == nil {
			if !bytes.Equal(got, ping) {
				t.Fatalf("echo = %q, want %q", got, ping)
			}
			return
		}
		if ctx.Err() != nil {
			t.Fatal("no echo within 5s")
		}
	}
}

func TestRejectsForeignOrigin(t *testing.T) {
	s := startTestServer(t, nil)
	cfg := fetchConfig(t, s)
	rsp, _, err := dial(t, cfg, cfg.WebTransportURL, "https://evil.example")
	if err == nil {
		t.Fatal("session from a foreign origin was accepted")
	}
	if rsp != nil && rsp.StatusCode != http.StatusForbidden {
		t.Errorf("status %d, want 403", rsp.StatusCode)
	}
}

func TestIsLoopbackOrigin(t *testing.T) {
	for origin, want := range map[string]bool{
		"http://127.0.0.1:8080":  true,
		"http://localhost:8080":  true,
		"http://[::1]:8080":      true,
		"http://127.0.0.1:9999":  false, // another local app
		"https://127.0.0.1:8080": false,
		"http://10.0.0.5:8080":   false,
		"":                       false,
	} {
		if got := isLoopbackOrigin(origin, 8080); got != want {
			t.Errorf("isLoopbackOrigin(%q) = %v, want %v", origin, got, want)
		}
	}
}

// An HTTP4 fetch through the real server over real QUIC: REQ with a small
// initial grant, then GRANTs in 16 KiB steps as data arrives (with RESEND if
// the transfer stalls), until the whole asset is in. The server's G2 counter
// must still be 0 afterwards.
func TestHTTP4FetchOverQUIC(t *testing.T) {
	const size = 300_000
	a := make([]byte, size)
	for i := range a {
		a[i] = byte(i * 31)
	}
	s := startTestServer(t, map[string][]byte{"big.bin": a})
	cfg := fetchConfig(t, s)
	_, sess, err := dial(t, cfg, cfg.WebTransportURL, s.HTTPURL)
	if err != nil {
		t.Fatal(err)
	}
	defer sess.CloseWithError(0, "")

	send := func(p wire.Packet) {
		b, err := wire.Marshal(p)
		if err != nil {
			t.Fatal(err)
		}
		if err := sess.SendDatagram(b); err != nil {
			t.Fatal(err)
		}
	}
	const rpc, window = wire.RPCID(0xabc), 16 << 10
	send(&wire.Req{RPCID: rpc, InitialGrant: window, AssetID: "big.bin"})

	buf := make([]byte, size)
	have := make([]bool, size)
	received, granted := 0, uint32(window)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for received < size {
		rctx, rcancel := context.WithTimeout(ctx, 200*time.Millisecond)
		b, err := sess.ReceiveDatagram(rctx)
		rcancel()
		if err != nil {
			if ctx.Err() != nil {
				t.Fatalf("timed out with %d/%d bytes", received, size)
			}
			// Stalled: ask again for the first missing range below the grant.
			start := uint32(0)
			for start < granted && have[start] {
				start++
			}
			end := start
			for end < granted && !have[end] {
				end++
			}
			if start < end {
				send(&wire.Resend{RPCID: rpc, Start: start, End: end})
			} else {
				send(&wire.Req{RPCID: rpc, InitialGrant: window, AssetID: "big.bin"})
			}
			continue
		}
		p, err := wire.Decode(b)
		if err != nil {
			t.Fatal(err)
		}
		d, ok := p.(*wire.Data)
		if !ok || d.RPCID != rpc || d.TotalSize != size {
			t.Fatalf("unexpected packet %+v", p)
		}
		if end := d.Offset + uint32(len(d.Payload)); end > granted {
			t.Fatalf("DATA [%d, %d) past grant %d", d.Offset, end, granted)
		}
		for i, c := range d.Payload {
			if o := int(d.Offset) + i; !have[o] {
				have[o], buf[o] = true, c
				received++
			}
		}
		// Keep one window of grant ahead of what has arrived in order.
		inOrder := uint32(0)
		for inOrder < granted && have[inOrder] {
			inOrder++
		}
		if g := min(inOrder+window, size); g > granted {
			granted = g
			send(&wire.Grant{RPCID: rpc, MaxOffset: granted})
		}
	}
	if !bytes.Equal(buf, a) {
		t.Fatal("reassembled asset differs")
	}
	m := s.Metrics()
	t.Logf("server metrics: %+v", m)
	if m.UngrantedSent != 0 || m.RPCs != 1 {
		t.Errorf("metrics %+v: want 0 un-granted bytes and 1 RPC", m)
	}
}

func TestMetricsEndpoint(t *testing.T) {
	s := startTestServer(t, nil)
	rsp, err := http.Get(s.HTTPURL + "/metrics.json")
	if err != nil {
		t.Fatal(err)
	}
	defer rsp.Body.Close()
	var m map[string]int64
	if err := json.NewDecoder(rsp.Body).Decode(&m); err != nil {
		t.Fatal(err)
	}
	if v, ok := m["ungranted_bytes_sent"]; !ok || v != 0 {
		t.Errorf("metrics.json = %v, want ungranted_bytes_sent: 0", m)
	}
}
