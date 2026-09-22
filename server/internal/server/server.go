// Package server wires up the sandbox's two listeners: a plain HTTP server on
// TCP that serves the browser client and its connection config, and a
// WebTransport (HTTP/3) server on UDP that carries the HTTP4 datagrams.
package server

import (
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
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

// WebTransport paths: HTTP4 itself, and a plain datagram echo kept as a
// connectivity check.
const (
	WebTransportPath = "/wt"
	EchoPath         = "/echo"
)

type Config struct {
	HTTPAddr  string // TCP address for the page and /config.json, e.g. 127.0.0.1:8080
	WTAddr    string // UDP address for WebTransport, e.g. 127.0.0.1:4433
	StaticDir string // directory served at / (the built client)
	AssetsDir string // directory HTTP4 REQs are served from
}

// ClientConfig is served at /config.json so the page never hard-codes the
// WebTransport port or the per-run certificate hash.
type ClientConfig struct {
	WebTransportURL string `json:"webTransportUrl"`
	EchoURL         string `json:"echoUrl"`
	CertHash        string `json:"certHash"` // base64 SHA-256 of the certificate DER
}

type Server struct {
	HTTPURL         string
	WebTransportURL string

	cert     *devcert.Cert
	assets   *sender.DirAssets
	metrics  *sender.Metrics
	httpPort int
	httpLn   net.Listener
	udpConn  net.PacketConn
	httpSrv  *http.Server
	wtSrv    *webtransport.Server
	serveErr chan error
}

// Start binds both listeners and begins serving. Port 0 in either address picks
// a free port; the chosen ports are reflected in HTTPURL and WebTransportURL.
func Start(cfg Config) (*Server, error) {
	cert, err := devcert.Generate(time.Now())
	if err != nil {
		return nil, err
	}
	assets, err := sender.OpenDir(cfg.AssetsDir)
	if err != nil {
		return nil, fmt.Errorf("assets: %w", err)
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
		WebTransportURL: "https://" + udpConn.LocalAddr().String() + WebTransportPath,
		cert:            cert,
		assets:          assets,
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
		sender.Serve(sess.Context(), sess, sender.Config{Assets: s.assets, Metrics: s.metrics})
	}))
	wtMux.HandleFunc(EchoPath, s.upgrade(echoDatagrams))
	h3.Handler = wtMux

	httpMux := http.NewServeMux()
	httpMux.HandleFunc("/config.json", s.handleConfig)
	httpMux.HandleFunc("/metrics.json", s.handleMetrics)
	httpMux.Handle("/", http.FileServer(http.Dir(cfg.StaticDir)))
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
	}
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
