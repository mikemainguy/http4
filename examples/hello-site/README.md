# hello-site

The smallest site served by `http4d serve`: a page whose stylesheet, script
and banner load normally, plus two requests (`data.json` and
`images/badge.png`) made through the HTTP4 client library, with a table
showing how each was served.

```sh
npm run build                       # builds the client and embeds it in http4d
cd server && go run ./cmd/http4d serve ../examples/hello-site
# open http://127.0.0.1:8080/ in Chrome
```

With the dev certificate (`-cert dev`, the default) the page must be opened
on `127.0.0.1` or `localhost`. Nothing in the site knows about the protocol
beyond importing `/http4/http4.js`; see `tests/serve/serve.test.ts` for the
automated check.
