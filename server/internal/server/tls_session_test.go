package server

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/webtransport-go"

	"http4/server/internal/wire"
)

// A WebTransport session over a CA-validated certificate: no hash pinning
// anywhere, the client verifying the chain the way a browser does with a real
// certificate. Chrome can't stand in for this locally — it refuses WebTransport
// to a certificate it doesn't genuinely trust, even with
// --ignore-certificate-errors — so tests/tls covers the HTTPS page and the
// fallback, and this covers the session itself.
func TestWebTransportWithoutPinning(t *testing.T) {
	sec := startSecure(t, nil)
	rsp, err := sec.client.Get(sec.HTTPURL + "/config.json")
	if err != nil {
		t.Fatal(err)
	}
	var cfg ClientConfig
	err = json.NewDecoder(rsp.Body).Decode(&cfg)
	rsp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CertHash != "" {
		t.Fatalf("certHash = %q, want none", cfg.CertHash)
	}

	// Trusting the leaf as a root is what a CA chain amounts to here.
	pool := x509.NewCertPool()
	pem, err := os.ReadFile(sec.certFile)
	if err != nil {
		t.Fatal(err)
	}
	if !pool.AppendCertsFromPEM(pem) {
		t.Fatal("no certificate in the PEM file")
	}
	tr := &webtransport.Transport{
		TLSClientConfig: &tls.Config{RootCAs: pool, ServerName: "localhost"},
		QUICConfig:      &quic.Config{EnableDatagrams: true, EnableStreamResetPartialDelivery: true},
	}
	defer tr.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	_, sess, err := tr.Dial(ctx, cfg.WebTransportURL, http.Header{"Origin": {sec.HTTPURL}})
	if err != nil {
		t.Fatalf("dial without pinning: %v", err)
	}
	defer sess.CloseWithError(0, "")

	req, err := wire.Marshal(&wire.Req{RPCID: 1, InitialGrant: 1 << 16, AssetID: "index.html"})
	if err != nil {
		t.Fatal(err)
	}
	if err := sess.SendDatagram(req); err != nil {
		t.Fatal(err)
	}
	var body []byte
	var total uint32
	deadline := time.Now().Add(10 * time.Second)
	for len(body) == 0 || uint32(len(body)) < total {
		if time.Now().After(deadline) {
			t.Fatalf("got %d of %d bytes", len(body), total)
		}
		rctx, rcancel := context.WithTimeout(ctx, time.Second)
		b, err := sess.ReceiveDatagram(rctx)
		rcancel()
		if err != nil {
			t.Fatalf("no data: %v", err)
		}
		p, err := wire.Decode(b)
		if err != nil {
			t.Fatal(err)
		}
		d, ok := p.(*wire.Data)
		if !ok {
			continue // META arrives first; only the body matters here
		}
		total = d.TotalSize
		if int(d.Offset) == len(body) {
			body = append(body, d.Payload...)
		}
	}
	if want := "<p>hi</p>"; string(body) != want {
		t.Fatalf("body %q, want %q", body, want)
	}
	if m := sec.Metrics(); m.UngrantedSent != 0 {
		t.Errorf("un-granted bytes: %d", m.UngrantedSent)
	}
}
