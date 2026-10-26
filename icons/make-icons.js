// Generates icon SVGs for AskChatty: a Claude-orange tile with a cream spark
// burst around a disc carrying an "S". Small sizes drop the rays so they stay crisp.
// Usage: node make-icons.js  → writes icon-<size>.svg next to this file.
const fs = require("fs");
const path = require("path");

const ORANGE = "#D97757";
const ORANGE_DARK = "#C15F3C";
const CREAM = "#FAF9F5";

// Uneven ray lengths give the spark a hand-drawn feel instead of a gear.
const RAYS = [52, 47, 54, 46, 51, 48, 53, 46, 50, 47, 54, 48];

function svg(size) {
  const rays = size >= 32;
  const discR = rays ? 29 : 40;
  const fontSize = rays ? 40 : 58;
  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${ORANGE}"/><stop offset="1" stop-color="${ORANGE_DARK}"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="124" height="124" rx="30" fill="url(#bg)"/>`;
  if (rays) {
    const count = size >= 48 ? 12 : 8;
    const width = size >= 48 ? 8.5 : 11;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 - Math.PI / 2 + Math.PI / count;
      const r1 = discR + 7;
      const r2 = size >= 48 ? RAYS[i] : 52;
      const p = (r) => [(64 + Math.cos(a) * r).toFixed(2), (64 + Math.sin(a) * r).toFixed(2)];
      const [x1, y1] = p(r1);
      const [x2, y2] = p(r2);
      out += `\n  <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${CREAM}" stroke-width="${width}" stroke-linecap="round"/>`;
    }
  }
  out += `
  <circle cx="64" cy="64" r="${discR}" fill="${CREAM}"/>
  <text x="64" y="64" dy="0.355em" text-anchor="middle" font-family="'Segoe UI', Arial, sans-serif" font-weight="800" font-size="${fontSize}" fill="${ORANGE_DARK}">S</text>
</svg>`;
  return out;
}

for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(__dirname, `icon-${size}.svg`), svg(size));
}
