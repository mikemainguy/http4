// Package clientdist embeds the built browser client (client/dist) in
// http4d, so `http4d serve` needs no files besides the site itself.
//
// `npm run build` copies the bundle into dist/ (scripts/embed-client, run as
// postbuild) before anything builds http4d. A plain `go build` without that
// step still compiles: only a placeholder is embedded, and Built reports false.
package clientdist

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var embedded embed.FS

// Entry is the file whose presence means the bundle was built.
const Entry = "http4.js"

// FS returns the embedded client files (http4.js, …) at its root.
func FS() fs.FS {
	sub, err := fs.Sub(embedded, "dist")
	if err != nil {
		panic(err) // dist is embedded, so this can't fail
	}
	return sub
}

// Built reports whether fsys holds a built client bundle.
func Built(fsys fs.FS) bool {
	_, err := fs.Stat(fsys, Entry)
	return err == nil
}
