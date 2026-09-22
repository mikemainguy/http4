// One-tag setup for a site: <script src="/http4/auto.js"></script>, first in
// <head>. It is a classic (non-module) script, so it runs before the parser
// requests anything below it, and it answers the worker as early as possible.
// It exposes the page API as window.http4.
//
// Optional attributes on the tag: data-config-url, data-asset-prefix.

import { install, type Http4Page, type InstallOptions } from "./page.ts";

declare global {
  interface Window {
    http4?: Http4Page;
  }
}

const tag = document.currentScript as HTMLScriptElement | null;
const opts: InstallOptions = {};
if (tag?.dataset.configUrl) opts.configUrl = tag.dataset.configUrl;
if (tag?.dataset.assetPrefix) opts.assetPrefix = tag.dataset.assetPrefix;
window.http4 = install(opts);
