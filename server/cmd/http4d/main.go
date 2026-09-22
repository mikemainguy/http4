// Command http4d runs the HTTP4 sandbox server: the browser client over HTTP
// and the HTTP4 datagram protocol over WebTransport.
package main

import (
	"encoding/json"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"

	"http4/server/internal/server"
)

func main() {
	httpAddr := flag.String("http", "127.0.0.1:8080", "TCP address serving the client page and /config.json")
	wtAddr := flag.String("wt", "127.0.0.1:4433", "UDP address for WebTransport")
	static := flag.String("static", "client", "directory served at /")
	assets := flag.String("assets", "testdata/assets", "directory HTTP4 requests are served from")
	drop := flag.String("drop", "", "TESTING ONLY: drop outgoing DATA to simulate loss, e.g. every=7,packet0,final,rate=0.05,seed=1")
	advertiseWT := flag.String("advertise-wt", "", "host:port to advertise for WebTransport instead of -wt's, e.g. an impairment proxy in front of it")
	flag.Parse()

	srv, err := server.Start(server.Config{
		HTTPAddr: *httpAddr, WTAddr: *wtAddr, StaticDir: *static, AssetsDir: *assets,
		DropSpec: *drop, AdvertiseWT: *advertiseWT,
	})
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
	})
	if *drop != "" {
		log.Printf("WARNING: injecting loss on outgoing DATA: %s", *drop)
	}
	log.Printf("open %s", srv.HTTPURL)

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
