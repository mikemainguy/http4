// Writes the demo's gallery images into img/ (gitignored): twelve valid PNGs
// of a few hundred KB each, drawn procedurally from a fixed seed, so every
// run and every machine gets the same bytes and nothing large is committed.
//
//   node examples/demo-site/gen-images.ts
//
// Each image is a smooth colour field (sums of sinusoids) plus fine grain.
// The grain keeps PNG from compressing them to nothing, which makes them
// behave like photos on the wire: large, and incompressible in transit.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

const dir = path.join(import.meta.dirname, "img");

// Widths vary so the gallery mixes small and large transfers, which is what
// makes SRPT's completion order visible in the panel.
export const IMAGES: { name: string; w: number; h: number; hue: number }[] = [
  { name: "harbor.png", w: 720, h: 480, hue: 0.55 },
  { name: "dunes.png", w: 360, h: 240, hue: 0.1 },
  { name: "forest.png", w: 600, h: 400, hue: 0.33 },
  { name: "glacier.png", w: 480, h: 320, hue: 0.6 },
  { name: "canyon.png", w: 540, h: 360, hue: 0.05 },
  { name: "meadow.png", w: 300, h: 200, hue: 0.25 },
  { name: "reef.png", w: 660, h: 440, hue: 0.5 },
  { name: "tundra.png", w: 420, h: 280, hue: 0.7 },
  { name: "lagoon.png", w: 768, h: 512, hue: 0.45 },
  { name: "volcano.png", w: 450, h: 300, hue: 0.02 },
  { name: "prairie.png", w: 390, h: 260, hue: 0.15 },
  { name: "aurora.png", w: 570, h: 380, hue: 0.8 },
];

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hsv(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6]!;
  return [r! * 255, g! * 255, b! * 255];
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  td.copy(out, 4);
  out.writeUInt32BE(crc32(td), 8 + data.length);
  return out;
}

export function png(w: number, h: number, hue: number, seed: number): Buffer {
  const rand = mulberry32(seed);
  const waves = Array.from({ length: 5 }, () => ({ fx: 1 + rand() * 5, fy: 1 + rand() * 4, ph: rand() * 6.28, a: 0.3 + rand() * 0.7 }));
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      let f = 0;
      for (const wv of waves) f += wv.a * Math.sin((x / w) * wv.fx * 6.28 + (y / h) * wv.fy * 6.28 + wv.ph);
      const t = 0.5 + f / 6;
      const [r, g, b] = hsv(hue + t * 0.18, 0.55 + 0.35 * t, 0.35 + 0.6 * (y / h) * 0.4 + 0.4 * t);
      const grain = () => (rand() - 0.5) * 28;
      raw[o++] = Math.max(0, Math.min(255, r + grain()));
      raw[o++] = Math.max(0, Math.min(255, g + grain()));
      raw[o++] = Math.max(0, Math.min(255, b + grain()));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

if (import.meta.main) {
  mkdirSync(dir, { recursive: true });
  let total = 0;
  IMAGES.forEach((im, i) => {
    const b = png(im.w, im.h, im.hue, 1000 + i);
    writeFileSync(path.join(dir, im.name), b);
    total += b.length;
  });
  console.log(`wrote ${IMAGES.length} images (${(total / 1e6).toFixed(1)} MB) to ${path.relative(process.cwd(), dir) || dir}`);
}
