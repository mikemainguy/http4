// Command gen-fixtures writes the integrity suite's deterministic asset pool
// and its manifest. With -check it verifies an existing pool instead.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"http4/server/internal/fixtures"
)

func main() {
	out := flag.String("out", "../testdata/assets", "output directory")
	check := flag.Bool("check", false, "verify existing files against the manifest instead of writing")
	flag.Parse()

	if *check {
		m, err := fixtures.ReadManifest(filepath.Join(*out, fixtures.ManifestName))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if problems := fixtures.Check(*out, m); len(problems) > 0 {
			for _, p := range problems {
				fmt.Fprintln(os.Stderr, p)
			}
			os.Exit(1)
		}
		fmt.Printf("%d fixtures in %s match the manifest\n", len(m.Assets), *out)
		return
	}

	m, err := fixtures.Generate(*out, fixtures.Set)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	var total int64
	for _, e := range m.Assets {
		total += e.Size
	}
	fmt.Printf("wrote %d fixtures (%d bytes) and %s to %s\n", len(m.Assets), total, fixtures.ManifestName, *out)
}
