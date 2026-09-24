package server

// Pass-through: everything outside the mounted directory is reverse-proxied to
// an application server over plain HTTP, untouched (vrek iss-sz6a8zk).
//
// Nothing here goes over HTTP4, and that is deliberate rather than a gap. The
// wire format needs a complete, randomly-addressable body — packet 0 carries
// total_size, grants are byte offsets, and a resend indexes into the asset — so
// a streamed response has no length to announce and a per-user response cannot
// be shared under an asset ID. Serving an origin's responses over HTTP4 would
// mean buffering every one of them and keeping a cache that must never hand one
// user's bytes to another. Files on disk have neither problem, so the mounted
// build travels over HTTP4 and the application's own responses do not.

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

// newPassThrough builds the reverse proxy for one origin. The origin must be
// an absolute http(s) URL with no path, because a path would silently rewrite
// every request in a way that is hard to notice afterwards.
func newPassThrough(origin string) (http.Handler, error) {
	u, err := url.Parse(origin)
	if err != nil {
		return nil, fmt.Errorf("-pass-through %q: %w", origin, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("-pass-through %q: want an http:// or https:// origin", origin)
	}
	if u.Host == "" {
		return nil, fmt.Errorf("-pass-through %q: no host", origin)
	}
	if p := strings.TrimSuffix(u.Path, "/"); p != "" {
		return nil, fmt.Errorf("-pass-through %q: give an origin with no path, not %q", origin, u.Path)
	}

	proxy := &httputil.ReverseProxy{
		// http.DefaultTransport leaves MaxIdleConnsPerHost at its default of 2,
		// which is the wrong shape for a reverse proxy: every request here goes
		// to ONE origin, so a page pulling dozens of assets keeps two
		// connections warm and reopens the rest. Pool for one busy upstream
		// instead.
		Transport: &http.Transport{
			DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			MaxIdleConns:          256,
			MaxIdleConnsPerHost:   256,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ExpectContinueTimeout: time.Second,
			ForceAttemptHTTP2:     true,
		},
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(u)
			// The application needs to know what the browser actually asked
			// for: it builds absolute URLs, sets cookie domains and decides
			// redirects from it, and it is behind us, so it cannot see it.
			r.Out.Host = r.In.Host
			r.SetXForwarded()
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			// 502 rather than 500: the failure is upstream, and saying so
			// distinguishes "the app is down" from "http4d is broken".
			http.Error(w, fmt.Sprintf("pass-through to %s failed: %v", u.Host, err), http.StatusBadGateway)
		},
	}
	return proxy, nil
}

// hostOnly is the authority a browser would send for this server, used by the
// pass-through tests to check the upstream saw it rather than our dial target.
func (s *Server) hostOnly() string {
	return strings.TrimPrefix(strings.TrimPrefix(s.HTTPURL, "http://"), "https://")
}
