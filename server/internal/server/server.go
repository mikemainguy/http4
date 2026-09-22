// Package server wires up the two listeners: a TCP HTTP server that serves the
// pages, the fallback assets and /config.json, and a WebTransport (HTTP/3)
// server on UDP that carries the HTTP4 datagrams. Both present the same
// certificate (internal/certs). With the dev certificate the TCP side stays on
// plain HTTP, which is a secure context on loopback; with a real certificate it
// serves HTTPS, and an optional third listener redirects plain HTTP to it (and
// answers ACME HTTP-01).
package server

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"

	"http4/server/internal/certs"
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
	NoSeq     bool   // ignore clients' HELLO: plain v1 DATA only (sender.Config.NoSeq)
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

	// Cert says where the TLS certificate comes from. The zero value is the
	// dev certificate: self-signed, pinned by hash, localhost only.
	Cert certs.Mode
	// Origins are extra page origins allowed to open WebTransport sessions and
	// read the h3 baseline, e.g. "https://demo.example". The server's own
	// loopback origin is always allowed.
	Origins []string
	// RedirectAddr, if set, is a TCP address for a plain-HTTP listener that
	// only redirects to HTTPS and answers ACME HTTP-01. Real certificates only.
	RedirectAddr string
	// Metrics decides who may read /metrics.json. The zero value is Public,
	// which is what the sandbox server and its tests expect.
	Metrics MetricsAccess
}

// MetricsAccess says who may read /metrics.json.
type MetricsAccess int

const (
	MetricsPublic MetricsAccess = iota // anyone (the sandbox default)
	MetricsLocal                       // loopback clients only (the serve default)
	MetricsOff                         // nobody
)

// ClientConfig is served at /config.json so the page never hard-codes the
// WebTransport port or the per-run certificate hash.
type ClientConfig struct {
	WebTransportURL string `json:"webTransportUrl"`
	EchoURL         string `json:"echoUrl"`
	// CertHash is the base64 SHA-256 of the certificate DER, for
	// serverCertificateHashes. It is omitted for a real certificate, which
	// the browser validates itself.
	CertHash string `json:"certHash,omitempty"`
	// H3URL is the base URL for the assets over plain HTTP/3 (append the
	// asset ID). SPKIHash is what Chrome needs in
	// --ignore-certificate-errors-spki-list to accept the dev certificate
	// for ordinary fetches, which serverCertificateHashes does not cover.
	H3URL    string `json:"h3Url"`
	SPKIHash string `json:"spkiHash,omitempty"`
	// AssetPrefix is the same-origin HTTP path prefix whose URLs are HTTP4
	// assets (URL = prefix + asset ID): "/" in serve mode.
	AssetPrefix string `json:"assetPrefix"`
}

type Server struct {
	HTTPURL         string
	WebTransportURL string // as advertised to clients
	WTListenAddr    string // where the UDP listener actually is

	cert        *certs.Source
	origins     []string // normalised extra origins allowed to connect
	metricsTo   MetricsAccess
	assets      *sender.DirAssets
	pool        sender.Assets // what HTTP, HTTP4 and h3 read: assets, filtered in serve mode
	assetPrefix string
	clientFS    fs.FS
	noH3        bool
	metrics     *sender.Metrics
	httpScheme  string
	httpPort    int
	httpLn      net.Listener
	redirectLn  net.Listener
	udpConn     net.PacketConn
	httpSrv     *http.Server
	redirectSrv *http.Server
	wtSrv       *webtransport.Server
	wtDone      chan struct{} // closed when wtSrv.Serve has returned
	serveErr    chan error
}

