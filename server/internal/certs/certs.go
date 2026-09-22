// Package certs obtains the TLS certificate the server presents on both of its
// listeners (TCP for pages, QUIC for HTTP4 and HTTP/3), and says how a browser
// is meant to trust it (vrek iss-fzz5beq).
//
//   - dev:  a throwaway self-signed certificate, trusted only because the page
//     hands its hash to WebTransport (serverCertificateHashes). Localhost only:
//     ordinary fetches and Service Workers reject it, so pages stay on plain
//     HTTP, which counts as a secure context on loopback.
//   - file: a certificate and key in PEM files, e.g. one a separate ACME client
//     renews. Reloaded on SIGHUP.
//   - acme: certificates obtained and renewed automatically from an ACME CA
//     (Let's Encrypt by default) via autocert.
//
// file and acme chain to a real CA, so the browser validates normally, no hash
// is advertised, and the page itself is served over HTTPS.
package certs

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/acme"
	"golang.org/x/crypto/acme/autocert"

	"http4/server/internal/devcert"
)

// Kind is where certificates come from.
type Kind string

const (
	Dev  Kind = "dev"
	File Kind = "file"
	ACME Kind = "acme"
)

// StagingDirectory is Let's Encrypt's staging endpoint, for rehearsing a
// deployment without spending the production rate limit.
const StagingDirectory = "https://acme-staging-v02.api.letsencrypt.org/directory"

// Mode is a parsed -cert flag plus its options. The zero value is Dev.
type Mode struct {
	Kind     Kind
	CertFile string   // File
	KeyFile  string   // File
	Domains  []string // ACME: the names to get certificates for
	Email    string   // ACME: contact address for expiry notices
	CacheDir string   // ACME: where accounts and certificates are stored
	Staging  bool     // ACME: use StagingDirectory
}

// ParseMode parses a -cert flag value: "dev", "file:<cert.pem>,<key.pem>" or
// "acme". The ACME options come from their own flags.
func ParseMode(s string) (Mode, error) {
	switch {
	case s == "" || s == string(Dev):
		return Mode{Kind: Dev}, nil
	case s == string(ACME):
		return Mode{Kind: ACME}, nil
	case strings.HasPrefix(s, "file:"):
		cert, key, ok := strings.Cut(strings.TrimPrefix(s, "file:"), ",")
		if !ok || cert == "" || key == "" {
			return Mode{}, fmt.Errorf("-cert %q: want file:<cert.pem>,<key.pem>", s)
		}
		return Mode{Kind: File, CertFile: cert, KeyFile: key}, nil
	}
	return Mode{}, fmt.Errorf("-cert %q: want dev, file:<cert.pem>,<key.pem> or acme", s)
}

// Validate checks a mode's options without touching disk or the network, so
// `http4d serve` can reject a bad combination before it binds anything.
func (m Mode) Validate() error {
	switch m.Kind {
	case "", Dev:
		if len(m.Domains) > 0 {
			return errors.New("-domain needs -cert acme")
		}
	case File:
		if m.CertFile == "" || m.KeyFile == "" {
			return errors.New("-cert file: needs <cert.pem>,<key.pem>")
		}
	case ACME:
		if len(m.Domains) == 0 {
			return errors.New("-cert acme needs at least one -domain")
		}
		if m.CacheDir == "" {
			return errors.New("-cert acme needs -acme-cache: without it every restart asks the CA again and hits its rate limit")
		}
	default:
		return fmt.Errorf("certificate mode %q: want dev, file or acme", m.Kind)
	}
	return nil
}

// Source hands the same certificate to both listeners.
type Source struct {
	mode Mode
	dev  *devcert.Cert                   // Dev
	pair atomic.Pointer[tls.Certificate] // File, swapped by Reload
	mgr  *autocert.Manager               // ACME
	spki string                          // base64 SHA-256 of the leaf's SubjectPublicKeyInfo, if known
}

