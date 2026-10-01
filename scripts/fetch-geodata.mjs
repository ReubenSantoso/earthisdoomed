// One-time setup: download Natural Earth admin-0 countries into public/data/.
// The app never fetches these from the network at runtime; it reads the local copies.
// Source: the official Natural Earth vector repository (public domain).
//   node scripts/fetch-geodata.mjs          download if missing
//   node scripts/fetch-geodata.mjs --force  re-download
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'data');
const BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';

// 50m is used for point-in-polygon tagging (keeps small island states),
// 110m for drawing outlines on the globe (lighter to triangulate).
const FILES = [
  { src: 'ne_50m_admin_0_countries.geojson', out: 'countries-50m.geojson', precision: 3 },
  { src: 'ne_110m_admin_0_countries.geojson', out: 'countries-110m.geojson', precision: 2 },
];

const force = process.argv.includes('--force');

function round(coords, p) {
  if (typeof coords[0] === 'number') {
    const f = 10 ** p;
    return [Math.round(coords[0] * f) / f, Math.round(coords[1] * f) / f];
  }
  return coords.map((c) => round(c, p));
}

// Natural Earth's NAME field abbreviates ("Dem. Rep. Congo", "S. Geo. and the Is.").
// Keep NAME unless it is abbreviated, then use the long or English form.
const NAME_OVERRIDES = { 'United States of America': 'United States' };
function displayName(p) {
  const abbreviated = (s) => !s || s.includes('.');
  let name = p.NAME;
  if (abbreviated(name)) name = !abbreviated(p.NAME_LONG) ? p.NAME_LONG : p.NAME_EN || p.NAME;
  return NAME_OVERRIDES[name] ?? name;
}

function slim(fc, precision) {
  return {
    type: 'FeatureCollection',
    features: fc.features
      .filter((f) => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'))
      .map((f) => {
        const p = f.properties;
        const iso3 = [p.ISO_A3, p.ISO_A3_EH, p.ADM0_A3].find((v) => v && v !== '-99') ?? p.ADM0_A3;
        return {
          type: 'Feature',
          properties: {
            name: displayName(p),
            iso3,
            continent: p.CONTINENT,
            subregion: p.SUBREGION,
          },
          geometry: { type: f.geometry.type, coordinates: round(f.geometry.coordinates, precision) },
        };
      }),
  };
}

mkdirSync(outDir, { recursive: true });
let failed = false;
for (const file of FILES) {
  const target = join(outDir, file.out);
  if (existsSync(target) && !force) {
    console.log(`[geodata] ${file.out} already present`);
    continue;
  }
  try {
    console.log(`[geodata] downloading ${file.src}`);
    const res = await fetch(`${BASE}/${file.src}`, {
      headers: { 'User-Agent': 'earthisdoomed setup script' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const fc = await res.json();
    const out = slim(fc, file.precision);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(out));
    console.log(`[geodata] wrote ${file.out} (${out.features.length} countries)`);
  } catch (err) {
    failed = true;
    console.warn(`[geodata] could not download ${file.src}: ${err.message}`);
  }
}
// Never fail `npm install` over this; the app degrades to untagged events.
if (failed) console.warn('[geodata] some files are missing; run `npm run fetch:geo` when online.');
