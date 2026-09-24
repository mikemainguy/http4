// One-tag setup for a site: <script src="/http4/auto.js"></script>, first in
// <head>. It is a classic (non-module) script, so it runs before the parser
// requests anything below it, and it answers the worker as early as possible.
// It exposes the page API as window.http4.
//
// Optional attributes on the tag: data-config-url, data-asset-prefix, and
// data-disabled (turn HTTP4 off). A page URL with ?http4=off also turns it
// off, for side-by-side comparisons.
//
// A page can also start the WebTransport handshake before this script has
// downloaded, by putting one line above the tag:
//
//   <script>try{window.__http4Preconnect=new WebTransport(location.origin+"/wt")}catch(e){}</script>
//
// That turns a serial chain (HTML, then this script, then a handshake) into
// one round trip of latency, which is the difference between carrying a page's
// resources and missing them (vrek fnd-sgw2sbh). Adopted below when present.

import { install, type Http4Page, type InstallOptions } from "./page.ts";

declare global {
  interface Window {
    http4?: Http4Page;
    /** A WebTransport the page started early; see the note above. */
    __http4Preconnect?: WebTransport;
  }
}

const tag = document.currentScript as HTMLScriptElement | null;
const opts: InstallOptions = {};
if (tag?.dataset.configUrl) opts.configUrl = tag.dataset.configUrl;
if (tag?.dataset.assetPrefix) opts.assetPrefix = tag.dataset.assetPrefix;
if (tag?.dataset.disabled !== undefined || new URLSearchParams(location.search).get("http4") === "off") {
  opts.disabled = true;
}
// Adopt a handshake the page started, but never when HTTP4 is off for this
// page: the comparison arm must not hold a session open.
if (!opts.disabled && window.__http4Preconnect) opts.session = window.__http4Preconnect;
window.http4 = install(opts);
