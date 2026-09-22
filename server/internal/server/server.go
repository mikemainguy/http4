// Package server wires up the sandbox's two listeners: a plain HTTP server on
// TCP that serves the browser client and its connection config, and a
// WebTransport (HTTP/3) server on UDP that carries the HTTP4 datagrams.
package server

import (
	"cmp"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"

	"http4/server/internal/devcert"
	"http4/server/internal/sender"
)

// Paths on the QUIC listener: HTTP4 itself, a plain datagram echo kept as a
// connectivity check, and the same assets over ordinary HTTP/3 as the
// benchmark baseline.
const (
	WebTransportPath = "/wt"
	EchoPath         = "/echo"
	H3Path           = "/h3/"
)

type Config struct {
	HTTPAddr  string // TCP address for the page and /config.json, e.g. 127.0.0.1:8080
	WTAddr    string // UDP address for WebTransport, e.g. 127.0.0.1:4433
	StaticDir string // directory served at / (the built client)
	AssetsDir string // directory HTTP4 REQs are served from
	DropSpec  string // loss injection for outgoing DATA (sender.ParseDropSpec); testing only
	// AdvertiseWT, if set, is the host:port put in the advertised WebTransport
	// and echo URLs instead of the UDP listener's own address, e.g. an
	// impairment proxy in front of it. The listener itself is unchanged.
	AdvertiseWT string
	// AssetPrefix is the HTTP path the asset pool is also served under, for
	// clients falling back from HTTP4. Default DefaultAssetPrefix.
	AssetPrefix string

	// SiteDir switches to serve mode (`http4d serve`): this one directory is
	// both the site's pages and its asset pool. Every path is an asset (the
	// advertised asset prefix is "/", and asset ID = path without the leading
	// slash), served over HTTP4 and, by the same name, over plain HTTP.
	// StaticDir, AssetsDir and AssetPrefix are ignored; dotfiles are hidden.
	SiteDir string
	// ClientFS holds the built browser client, served under ClientPath and
	// (its http4-sw.js) at ServiceWorker. Serve mode only; nil = not served.
	ClientFS fs.FS
	// NoH3 turns off the plain-HTTP/3 baseline route (H3Path).
	NoH3 bool
}

// ClientConfig is served at /config.json so the page never hard-codes the
// WebTransport port or the per-run certificate hash.
type ClientConfig struct {
	WebTransportURL string `json:"webTransportUrl"`
	EchoURL         string `json:"echoUrl"`
	CertHash        string `json:"certHash"` // base64 SHA-256 of the certificate DER
	// H3URL is the base URL for the assets over plain HTTP/3 (append the
	// asset ID). SPKIHash is what Chrome needs in
	// --ignore-certificate-errors-spki-list to accept the dev certificate
	// for ordinary fetches, which serverCertificateHashes does not cover.
	H3URL    string `json:"h3Url"`
	SPKIHash string `json:"spkiHash"`
	// AssetPrefix is the same-origin HTTP path prefix whose URLs are HTTP4
	// assets (URL = prefix + asset ID): "/" in serve mode.
	AssetPrefix string `json:"assetPrefix"`
}

type Server struct {
	HTTPURL         string
	WebTransportURL string // as advertised to clients
	WTListenAddr    string // where the UDP listener actually is

	cert        *devcert.Cert
	assets      *sender.DirAssets
	pool        sender.Assets // what HTTP, HTTP4 and h3 read: assets, filtered in serve mode
	assetPrefix string
	clientFS    fs.FS
	noH3        bool
	metrics     *sender.Metrics
	httpPort    int
	httpLn      net.Listener
	udpConn     net.PacketConn
	httpSrv     *http.Server
	wtSrv       *webtransport.Server
	serveErr    chan error
}