// Open validates the mode and loads whatever it can up front, so a bad
// certificate fails at startup rather than on the first connection.
func Open(m Mode) (*Source, error) {
	if err := m.Validate(); err != nil {
		return nil, err
	}
	s := &Source{mode: m}
	switch m.Kind {
	case "", Dev:
		s.mode.Kind = Dev
		c, err := devcert.Generate(time.Now())
		if err != nil {
			return nil, err
		}
		s.dev = c
		s.spki = base64.StdEncoding.EncodeToString(c.SPKIHash[:])

	case File:
		if err := s.Reload(); err != nil {
			return nil, err
		}

	case ACME:
		if err := os.MkdirAll(m.CacheDir, 0o700); err != nil {
			return nil, fmt.Errorf("-acme-cache: %w", err)
		}
		s.mgr = &autocert.Manager{
			Prompt:     autocert.AcceptTOS,
			Cache:      autocert.DirCache(m.CacheDir),
			HostPolicy: autocert.HostWhitelist(m.Domains...),
			Email:      m.Email,
		}
		if m.Staging {
			s.mgr.Client = &acme.Client{DirectoryURL: StagingDirectory}
		}

	}
	return s, nil
}

// Trusted reports whether browsers validate this certificate themselves. When
// they don't (dev), the page must pin CertHash and can only use WebTransport.
func (s *Source) Trusted() bool { return s.mode.Kind != Dev }

// Kind is the mode this source was opened in.
func (s *Source) Kind() Kind { return s.mode.Kind }

// TLS returns a config for one listener. Each caller gets its own copy,
// because http3.ConfigureTLSConfig rewrites NextProtos.
func (s *Source) TLS() *tls.Config {
	switch s.mode.Kind {
	case File:
		return &tls.Config{GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
			return s.pair.Load(), nil
		}}
	case ACME:
		// Includes acme-tls/1 in NextProtos, so the TCP listener can answer a
		// TLS-ALPN-01 challenge as well as HTTP-01 on the redirect listener.
		return s.mgr.TLSConfig()
	default:
		return &tls.Config{Certificates: []tls.Certificate{s.dev.TLS}}
	}
}

// CertHash is the base64 SHA-256 of the certificate's DER, which a browser
// passes in serverCertificateHashes. Empty unless pinning is required, so
// /config.json simply omits it for a real certificate.
func (s *Source) CertHash() string {
	if s.mode.Kind != Dev {
		return ""
	}
	return base64.StdEncoding.EncodeToString(s.dev.Hash[:])
}

// SPKIHash is the base64 SHA-256 of the leaf's SubjectPublicKeyInfo, which
// Chrome's --ignore-certificate-errors-spki-list takes. It is known up front
// for dev and file certificates, and empty for ACME (the certificate arrives
// later).
func (s *Source) SPKIHash() string { return s.spki }

// Reload re-reads a file-mode certificate, e.g. on SIGHUP after renewal. It is
// a no-op in other modes, and leaves the old certificate in place on error.
func (s *Source) Reload() error {
	if s.mode.Kind != File {
		return nil
	}
	pair, err := tls.LoadX509KeyPair(s.mode.CertFile, s.mode.KeyFile)
	if err != nil {
		return fmt.Errorf("certificate %s / key %s: %w", s.mode.CertFile, s.mode.KeyFile, err)
	}
	if leaf, err := x509.ParseCertificate(pair.Certificate[0]); err == nil {
		sum := sha256.Sum256(leaf.RawSubjectPublicKeyInfo)
		s.spki = base64.StdEncoding.EncodeToString(sum[:])
	}
	s.pair.Store(&pair)
	return nil
}

// Challenge wraps next with the ACME HTTP-01 handler, so the plain-HTTP
// listener answers /.well-known/acme-challenge/ and redirects everything else.
// Outside ACME mode it returns next unchanged.
func (s *Source) Challenge(next http.Handler) http.Handler {
	if s.mode.Kind != ACME {
		return next
	}
	return s.mgr.HTTPHandler(next)
}
