package devcert

import (
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"net"
	"testing"
	"time"
)

func TestGenerateMeetsServerCertificateHashesRules(t *testing.T) {
	now := time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)
	c, err := Generate(now)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(c.TLS.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}

	if _, ok := leaf.PublicKey.(*ecdsa.PublicKey); !ok {
		t.Errorf("public key is %T, want ECDSA", leaf.PublicKey)
	}
	if life := leaf.NotAfter.Sub(leaf.NotBefore); life >= 14*24*time.Hour {
		t.Errorf("validity %v, must be under 14 days", life)
	}
	if now.Before(leaf.NotBefore) || now.After(leaf.NotAfter) {
		t.Errorf("not valid at generation time: %v..%v", leaf.NotBefore, leaf.NotAfter)
	}
	if got := sha256.Sum256(leaf.Raw); got != c.Hash {
		t.Errorf("Hash does not match SHA-256 of the certificate DER")
	}
	if err := leaf.VerifyHostname("127.0.0.1"); err != nil {
		t.Errorf("127.0.0.1: %v", err)
	}
	if !leaf.IPAddresses[1].Equal(net.IPv6loopback) {
		t.Errorf("missing ::1 SAN")
	}
}

func TestGenerateIsFreshEachTime(t *testing.T) {
	now := time.Now()
	a, err := Generate(now)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Generate(now)
	if err != nil {
		t.Fatal(err)
	}
	if a.Hash == b.Hash {
		t.Error("two generations produced the same certificate")
	}
}
