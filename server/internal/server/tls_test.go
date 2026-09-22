package server

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"http4/server/internal/certs"
	"http4/server/internal/sender"
)

// writeCertPair writes a self-signed certificate for localhost and the
// loopback addresses, standing in for a CA-issued one: from the server's side
// the only difference is that the browser, not the page, decides to trust it.
func writeCertPair(t *testing.T) (certFile, keyFile string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := x509.Certificate{
		SerialNumber:          big.NewInt(2),
		Subject:               pkix.Name{CommonName: "localhost"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{"localhost"},
		IPAddresses:           []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback},
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	certFile, keyFile = filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	if err := os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	return certFile, keyFile
}

// secure is a server with a CA-validated certificate, the client that trusts
// it, and the certificate's path (a client that verifies the chain needs it).
type secure struct {
	*Server
	client   *http.Client
	certFile string
}

// startSecure runs a site-mode server with a real certificate, plus an
// https client that accepts it.
func startSecure(t *testing.T, extra func(*Config)) secure {
	t.Helper()
	site := t.TempDir()
	if err := os.WriteFile(filepath.Join(site, "index.html"), []byte("<p>hi</p>"), 0o644); err != nil {
		t.Fatal(err)
	}
	certFile, keyFile := writeCertPair(t)
	cfg := Config{
		HTTPAddr: "127.0.0.1:0", WTAddr: "127.0.0.1:0", SiteDir: site,
		Cert: certs.Mode{Kind: certs.File, CertFile: certFile, KeyFile: keyFile},
	}
	if extra != nil {
		extra(&cfg)
	}
	s, err := Start(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	t.Cleanup(client.CloseIdleConnections)
	return secure{s, client, certFile}
}

func TestRealCertificateServesHTTPSAndDropsThePin(t *testing.T) {
	sec := startSecure(t, nil)
	s, client := sec.Server, sec.client
	if !strings.HasPrefix(s.HTTPURL, "https://") {
		t.Fatalf("HTTPURL = %q, want https", s.HTTPURL)
	}
	rsp, err := client.Get(s.HTTPURL + "/")
	if err != nil {
		t.Fatal(err)
	}
	rsp.Body.Close()
	if rsp.StatusCode != http.StatusOK || rsp.TLS == nil {
		t.Fatalf("GET /: %s, TLS %v", rsp.Status, rsp.TLS != nil)
	}

	rsp, err = client.Get(s.HTTPURL + "/config.json")
	if err != nil {
		t.Fatal(err)
	}
	defer rsp.Body.Close()
	var raw map[string]any
	if err := json.NewDecoder(rsp.Body).Decode(&raw); err != nil {
		t.Fatal(err)
	}
	// The browser validates a real certificate itself: no hash to pin, and
	// an empty string would be worse than absent (the client would try to
	// pin it), so the field must be missing entirely.
	if _, ok := raw["certHash"]; ok {
		t.Errorf("config.json still advertises certHash: %v", raw)
	}
	if got := raw["webTransportUrl"]; got == nil || !strings.HasPrefix(got.(string), "https://") {
		t.Errorf("webTransportUrl = %v", got)
	}
}

func TestDevCertificateStillPinsAndStaysOnHTTP(t *testing.T) {
	s := startTestServer(t, nil)
	if !strings.HasPrefix(s.HTTPURL, "http://") {
		t.Errorf("HTTPURL = %q, want plain http in dev mode", s.HTTPURL)
	}
	if cfg := fetchConfig(t, s); cfg.CertHash == "" {
		t.Error("dev mode must advertise certHash: the browser has no other way to trust it")
	}
}

func TestOriginAllowlist(t *testing.T) {
	s := startSecure(t, func(c *Config) { c.Origins = []string{"https://demo.example", "https://alt.example:8443"} }).Server
	own := s.HTTPURL // https://127.0.0.1:<port>
	for origin, want := range map[string]bool{
		own:                         true,  // the page this server serves
		"https://demo.example":      true,  // allowlisted
		"https://demo.example:443":  true,  // same origin, explicit default port
		"https://alt.example:8443":  true,  // allowlisted with a port
		"https://alt.example":       false, // different port
		"http://demo.example":       false, // different scheme
		"https://evil.example":      false,
		"https://demo.example.evil": false,
		"":                          false,
	} {
		r := httptest.NewRequest(http.MethodGet, "/wt", nil)
		r.Header.Set("Origin", origin)
		if got := s.allowedOrigin(r); got != want {
			t.Errorf("allowedOrigin(%q) = %v, want %v", origin, got, want)
		}
	}
}

func TestOriginAllowlistRejectsMalformedFlags(t *testing.T) {
	for _, bad := range []string{"demo.example", "https://", "https://demo.example/path", "ftp://demo.example", "https://u:p@demo.example"} {
		if _, err := normaliseOrigins([]string{bad}); err == nil {
			t.Errorf("-origin %q accepted", bad)
		}
	}
}

func TestMetricsAccess(t *testing.T) {
	for _, tc := range []struct {
		access MetricsAccess
		remote string
		want   int
	}{
		{MetricsPublic, "203.0.113.7:1234", http.StatusOK},
		{MetricsPublic, "127.0.0.1:1234", http.StatusOK},
		{MetricsLocal, "127.0.0.1:1234", http.StatusOK},
		{MetricsLocal, "[::1]:1234", http.StatusOK},
		{MetricsLocal, "203.0.113.7:1234", http.StatusNotFound},
		{MetricsOff, "127.0.0.1:1234", http.StatusNotFound},
	} {
		s := &Server{metricsTo: tc.access, metrics: new(sender.Metrics)}
		r := httptest.NewRequest(http.MethodGet, "/metrics.json", nil)
		r.RemoteAddr = tc.remote
		rec := httptest.NewRecorder()
		s.handleMetrics(rec, r)
		if rec.Code != tc.want {
			t.Errorf("access %v from %s: %d, want %d", tc.access, tc.remote, rec.Code, tc.want)
		}
	}
}

func TestRedirectToHTTPS(t *testing.T) {
	for _, tc := range []struct {
		port             int
		host, path, want string
	}{
		{443, "demo.example", "/a/b?c=1", "https://demo.example/a/b?c=1"},
		{443, "demo.example:80", "/", "https://demo.example/"},
		{8443, "127.0.0.1:8080", "/x", "https://127.0.0.1:8443/x"},
	} {
		s := &Server{httpPort: tc.port}
		r := httptest.NewRequest(http.MethodGet, tc.path, nil)
		r.Host = tc.host
		rec := httptest.NewRecorder()
		s.redirectToHTTPS(rec, r)
		if rec.Code != http.StatusMovedPermanently || rec.Header().Get("Location") != tc.want {
			t.Errorf("%s%s: %d %q, want 301 %q", tc.host, tc.path, rec.Code, rec.Header().Get("Location"), tc.want)
		}
	}
}

func TestRedirectListenerRedirects(t *testing.T) {
	s := startSecure(t, func(c *Config) { c.RedirectAddr = "127.0.0.1:0" }).Server
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	rsp, err := client.Get("http://" + s.redirectLn.Addr().String() + "/page?x=1")
	if err != nil {
		t.Fatal(err)
	}
	rsp.Body.Close()
	if rsp.StatusCode != http.StatusMovedPermanently {
		t.Fatalf("status %s, want 301", rsp.Status)
	}
	if loc := rsp.Header.Get("Location"); !strings.HasPrefix(loc, "https://") || !strings.HasSuffix(loc, "/page?x=1") {
		t.Errorf("Location = %q", loc)
	}
}

func TestRedirectNeedsRealCertificate(t *testing.T) {
	_, err := Start(Config{HTTPAddr: "127.0.0.1:0", WTAddr: "127.0.0.1:0", SiteDir: t.TempDir(), RedirectAddr: "127.0.0.1:0"})
	if err == nil {
		t.Error("a redirect listener with the dev certificate was accepted")
	}
}

// Start immediately followed by Close, with no traffic in between: the window
// where closing the WebTransport server raced its own Serve (vrek
// iss-ag6h0a6). Close now closes the socket and waits for Serve to return.
func TestStartCloseImmediately(t *testing.T) {
	for range 8 {
		s, err := Start(Config{HTTPAddr: "127.0.0.1:0", WTAddr: "127.0.0.1:0", SiteDir: t.TempDir()})
		if err != nil {
			t.Fatal(err)
		}
		if err := s.Close(); err != nil {
			t.Fatalf("close: %v", err)
		}
	}
}