// Start binds both listeners and begins serving. Port 0 in either address picks
// a free port; the chosen ports are reflected in HTTPURL and WebTransportURL.
func Start(cfg Config) (*Server, error) {
	cert, err := devcert.Generate(time.Now())
	if err != nil {
		return nil, err
	}
	siteMode := cfg.SiteDir != ""
	assetPrefix, assetsDir := "/", cfg.SiteDir
	if !siteMode {
		assetPrefix, assetsDir = cmp.Or(cfg.AssetPrefix, DefaultAssetPrefix), cfg.AssetsDir
		if err := checkAssetPrefix(assetPrefix); err != nil {
			return nil, err
		}
	}
	newDropper, err := sender.ParseDropSpec(cfg.DropSpec)
	if err != nil {
		return nil, err
	}
	assets, err := sender.OpenDir(assetsDir)
	if err != nil {
		return nil, fmt.Errorf("assets: %w", err)
	}
	var pool sender.Assets = assets
	if siteMode {
		pool = visibleAssets{assets}
	}
	httpLn, err := net.Listen("tcp", cfg.HTTPAddr)
	if err != nil {
		assets.Close()
		return nil, fmt.Errorf("listen http: %w", err)
	}
	udpConn, err := net.ListenPacket("udp", cfg.WTAddr)
	if err != nil {
		assets.Close()
		httpLn.Close()
		return nil, fmt.Errorf("listen webtransport: %w", err)
	}

	s := &Server{
		HTTPURL:         "http://" + httpLn.Addr().String(),
		WebTransportURL: "https://" + cmp.Or(cfg.AdvertiseWT, udpConn.LocalAddr().String()) + WebTransportPath,
		WTListenAddr:    udpConn.LocalAddr().String(),
		cert:            cert,
		assets:          assets,
		pool:            pool,
		assetPrefix:     assetPrefix,
		clientFS:        cfg.ClientFS,
		noH3:            cfg.NoH3,
		metrics:         new(sender.Metrics),
		httpPort:        httpLn.Addr().(*net.TCPAddr).Port,
		httpLn:          httpLn,
		udpConn:         udpConn,
		serveErr:        make(chan error, 2),
	}
	h3 := &http3.Server{
		TLSConfig:  http3.ConfigureTLSConfig(&tls.Config{Certificates: []tls.Certificate{cert.TLS}}),
		QUICConfig: &quic.Config{EnableDatagrams: true, EnableStreamResetPartialDelivery: true},
	}
	webtransport.ConfigureHTTP3Server(h3)
	s.wtSrv = &webtransport.Server{
		H3:          h3,
		CheckOrigin: s.allowedOrigin,
	}
	wtMux := http.NewServeMux()
	wtMux.HandleFunc(WebTransportPath, s.upgrade(func(sess *webtransport.Session) {
		sender.Serve(sess.Context(), sess, sender.Config{Assets: s.pool, Metrics: s.metrics, NewDropper: newDropper})
	}))
	wtMux.HandleFunc(EchoPath, s.upgrade(echoDatagrams))
	if !cfg.NoH3 {
		wtMux.HandleFunc(H3Path, s.handleH3Asset)
	}
	h3.Handler = wtMux

	httpMux := http.NewServeMux()
	httpMux.HandleFunc("/config.json", s.handleConfig)
	httpMux.HandleFunc("/metrics.json", s.handleMetrics)
	if siteMode {
		if cfg.ClientFS != nil {
			httpMux.Handle(ClientPath, s.handleClient(""))
			httpMux.Handle(ServiceWorker, s.handleClient(serviceWorkerFile))
		}
		httpMux.HandleFunc("/", s.handleSite)
	} else {
		httpMux.Handle(assetPrefix, http.StripPrefix(assetPrefix, http.HandlerFunc(s.handleAsset)))
		httpMux.Handle("/", http.FileServer(http.Dir(cfg.StaticDir)))
	}
	s.httpSrv = &http.Server{Handler: httpMux, ReadHeaderTimeout: 5 * time.Second}

	go func() { s.serveErr <- s.httpSrv.Serve(httpLn) }()
	go func() { s.serveErr <- s.wtSrv.Serve(udpConn) }()
	return s, nil
}

// Wait returns when either listener stops serving, with its error.
func (s *Server) Wait() error {
	err := <-s.serveErr
	if errors.Is(err, http.ErrServerClosed) || errors.Is(err, quic.ErrServerClosed) {
		return nil
	}
	return err
}

func (s *Server) Close() error {
	return errors.Join(s.wtSrv.Close(), s.httpSrv.Close(), s.udpConn.Close(), s.assets.Close())
}

// Metrics returns the HTTP4 counters shared by every session.
func (s *Server) Metrics() sender.Snapshot { return s.metrics.Snapshot() }

func (s *Server) ClientConfig() ClientConfig {
	return ClientConfig{
		WebTransportURL: s.WebTransportURL,
		EchoURL:         strings.TrimSuffix(s.WebTransportURL, WebTransportPath) + EchoPath,
		CertHash:        base64.StdEncoding.EncodeToString(s.cert.Hash[:]),
		H3URL:           s.h3URL(),
		SPKIHash:        base64.StdEncoding.EncodeToString(s.cert.SPKIHash[:]),
		AssetPrefix:     s.assetPrefix,
	}
}

func (s *Server) h3URL() string {
	if s.noH3 {
		return ""
	}
	return strings.TrimSuffix(s.WebTransportURL, WebTransportPath) + H3Path
}

func (s *Server) handleConfig(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store") // the hash changes every run
	json.NewEncoder(w).Encode(s.ClientConfig())
}

func (s *Server) handleMetrics(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(s.Metrics())
}

// upgrade turns a WebTransport CONNECT into a session and runs serve on it
// for the session's lifetime.
func (s *Server) upgrade(serve func(*webtransport.Session)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Upgrade would also refuse this, but only with an error the handler
		// can't tell apart from a malformed request; answer 403 explicitly instead.
		if !s.allowedOrigin(r) {
			http.Error(w, "origin not allowed", http.StatusForbidden)
			return
		}
		sess, err := s.wtSrv.Upgrade(w, r)
		if err != nil {
			log.Printf("webtransport upgrade from %s: %v", r.RemoteAddr, err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		serve(sess)
	}
}

func (s *Server) allowedOrigin(r *http.Request) bool {
	return isLoopbackOrigin(r.Header.Get("Origin"), s.httpPort)
}

// isLoopbackOrigin accepts only the page this server itself serves: an http
// origin on a loopback host at the HTTP listener's port.
func isLoopbackOrigin(origin string, httpPort int) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "http" || u.Port() != strconv.Itoa(httpPort) {
		return false
	}
	if u.Hostname() == "localhost" {
		return true
	}
	ip := net.ParseIP(u.Hostname())
	return ip != nil && ip.IsLoopback()
}
