package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"http4/server/internal/certs"
	"http4/server/internal/clientdist"
	"http4/server/internal/server"
)

const serveUsage = `Usage: http4d serve [flags] <site-dir>

Serves a static site from one directory. Every file is also an HTTP4 asset
(WebTransport datagrams, asset ID = its path), and the same files stay
available over HTTP(S) by the same path as the fallback. The HTTP4 client is
served at /http4/http4.js, its Service Worker at /http4-sw.js, and connection
settings at /config.json.

With -cert dev (the default) pages are plain HTTP on loopback, which browsers
treat as a secure context. A real certificate (-cert file:… or -cert acme)
serves pages over HTTPS, which a public deployment needs: see deploy/README.md.

Flags go before <site-dir>.
`

// testingFlags are listed separately in the usage text.
var testingFlags = map[string]bool{"drop": true, "advertise-wt": true}

// repeated collects a flag given more than once, e.g. -domain.
type repeated []string

func (r *repeated) String() string     { return strings.Join(*r, ",") }
func (r *repeated) Set(v string) error { *r = append(*r, v); return nil }

// parseServe turns `http4d serve` arguments into a server config. It returns
// flag.ErrHelp after printing usage for -h.
func parseServe(args []string, out io.Writer) (server.Config, error) {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(out)
	httpAddr := fs.String("http", "127.0.0.1:8080", "TCP `address` for pages, the fallback and /config.json (HTTPS with a real certificate)")
	wtAddr := fs.String("wt", "127.0.0.1:4433", "UDP `address` for HTTP4 over WebTransport (and HTTP/3 with -h3)")
	cert := fs.String("cert", "dev", "certificate `mode`:\ndev: a fresh self-signed certificate each start, trusted by pinning its hash\n  (serverCertificateHashes); localhost only, and only WebTransport\nfile:<cert.pem>,<key.pem>: a real certificate from disk, reloaded on SIGHUP\nacme: obtained and renewed from an ACME CA; needs -domain and -acme-cache")
	var domains repeated
	fs.Var(&domains, "domain", "with -cert acme, a `hostname` to get a certificate for (repeat for more)")
	acmeEmail := fs.String("acme-email", "", "with -cert acme, a contact `address` for the CA's expiry notices")
	acmeCache := fs.String("acme-cache", "", "with -cert acme, the `directory` holding the ACME account and certificates")
	acmeStaging := fs.Bool("acme-staging", false, "with -cert acme, use Let's Encrypt staging: untrusted certificates, but no production rate limit")
	redirect := fs.String("redirect", "", "TCP `address` for a plain-HTTP listener that only redirects to HTTPS and answers\nACME HTTP-01. Default :80 with -cert acme (which needs it), off otherwise; \"off\" disables")
	var origins repeated
	fs.Var(&origins, "origin", "extra page `origin` allowed to open HTTP4 sessions, e.g. https://demo.example\n(repeat for more). The server's own loopback origin is always allowed")
	metrics := fs.String("metrics", "local", "who may read /metrics.json: `off|local|public` (local = loopback clients only)")
	h3 := fs.Bool("h3", false, "also serve the site over plain HTTP/3 at /h3/ on the -wt port (the benchmark baseline)")
	altSvc := fs.Bool("alt-svc", false, "advertise HTTP/3 on the -wt port, so browsers upgrade this origin on their own.\nApplies to the WHOLE origin, so it moves the plain-HTTP comparison from HTTP/2\nto HTTP/3: say which baseline a measurement used. Needs a trusted certificate")
	clientDir := fs.String("client-dir", "", "serve /http4/ from this `directory` (e.g. client/dist) instead of the built-in bundle")
	drop := fs.String("drop", "", "drop outgoing DATA to simulate loss: a `spec` like every=7,packet0,final,rate=0.05,seed=1")
	advertiseWT := fs.String("advertise-wt", "", "advertise this `host:port` for WebTransport, e.g. an impairment proxy")
	noSeq := fs.Bool("no-seq", false, "don't negotiate session sequence numbers (wire v2); send plain v1 DATA to every client")
	sendQueue := fs.Int("send-queue", 0, "datagrams of bulk to leave in QUIC's send queue ahead of the sender's next pick; 0 or negative = don't pace")
	fs.Usage = func() {
		fmt.Fprint(out, serveUsage, "\nFlags:\n")
		printFlags(fs, out, false)
		fmt.Fprint(out, "\nTesting only:\n")
		printFlags(fs, out, true)
	}
	if err := fs.Parse(args); err != nil {
		return server.Config{}, err
	}
	if fs.NArg() != 1 {
		fs.Usage()
		return server.Config{}, fmt.Errorf("want exactly one <site-dir> after the flags, got %d arguments", fs.NArg())
	}
	site := fs.Arg(0)
	if st, err := os.Stat(site); err != nil || !st.IsDir() {
		return server.Config{}, fmt.Errorf("site %q is not a directory", site)
	}

	mode, err := certs.ParseMode(*cert)
	if err != nil {
		return server.Config{}, err
	}
	mode.Domains, mode.Email, mode.CacheDir, mode.Staging = domains, *acmeEmail, *acmeCache, *acmeStaging
	if err := mode.Validate(); err != nil {
		return server.Config{}, err
	}
	access, err := metricsAccess(*metrics)
	if err != nil {
		return server.Config{}, err
	}
	redirectAddr, err := redirectAddr(*redirect, mode.Kind)
	if err != nil {
		return server.Config{}, err
	}

	client := clientdist.FS()
	if *clientDir != "" {
		client = os.DirFS(*clientDir)
		if !clientdist.Built(client) {
			return server.Config{}, fmt.Errorf("-client-dir %q has no %s", *clientDir, clientdist.Entry)
		}
	} else if !clientdist.Built(client) {
		fmt.Fprintf(out, "http4d serve: WARNING: no client bundle built in; /http4/ will answer 503 (run `npm run build` before building http4d, or pass -client-dir)\n")
	}
	if mode.Kind != certs.Dev && strings.HasPrefix(*httpAddr, "127.0.0.1:") && strings.HasPrefix(*wtAddr, "127.0.0.1:") {
		fmt.Fprintf(out, "http4d serve: WARNING: -cert %s with loopback -http/-wt addresses; a deployment wants -http :443 -wt :443\n", mode.Kind)
	}
	return server.Config{
		HTTPAddr:        *httpAddr,
		WTAddr:          *wtAddr,
		SiteDir:         site,
		ClientFS:        client,
		NoH3:            !*h3,
		AltSvc:          *altSvc,
		DropSpec:        *drop,
		AdvertiseWT:     *advertiseWT,
		NoSeq:           *noSeq,
		SendQueueTarget: *sendQueue,
		Cert:            mode,
		Origins:         origins,
		RedirectAddr:    redirectAddr,
		Metrics:         access,
	}, nil
}

