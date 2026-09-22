// The page itself (this script, style.css, the banner) loads over plain HTTP.
// Here the HTTP4 client, served by http4d at /http4/http4.js, fetches the
// greeting and the badge. If WebTransport isn't available the same calls
// fall back to ordinary fetch, and the report below says which was used.
import { connect } from "/http4/http4.js";

// Under `http4d serve` every site path is an asset, so the prefix is "/".
const http4 = await connect({ assetPrefix: "/" });

const data = await (await http4.fetch("/data.json")).json();
document.getElementById("greeting").textContent = data.greeting;

const badge = await http4.fetch("/images/badge.png");
document.getElementById("badge").src = URL.createObjectURL(await badge.blob());

const rows = document.querySelector("#report tbody");
for (const r of http4.report()) {
  const tr = rows.insertRow();
  for (const v of [new URL(r.url).pathname, r.transport, r.status, r.bytes ?? "?", r.ms.toFixed(1)]) tr.insertCell().textContent = v;
  tr.cells[1].className = r.transport;
  if (r.reason) tr.cells[1].title = r.reason;
}
document.getElementById("status").textContent = http4.available
  ? "HTTP4 session open."
  : `HTTP4 unavailable (${http4.unavailableReason}); everything came over plain HTTP.`;

// For tests and the curious: the handle and what it did.
window.__hello = { http4, data, done: true };
