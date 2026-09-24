package server

// Whether one origin response may be held in a shared cache (vrek iss-15hefmy).
//
// This is the safety property of the whole caching design. Entries are keyed by
// URL and served to every client, so a response that is really per-user must
// never be stored: getting this wrong hands one visitor's bytes to another,
// which is a data leak rather than a slow page.
//
// It is therefore an ALLOWLIST. A response is cached only when it positively
// says it may be shared; anything unrecognised, absent or ambiguous falls out
// as "do not cache". A framework that invents a header nobody here has seen
// gets no caching, rather than accidental sharing.
//
// Deliberately not implemented, and refused instead:
//   - Vary on anything but Accept-Encoding. Keying on arbitrary request headers
//     is where shared caches go subtly wrong; we do not key on them, so we
//     decline the response.
//   - Caching a response to an authenticated request. RFC 9111 permits it with
//     `public`; the risk is not worth the hit rate here.
//   - Revalidation and stale-while-revalidate. An entry expires and is fetched
//     again. `stale-while-revalidate` is read only as evidence the response is
//     shareable, never as licence to serve stale bytes.

import (
	"net/http"
	"strconv"
	"strings"
	"time"
)

// cacheDecision is why a response was or was not cached. The reason is for
// operators and tests: "not cached" with no explanation is unactionable.
type cacheDecision struct {
	ok     bool
	reason string
	// maxAge is how long the entry may be served, from Cache-Control. Only
	// meaningful when ok.
	maxAge time.Duration
}

// cacheable reports whether resp, produced for req, may be stored in a cache
// shared by every client, and for how long.
func cacheable(req *http.Request, resp *http.Response) cacheDecision {
	no := func(reason string) cacheDecision { return cacheDecision{reason: reason} }

	// The request side first: a personalised request cannot produce a shareable
	// response, whatever the response claims about itself.
	if req.Method != http.MethodGet {
		return no("not a GET")
	}
	if req.Header.Get("Authorization") != "" {
		return no("request carried Authorization")
	}
	if req.Header.Get("Cookie") != "" {
		return no("request carried Cookie")
	}

	// 200 only. A redirect, an error and a 206 range are all responses whose
	// reuse needs rules we have not written; 304 has no body to reuse at all.
	if resp.StatusCode != http.StatusOK {
		return no("status " + strconv.Itoa(resp.StatusCode))
	}
	if len(resp.Header.Values("Set-Cookie")) > 0 {
		return no("response set a cookie")
	}
	if v, ok := varyAcceptable(resp.Header.Values("Vary")); !ok {
		return no("Vary: " + v)
	}

	cc := parseCacheControl(resp.Header.Values("Cache-Control"))
	switch {
	case cc.noStore:
		return no("Cache-Control: no-store")
	case cc.private:
		return no("Cache-Control: private")
	case cc.noCache:
		// no-cache permits storing but requires revalidation before reuse, and
		// revalidation is out of scope. Storing something we may never serve is
		// memory spent for nothing.
		return no("Cache-Control: no-cache")
	}

	// The positive signal. s-maxage is the shared-cache directive and wins over
	// max-age when both are present, which is what a CDN would do.
	age, hasAge := cc.sharedMaxAge()
	switch {
	case hasAge && age <= 0:
		return no("Cache-Control: max-age=0")
	case hasAge:
		return cacheDecision{ok: true, reason: "max-age", maxAge: age}
	case cc.public:
		// `public` with no lifetime: shareable, but nothing says for how long.
		// Hold it briefly rather than forever, so a deploy is not shadowed by a
		// cache entry with no expiry.
		return cacheDecision{ok: true, reason: "public, no max-age", maxAge: defaultPublicTTL}
	}
	// No Cache-Control at all, or one that says nothing about sharing. Heuristic
	// freshness (RFC 9111 §4.2.2) is legal and is exactly the guessing this
	// design set out to avoid: the origin is the authority, and it did not say.
	return no("no cacheability stated")
}

// defaultPublicTTL bounds an entry that is marked public but carries no
// lifetime. Short on purpose: it is a guess, and a wrong guess should expire.
const defaultPublicTTL = 5 * time.Minute

// varyAcceptable reports whether a Vary header can be honoured. We key on the
// URL alone, so the only acceptable variation is one that does not change the
// bytes we would hand back. Accept-Encoding qualifies because a response is
// stored with its own Content-Encoding and served only to a client that
// accepts it. Anything else, including "*", is refused rather than guessed at.
func varyAcceptable(values []string) (string, bool) {
	for _, v := range values {
		for _, field := range strings.Split(v, ",") {
			field = strings.TrimSpace(field)
			if field == "" {
				continue
			}
			if !strings.EqualFold(field, "Accept-Encoding") {
				return field, false
			}
		}
	}
	return "", true
}

// cacheControl is the subset of Cache-Control this cache understands.
type cacheControl struct {
	public  bool
	private bool
	noStore bool
	noCache bool
	maxAge  time.Duration
	hasMax  bool
	sMaxAge time.Duration
	hasSMax bool
}

// sharedMaxAge is the lifetime for a shared cache: s-maxage overrides max-age.
func (c cacheControl) sharedMaxAge() (time.Duration, bool) {
	if c.hasSMax {
		return c.sMaxAge, true
	}
	return c.maxAge, c.hasMax
}

func parseCacheControl(values []string) cacheControl {
	var c cacheControl
	for _, v := range values {
		for _, part := range strings.Split(v, ",") {
			part = strings.TrimSpace(part)
			name, arg, _ := strings.Cut(part, "=")
			switch strings.ToLower(strings.TrimSpace(name)) {
			case "public":
				c.public = true
			case "private":
				c.private = true
			case "no-store":
				c.noStore = true
			case "no-cache":
				c.noCache = true
			case "max-age":
				if d, ok := seconds(arg); ok {
					c.maxAge, c.hasMax = d, true
				}
			case "s-maxage":
				if d, ok := seconds(arg); ok {
					c.sMaxAge, c.hasSMax = d, true
				}
			}
		}
	}
	return c
}

// seconds parses a delta-seconds argument. A malformed one is ignored rather
// than treated as zero: "max-age=abc" says nothing, and reading it as 0 would
// turn a header we failed to parse into a decision not to cache — which is the
// safe direction, but for the wrong reason, and hides the malformed header.
func seconds(arg string) (time.Duration, bool) {
	arg = strings.Trim(strings.TrimSpace(arg), `"`)
	if arg == "" {
		return 0, false
	}
	n, err := strconv.ParseInt(arg, 10, 64)
	if err != nil || n < 0 {
		return 0, false
	}
	return time.Duration(n) * time.Second, true
}
