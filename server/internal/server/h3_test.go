package server

import (
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/quic-go/quic-go/http3"
)

// h3Client talks plain HTTP/3 to the server, trusting its certificate only by
// the SPKI hash advertised in config.json, the way Chrome does with
// --ignore-certificate-errors-spki-list.
func h3Client(t *testing.T, cfg ClientConfig) *http.Client {
	t.Helper()
	want, err := base64.StdEncoding.DecodeString(cfg.SPKIHash)
	if err != nil {
		t.Fatal(err)
	}
	tr := &http3.Transport{TLSClientConfig: &tls.Config{
		InsecureSkipVerify: true,
		VerifyConnection: func(st tls.ConnectionState) error {
			got := sha256.Sum256(st.PeerCertificates[0].RawSubjectPublicKeyInfo)
			if !bytes.Equal(got[:], want) {
				return errors.New("SPKI hash mismatch")
			}
			return nil
		},
	}}
	t.Cleanup(func() { tr.Close() })
	return &http.Client{Transport: tr}
}

func h3Get(t *testing.T, c *http.Client, url, origin string) (*http.Response, []byte) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	rsp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer rsp.Body.Close()
	b, err := io.ReadAll(rsp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return rsp, b
}

func TestH3ServesAssetsWithMetadataAndCORS(t *testing.T) {
	css := []byte("body { color: red }")
	s := startTestServer(t, map[string][]byte{"style.css": css, "data.bin": make([]byte, 100_000)})
	cfg := fetchConfig(t, s)
	if !strings.HasSuffix(cfg.H3URL, H3Path) || !strings.HasPrefix(cfg.H3URL, "https://") {
		t.Fatalf("h3Url = %q", cfg.H3URL)
	}
	c := h3Client(t, cfg)

	rsp, body := h3Get(t, c, cfg.H3URL+"style.css?r=1", s.HTTPURL)
	if rsp.StatusCode != http.StatusOK || !bytes.Equal(body, css) {
		t.Fatalf("GET style.css: %s, %q", rsp.Status, body)
	}
	if rsp.Proto != "HTTP/3.0" {
		t.Errorf("proto %q, want HTTP/3.0", rsp.Proto)
	}
	for k, want := range map[string]string{
		"Content-Type":                "text/css; charset=utf-8",
		"Access-Control-Allow-Origin": s.HTTPURL,
		"Timing-Allow-Origin":         s.HTTPURL,
		"Cache-Control":               "no-store",
	} {
		if got := rsp.Header.Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	if rsp.Header.Get("ETag") == "" {
		t.Error("no ETag")
	}

	rsp, body = h3Get(t, c, cfg.H3URL+"data.bin", "")
	if rsp.StatusCode != http.StatusOK || len(body) != 100_000 {
		t.Fatalf("GET data.bin: %s, %d bytes", rsp.Status, len(body))
	}
}

func TestH3RefusesForeignOriginsCORS(t *testing.T) {
	s := startTestServer(t, map[string][]byte{"a.txt": []byte("a")})
	cfg := fetchConfig(t, s)
	rsp, _ := h3Get(t, h3Client(t, cfg), cfg.H3URL+"a.txt", "https://evil.example")
	// The bytes are public test assets, but a foreign page must not be able
	// to read them or their timing.
	if v := rsp.Header.Get("Access-Control-Allow-Origin"); v != "" {
		t.Errorf("ACAO %q for a foreign origin", v)
	}
	if v := rsp.Header.Get("Timing-Allow-Origin"); v != "" {
		t.Errorf("TAO %q for a foreign origin", v)
	}
}

func TestH3PathSafetyAndMethods(t *testing.T) {
	s := startTestServer(t, map[string][]byte{"a.txt": []byte("a")})
	cfg := fetchConfig(t, s)
	c := h3Client(t, cfg)
	base := strings.TrimSuffix(cfg.H3URL, H3Path)
	for _, p := range []string{
		H3Path + "missing.txt",
		H3Path + "../go.mod",
		H3Path + "%2e%2e/%2e%2e/go.mod",
		H3Path + "..%2f..%2fgo.mod",
		H3Path + "/etc/passwd",
		H3Path,
	} {
		rsp, _ := h3Get(t, c, base+p, "")
		// http.ServeMux may clean ".." paths with a redirect; either way
		// nothing outside the asset directory is served.
		if rsp.StatusCode == http.StatusOK {
			t.Errorf("GET %s: %s, want not found", p, rsp.Status)
		}
	}
	req, _ := http.NewRequest(http.MethodPost, cfg.H3URL+"a.txt", nil)
	rsp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	rsp.Body.Close()
	if rsp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST: %s, want 405", rsp.Status)
	}
}

func TestSPKIHashMatchesCertificate(t *testing.T) {
	s := startTestServer(t, nil)
	cfg := fetchConfig(t, s)
	want := s.cert.SPKIHash()
	if cfg.SPKIHash != want || cfg.SPKIHash == cfg.CertHash {
		t.Fatalf("spkiHash %q, want %q (and distinct from certHash)", cfg.SPKIHash, want)
	}
}
