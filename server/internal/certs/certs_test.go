package certs

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"
	"time"
)

func TestParseMode(t *testing.T) {
	for in, want := range map[string]Mode{
		"":                     {Kind: Dev},
		"dev":                  {Kind: Dev},
		"acme":                 {Kind: ACME},
		"file:/c.pem,/k.pem":   {Kind: File, CertFile: "/c.pem", KeyFile: "/k.pem"},
		"file:rel.crt,rel.key": {Kind: File, CertFile: "rel.crt", KeyFile: "rel.key"},
	} {
		got, err := ParseMode(in)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Errorf("ParseMode(%q) = %+v, %v; want %+v", in, got, err, want)
		}
	}
	for _, bad := range []string{"file:", "file:only.pem", "file:,k.pem", "file:c.pem,", "letsencrypt", "FILE:c,k"} {
		if _, err := ParseMode(bad); err == nil {
			t.Errorf("ParseMode(%q) accepted", bad)
		}
	}
}

func TestValidate(t *testing.T) {
	for name, m := range map[string]Mode{
		"dev with a domain":  {Kind: Dev, Domains: []string{"example.com"}},
		"acme with no names": {Kind: ACME, CacheDir: "/tmp/x"},
		"acme with no cache": {Kind: ACME, Domains: []string{"example.com"}},
		"unknown kind":       {Kind: "vault"},
	} {
		if err := m.Validate(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	ok := []Mode{
		{Kind: Dev},
		{},
		{Kind: File, CertFile: "c", KeyFile: "k"},
		{Kind: ACME, Domains: []string{"example.com"}, CacheDir: "/tmp/x"},
	}
	for _, m := range ok {
		if err := m.Validate(); err != nil {
			t.Errorf("%+v: %v", m, err)
		}
	}
}

func TestDevSourcePinsItsHash(t *testing.T) {
	s, err := Open(Mode{})
	if err != nil {
		t.Fatal(err)
	}
	if s.Trusted() {
		t.Error("the dev certificate is not CA-trusted")
	}
	if s.CertHash() == "" || s.SPKIHash() == "" || s.CertHash() == s.SPKIHash() {
		t.Errorf("certHash %q, spkiHash %q: want two distinct hashes", s.CertHash(), s.SPKIHash())
	}
	if len(s.TLS().Certificates) != 1 {
		t.Error("TLS config has no certificate")
	}
	if got := s.Challenge(http.NotFoundHandler()); got == nil {
		t.Error("Challenge dropped the handler outside ACME mode")
	}
}

// writePair writes a self-signed certificate for 127.0.0.1 and returns the
// file paths plus the base64 SHA-256 of its SubjectPublicKeyInfo.
func writePair(t *testing.T, dir, cn string) (certFile, keyFile, spki string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: cn},
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
	certFile = filepath.Join(dir, cn+".crt")
	keyFile = filepath.Join(dir, cn+".key")
	write(t, certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	write(t, keyFile, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}))
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(leaf.RawSubjectPublicKeyInfo)
	return certFile, keyFile, base64.StdEncoding.EncodeToString(sum[:])
}

func write(t *testing.T, path string, b []byte) {
	t.Helper()
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestFileSourceServesAndReloads(t *testing.T) {
	dir := t.TempDir()
	certFile, keyFile, spki := writePair(t, dir, "first")
	s, err := Open(Mode{Kind: File, CertFile: certFile, KeyFile: keyFile})
	if err != nil {
		t.Fatal(err)
	}
	if !s.Trusted() {
		t.Error("a file certificate is served as CA-trusted (the browser decides)")
	}
	if s.CertHash() != "" {
		t.Errorf("certHash = %q, want empty: a real certificate is not pinned", s.CertHash())
	}
	if s.SPKIHash() != spki {
		t.Errorf("spkiHash = %q, want %q", s.SPKIHash(), spki)
	}
	got, err := s.TLS().GetCertificate(&tls.ClientHelloInfo{})
	if err != nil || got == nil {
		t.Fatalf("GetCertificate: %v", err)
	}

	// Renewal: the same paths, new contents, picked up by Reload.
	_, _, spki2 := writePair(t, dir, "second")
	write(t, certFile, read(t, filepath.Join(dir, "second.crt")))
	write(t, keyFile, read(t, filepath.Join(dir, "second.key")))
	if err := s.Reload(); err != nil {
		t.Fatal(err)
	}
	if s.SPKIHash() != spki2 {
		t.Errorf("after reload spkiHash = %q, want the new certificate's %q", s.SPKIHash(), spki2)
	}

	// A broken pair leaves the working certificate in place.
	write(t, certFile, []byte("not a certificate"))
	if err := s.Reload(); err == nil {
		t.Error("Reload accepted a broken certificate")
	}
	if c, err := s.TLS().GetCertificate(&tls.ClientHelloInfo{}); err != nil || c == nil {
		t.Error("a failed reload dropped the old certificate")
	}
}

func read(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestFileSourceRejectsMissingFiles(t *testing.T) {
	if _, err := Open(Mode{Kind: File, CertFile: "/nope/c.pem", KeyFile: "/nope/k.pem"}); err == nil {
		t.Error("Open accepted missing certificate files")
	}
}

// ACME can't be driven against a real CA here, so this covers what is local:
// the manager is built with the cache, host policy and staging directory, its
// TLS config offers acme-tls/1 for TLS-ALPN-01, and its HTTP handler owns the
// challenge path while everything else falls through to the redirect.
func TestACMESourceWiring(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "acme")
	s, err := Open(Mode{Kind: ACME, Domains: []string{"demo.example"}, Email: "ops@demo.example", CacheDir: dir, Staging: true})
	if err != nil {
		t.Fatal(err)
	}
	if !s.Trusted() || s.CertHash() != "" || s.SPKIHash() != "" {
		t.Errorf("trusted %v, certHash %q, spkiHash %q: want trusted with no hashes", s.Trusted(), s.CertHash(), s.SPKIHash())
	}
	if _, err := os.Stat(dir); err != nil {
		t.Errorf("cache directory not created: %v", err)
	}
	if s.mgr.Client == nil || s.mgr.Client.DirectoryURL != StagingDirectory {
		t.Error("-acme-staging did not select the staging directory")
	}
	if err := s.mgr.HostPolicy(t.Context(), "evil.example"); err == nil {
		t.Error("host policy allows a name outside -domain")
	}
	if err := s.mgr.HostPolicy(t.Context(), "demo.example"); err != nil {
		t.Errorf("host policy rejects its own -domain: %v", err)
	}
	if !slices.Contains(s.TLS().NextProtos, "acme-tls/1") {
		t.Errorf("NextProtos %v: want acme-tls/1 so TLS-ALPN-01 works", s.TLS().NextProtos)
	}

	fallback := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	h := s.Challenge(fallback)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/.well-known/acme-challenge/token", nil))
	if rec.Code == http.StatusTeapot {
		t.Error("the challenge path fell through to the redirect handler")
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/page", nil))
	if rec.Code != http.StatusTeapot {
		t.Errorf("ordinary path: %d, want the wrapped handler to run", rec.Code)
	}
}
