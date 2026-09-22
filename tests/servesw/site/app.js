const r = await fetch("/data.json");
window.__data = await r.json();
