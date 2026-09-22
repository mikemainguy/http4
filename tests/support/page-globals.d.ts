// Brings the pages' window declarations into the test project, so
// page.evaluate callbacks are typed: window.__echo / window.__http4 (the
// sandbox page, client/src/main.ts) and window.http4 (auto.js, client/src/auto.ts).
import type {} from "../../client/src/main.ts";
import type {} from "../../client/src/auto.ts";
