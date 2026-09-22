package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"http4/server/internal/clientdist"
	"http4/server/internal/server"
)

const serveUsage = `Usage: http4d serve [flags] <site-dir>

Serves a static site from one directory. Pages load over plain HTTP; every
file is also an HTTP4 asset (WebTransport datagrams, asset ID = its path),
and the same files stay available over HTTP by the same path as the fallback.
The HTTP4 client is served at /http4/http4.js, its Service Worker at
/http4-sw.js, and connection settings at /config.json.

Flags go before <site-dir>.
`

// testingFlags are listed separately in the usage text.
var testingFlags = map[string]bool{"drop": true, "advertise-wt": true}

// parseServe turns `http4d serve` arguments into a server config. It returns
// flag.ErrHelp after printing usage for -h.
func parseServe(args []string, out io.Writer) (server.Config, error) {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(out)
	httpAddr := fs.String("http", "127.0.0.1:8080", "TCP `address` for pages, the fallback and /config.json")
	wtAddr := fs.String("wt", "127.0.0.1:4433", "UDP `address` for HTTP4 over WebTransport (and HTTP/3 with -h3)")
	cert := fs.String("cert", "dev", "certificate `mode`. dev: a fresh self-signed certificate each start, trusted by\npinning its hash (serverCertificateHashes); localhost only, and only WebTransport")
	h3 := fs.Bool("h3", false, "also serve the site over plain HTTP/3 at /h3/ on the -wt port (the benchmark baseline)")
	clientDir := fs.String("client-dir", "", "serve /http4/ from this `directory` (e.g. client/dist) instead of the built-in bundle")
	drop := fs.String("drop", "", "drop outgoing DATA to simulate loss: a `spec` like every=7,packet0,final,rate=0.05,seed=1")
	advertiseWT := fs.String("advertise-wt", "", "advertise this `host:port` for WebTransport, e.g. an impairment proxy")
	noSeq := fs.Bool("no-seq", false, "don't negotiate session sequence numbers (wire v2); send plain v1 DATA to every client")
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
	switch *cert {
	case "dev":
	case "":
		return server.Config{}, errors.New("-cert is required")
	default:
		// The hook for real certificates (ACME / files) is vrek iss-fzz5beq.
		return server.Config{}, fmt.Errorf("certificate mode %q is not implemented; only -cert dev (localhost) exists so far", *cert)
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
	return server.Config{
		HTTPAddr:    *httpAddr,
		WTAddr:      *wtAddr,
		SiteDir:     site,
		ClientFS:    client,
		NoH3:        !*h3,
		DropSpec:    *drop,
		AdvertiseWT: *advertiseWT,
		NoSeq:       *noSeq,
	}, nil
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
