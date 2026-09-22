package main

import (
	"bytes"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"http4/server/internal/certs"
	"http4/server/internal/server"
)

func TestParseServeCertModes(t *testing.T) {
	site := t.TempDir()
	cache := filepath.Join(t.TempDir(), "acme")
	cfg, err := parseServe([]string{"-cert", "file:/etc/c.pem,/etc/k.pem", site}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Cert.Kind != certs.File || cfg.Cert.CertFile != "/etc/c.pem" || cfg.Cert.KeyFile != "/etc/k.pem" {
		t.Errorf("file mode: %+v", cfg.Cert)
	}
	// -redirect defaults to off for a file certificate: nothing needs port 80.
	if cfg.RedirectAddr != "" {
		t.Errorf("file mode redirect = %q, want off by default", cfg.RedirectAddr)
	}

	cfg, err = parseServe([]string{
		"-cert", "acme", "-domain", "demo.example", "-domain", "www.demo.example",
		"-acme-email", "ops@demo.example", "-acme-cache", cache, "-acme-staging", site,
	}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	m := cfg.Cert
	if m.Kind != certs.ACME || !slices.Equal(m.Domains, []string{"demo.example", "www.demo.example"}) ||
		m.Email != "ops@demo.example" || m.CacheDir != cache || !m.Staging {
		t.Errorf("acme mode: %+v", m)
	}
	// ACME answers HTTP-01 there, so it defaults on.
	if cfg.RedirectAddr != ":80" {
		t.Errorf("acme redirect = %q, want :80", cfg.RedirectAddr)
	}
}

func TestParseServeOriginsAndMetrics(t *testing.T) {
	site := t.TempDir()
	cfg, err := parseServe([]string{"-origin", "https://demo.example", "-origin", "https://www.demo.example", "-metrics", "off", site}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(cfg.Origins, []string{"https://demo.example", "https://www.demo.example"}) {
		t.Errorf("origins = %v", cfg.Origins)
	}
	if cfg.Metrics != server.MetricsOff {
		t.Errorf("metrics = %v, want off", cfg.Metrics)
	}
	// Serve keeps counters to loopback unless asked otherwise.
	cfg, err = parseServe([]string{site}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Metrics != server.MetricsLocal {
		t.Errorf("default metrics = %v, want local", cfg.Metrics)
	}
}

func TestParseServeRejectsBadTLSCombinations(t *testing.T) {
	site := t.TempDir()
	for name, args := range map[string][]string{
		"acme without domain": {"-cert", "acme", "-acme-cache", t.TempDir(), site},
		"acme without cache":  {"-cert", "acme", "-domain", "demo.example", site},
		"domain without acme": {"-domain", "demo.example", site},
		"file without key":    {"-cert", "file:/etc/c.pem", site},
		"unknown cert mode":   {"-cert", "vault", site},
		"redirect on dev":     {"-redirect", ":8081", site},
		"unknown metrics":     {"-metrics", "sometimes", site},
	} {
		if _, err := parseServe(args, &bytes.Buffer{}); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestParseServeWarnsAboutLoopbackWithRealCert(t *testing.T) {
	site := t.TempDir()
	dir := t.TempDir()
	cert, key := filepath.Join(dir, "c.pem"), filepath.Join(dir, "k.pem")
	os.WriteFile(cert, nil, 0o600)
	os.WriteFile(key, nil, 0o600)
	var out bytes.Buffer
	if _, err := parseServe([]string{"-cert", "file:" + cert + "," + key, site}, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "WARNING") {
		t.Errorf("no warning about loopback addresses with a real certificate:\n%s", out.String())
	}
}
