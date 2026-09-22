// Command http4d runs the HTTP4 server.
//
//	http4d serve [flags] <site-dir>   serve a static site over HTTP + HTTP4
//	http4d [flags]                    the sandbox/test server (tests, integrity suite)
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"http4/server/internal/server"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "serve" {
		cfg, err := parseServe(os.Args[2:], os.Stderr)
		if err == flag.ErrHelp {
			os.Exit(0)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "http4d serve:", err)
			os.Exit(2)
		}
		run(cfg)
		return
	}

	flag.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "Usage: http4d [flags]  (sandbox server; to serve a site use `http4d serve -h`)\n")
		flag.PrintDefaults()
	}
	httpAddr := flag.String("http", "127.0.0.1:8080", "TCP address serving the client page and /config.json")
	wtAddr := flag.String("wt", "127.0.0.1:4433", "UDP address for WebTransport")
	static := flag.String("static", "client", "directory served at /")
	assets := flag.String("assets", "testdata/assets", "directory HTTP4 requests are served from")
	drop := flag.String("drop", "", "TESTING ONLY: drop outgoing DATA to simulate loss, e.g. every=7,packet0,final,rate=0.05,seed=1")
	assetPrefix := flag.String("asset-prefix", server.DefaultAssetPrefix, "HTTP path the asset pool is also served under, for clients falling back from HTTP4")
	advertiseWT := flag.String("advertise-wt", "", "host:port to advertise for WebTransport instead of -wt's, e.g. an impairment proxy in front of it")
	noSeq := flag.Bool("no-seq", false, "don't negotiate session sequence numbers (wire v2); send plain v1 DATA to every client")
	sendQueue := flag.Int("send-queue", 0, "datagrams of bulk to leave in QUIC's send queue ahead of the sender's next pick; 0 or negative = don't pace")
	flag.Parse()

	run(server.Config{
		HTTPAddr: *httpAddr, WTAddr: *wtAddr, StaticDir: *static, AssetsDir: *assets,
		DropSpec: *drop, AdvertiseWT: *advertiseWT, AssetPrefix: *assetPrefix, NoSeq: *noSeq,
		SendQueueTarget: *sendQueue,
	})
}

// run starts the server, announces it, and serves until SIGINT/SIGTERM.
func run(cfg server.Config) {
	srv, err := server.Start(cfg)
	if err != nil {
		log.Fatal(err)
	}

	// One JSON line on stdout tells a supervising test where the server ended
	// up (ports may be 0 = pick a free one); human-readable logs go to stderr.
	json.NewEncoder(os.Stdout).Encode(map[string]string{
		"event":        "ready",
		"http":         srv.HTTPURL,
		"webtransport": srv.WebTransportURL,
		"wt_listen":    srv.WTListenAddr,
		"h3":           srv.ClientConfig().H3URL,
		"spki":         srv.ClientConfig().SPKIHash,
	})
	if cfg.DropSpec != "" {
		log.Printf("WARNING: injecting loss on outgoing DATA: %s", cfg.DropSpec)
	}
	if cfg.SiteDir != "" {
		log.Printf("serving %s at %s (HTTP4 over %s)", cfg.SiteDir, srv.HTTPURL, srv.WebTransportURL)
	} else {
		log.Printf("open %s", srv.HTTPURL)
	}

	// SIGHUP re-reads a -cert file:... pair, so a renewal needs no restart.
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	go func() {
		for range hup {
			if err := srv.ReloadCert(); err != nil {
				log.Printf("reload certificate: %v", err)
			} else {
				log.Print("reloaded certificate")
			}
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	done := make(chan error, 1)
	go func() { done <- srv.Wait() }()
	select {
	case <-sig:
	case err := <-done:
		if err != nil {
			log.Print(err)
		}
	}
	if err := srv.Close(); err != nil {
		log.Print(err)
	}
}