// Start binds both listeners and begins serving. Port 0 in either address picks
// a free port; the chosen ports are reflected in HTTPURL and WebTransportURL.
func Start(cfg Config) (*Server, error) {
	cert, err := certs.Open(cfg.Cert)
	if err != nil {
		return nil, err
	}
	origins, err := normaliseOrigins(cfg.Origins)
	if err != nil {
		return nil, err
	}
	if cfg.RedirectAddr != "" && !cert.Trusted() {
		return nil, errors.New("-redirect needs a real certificate (-cert file:... or acme)")
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
	var redirectLn net.Listener
	if cfg.RedirectAddr != "" {
		redirectLn, err = net.Listen("tcp", cfg.RedirectAddr)
		if err != nil {
			assets.Close()
			httpLn.Close()
			udpConn.Close()
			return nil, fmt.Errorf("listen redirect: %w", err)
		}
	}
	scheme := "http"
	if cert.Trusted() {
		scheme = "https"
	}

	s := &Server{
		HTTPURL:         scheme + "://" + httpLn.Addr().String(),
		WebTransportURL: "https://" + cmp.Or(cfg.AdvertiseWT, udpConn.LocalAddr().String()) + WebTransportPath,
		WTListenAddr:    udpConn.LocalAddr().String(),
		cert:            cert,
		origins:         origins,
		metricsTo:       cfg.Metrics,
		assets:          assets,
		pool:            pool,
		assetPrefix:     assetPrefix,
		clientFS:        cfg.ClientFS,
		noH3:            cfg.NoH3,
		metrics:         new(sender.Metrics),
		httpScheme:      scheme,
		httpPort:        httpLn.Addr().(*net.TCPAddr).Port,
		httpLn:          httpLn,
		redirectLn:      redirectLn,
		udpConn:         udpConn,
		wtDone:          make(chan struct{}),
		serveErr:        make(chan error, 3), // page, redirect and WebTransport
	}
	h3 := &http3.Server{
		TLSConfig:  http3.ConfigureTLSConfig(cert.TLS()),
		QUICConfig: &quic.Config{EnableDatagrams: true, EnableStreamResetPartialDelivery: true},
	}
	webtransport.ConfigureHTTP3Server(h3)
	s.wtSrv = &webtransport.Server{
		H3:          h3,
		CheckOrigin: s.allowedOrigin,
	}
	wtMux := http.NewServeMux()
	wtMux.HandleFunc(WebTransportPath, s.upgrade(func(sess *webtransport.Session) {
		sender.Serve(sess.Context(), sess, sender.Config{Assets: s.pool, Metrics: s.metrics, NewDropper: newDropper, NoSeq: cfg.NoSeq})
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

	if cert.Trusted() {
		// ServeTLS rather than a wrapped listener, so Go sets up HTTP/2 too.
		s.httpSrv.TLSConfig = cert.TLS()
		go func() { s.serveErr <- s.httpSrv.ServeTLS(httpLn, "", "") }()
	} else {
		go func() { s.serveErr <- s.httpSrv.Serve(httpLn) }()
	}
	if redirectLn != nil {
		s.redirectSrv = &http.Server{
			Handler:           cert.Challenge(http.HandlerFunc(s.redirectToHTTPS)),
			ReadHeaderTimeout: 5 * time.Second,
		}
		go func() { s.serveErr <- s.redirectSrv.Serve(redirectLn) }()
	}
	go func() {
		defer close(s.wtDone)
		s.serveErr <- s.wtSrv.Serve(udpConn)
	}()
	return s, nil
}

// redirectToHTTPS sends a plain-HTTP request to the same URL over HTTPS. The
// port is added only when the HTTPS listener is not on 443, so the usual
// deployment redirects to a clean https://host/path.
func (s *Server) redirectToHTTPS(w http.ResponseWriter, r *http.Request) {
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if s.httpPort != 443 {
		host = net.JoinHostPort(host, strconv.Itoa(s.httpPort))
	}
	http.Redirect(w, r, "https://"+host+r.URL.RequestURI(), http.StatusMovedPermanently)
}

// ReloadCert re-reads a file-mode certificate (SIGHUP), so a renewal is picked
// up without a restart. Other modes are a no-op.
func (s *Server) ReloadCert() error { return s.cert.Reload() }

// Wait returns when either listener stops serving, with its error.
func (s *Server) Wait() error {
	err := <-s.serveErr
	if errors.Is(err, http.ErrServerClosed) || errors.Is(err, quic.ErrServerClosed) {
		return nil
	}
	return err
}

func (s *Server) Close() error {
	// Close the socket first and wait for Serve to return: closing the
	// WebTransport server while its own Serve is starting races inside
	// webtransport-go (vrek iss-ag6h0a6), which a Start immediately followed
	// by a Close reliably hits.
	err := s.udpConn.Close()
	<-s.wtDone
	err = errors.Join(err, s.wtSrv.Close(), s.httpSrv.Close(), s.assets.Close())
	if s.redirectSrv != nil {
		err = errors.Join(err, s.redirectSrv.Close())
	}
	return err
}

// Metrics returns the HTTP4 counters shared by every session.
func (s *Server) Metrics() sender.Snapshot { return s.metrics.Snapshot() }

func (s *Server) ClientConfig() ClientConfig {
	return ClientConfig{
		WebTransportURL: s.WebTransportURL,
		EchoURL:         strings.TrimSuffix(s.WebTransportURL, WebTransportPath) + EchoPath,
		CertHash:        s.cert.CertHash(),
		H3URL:           s.h3URL(),
		SPKIHash:        s.cert.SPKIHash(),
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

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	// A deployed server keeps its counters to itself: they are operational
	// detail, and one more thing a stranger can poll.
	switch s.metricsTo {
	case MetricsOff:
		http.NotFound(w, r)
		return
	case MetricsLocal:
		if !isLoopbackAddr(r.RemoteAddr) {
			http.NotFound(w, r)
			return
		}
	}
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
	origin := r.Header.Get("Origin")
	if isLoopbackOrigin(origin, s.httpScheme, s.httpPort) {
		return true
	}
	return origin != "" && slices.Contains(s.origins, normaliseOrigin(origin))
}

// isLoopbackOrigin accepts the page this server itself serves on loopback: its
// own scheme and port, on localhost or a loopback address.
func isLoopbackOrigin(origin, scheme string, httpPort int) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != scheme || u.Port() != strconv.Itoa(httpPort) {
		return false
	}
	if u.Hostname() == "localhost" {
		return true
	}
	ip := net.ParseIP(u.Hostname())
	return ip != nil && ip.IsLoopback()
}

// isLoopbackAddr reports whether a net/http RemoteAddr is a loopback client.
func isLoopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// normaliseOrigins parses the configured extra origins. A typo here would
// silently refuse every browser session, so it fails at startup instead.
func normaliseOrigins(origins []string) ([]string, error) {
	out := make([]string, 0, len(origins))
	for _, o := range origins {
		u, err := url.Parse(o)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" ||
			u.Path != "" || u.RawQuery != "" || u.User != nil {
			return nil, fmt.Errorf("-origin %q: want scheme://host[:port], e.g. https://demo.example", o)
		}
		out = append(out, normaliseOrigin(o))
	}
	return out, nil
}

// normaliseOrigin drops a default port, so https://h and https://h:443 match.
func normaliseOrigin(origin string) string {
	u, err := url.Parse(origin)
	if err != nil {
		return origin
	}
	host := u.Hostname()
	if port := u.Port(); port != "" && !(u.Scheme == "https" && port == "443") && !(u.Scheme == "http" && port == "80") {
		host = net.JoinHostPort(host, port)
	}
	return u.Scheme + "://" + host
}
