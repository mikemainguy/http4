// Package devcert creates the throwaway TLS certificate the dev server uses for
// WebTransport. Browsers accept it through serverCertificateHashes, which only
// allows ECDSA certificates whose total validity is under 14 days.
package devcert

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"fmt"
	"math/big"
	"net"
	"time"
)

// Validity is the certificate's total lifetime, kept under the 14-day limit
// that serverCertificateHashes enforces.
const Validity = 13 * 24 * time.Hour

// Cert is a generated certificate plus the SHA-256 of its DER encoding, which
// is the value a browser passes in serverCertificateHashes.
type Cert struct {
	TLS  tls.Certificate
	Hash [sha256.Size]byte
}

// Generate creates a fresh P-256 key and a self-signed certificate for
// localhost and the loopback addresses, valid from now for Validity.
func Generate(now time.Time) (*Cert, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate key: %w", err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, fmt.Errorf("generate serial: %w", err)
	}
	// Backdate slightly so small clock differences don't make it "not yet valid",
	// and take that minute out of the end so the total stays within Validity.
	notBefore := now.Add(-time.Minute)
	tmpl := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "localhost"},
		NotBefore:             notBefore,
		NotAfter:              notBefore.Add(Validity),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{"localhost"},
		IPAddresses:           []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback},
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, fmt.Errorf("create certificate: %w", err)
	}
	return &Cert{
		TLS:  tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key},
		Hash: sha256.Sum256(der),
	}, nil
}
