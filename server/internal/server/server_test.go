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
)

func startTestServer(t *testing.T) *Server {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<p>hi</p>"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := Start(Config{HTTPAddr: "127.0.0.1:0", WTAddr: "127.0.0.1:0", StaticDir: dir})
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
func dial(t *testing.T, cfg ClientConfig, origin string) (*http.Response, *webtransport.Session, error) {
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
	return tr.Dial(ctx, cfg.WebTransportURL, http.Header{"Origin": {origin}})
}

func TestServesStaticClient(t *testing.T) {
	s := startTestServer(t)
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
	s := startTestServer(t)
	_, sess, err := dial(t, fetchConfig(t, s), s.HTTPURL)
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
	s := startTestServer(t)
	rsp, _, err := dial(t, fetchConfig(t, s), "https://evil.example")
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