func metricsAccess(s string) (server.MetricsAccess, error) {
	switch s {
	case "off":
		return server.MetricsOff, nil
	case "local":
		return server.MetricsLocal, nil
	case "public":
		return server.MetricsPublic, nil
	}
	return 0, fmt.Errorf("-metrics %q: want off, local or public", s)
}

// redirectAddr resolves the -redirect flag. ACME defaults it to :80, because
// the HTTP-01 challenge is answered there; other modes default to off.
func redirectAddr(flagValue string, kind certs.Kind) (string, error) {
	switch {
	case flagValue == "off":
		if kind == certs.ACME {
			// TLS-ALPN-01 on the HTTPS listener still works, so this is allowed.
			return "", nil
		}
		return "", nil
	case flagValue != "":
		if kind == certs.Dev {
			return "", errors.New("-redirect needs a real certificate (-cert file:... or acme)")
		}
		return flagValue, nil
	case kind == certs.ACME:
		return ":80", nil
	}
	return "", nil
}

// printFlags prints either the regular flags or the testing-only ones.
func printFlags(fs *flag.FlagSet, out io.Writer, testing bool) {
	fs.VisitAll(func(f *flag.Flag) {
		if testingFlags[f.Name] != testing {
			return
		}
		name, usage := flag.UnquoteUsage(f)
		line := "  -" + f.Name
		if name != "" {
			line += " " + name
		}
		fmt.Fprintf(out, "%s\n    \t%s", line, strings.ReplaceAll(usage, "\n", "\n    \t"))
		if f.DefValue != "" && f.DefValue != "false" {
			fmt.Fprintf(out, " (default %s)", f.DefValue)
		}
		fmt.Fprintln(out)
	})
}
