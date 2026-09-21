#!/usr/bin/env node
/* ==========================================================================
   Nexa AI Bot — extension icon generator

   Renders icons/icon{16,32,48,128}.png from the brand mark in content.js
   (ICONS.LOGO), so the toolbar / chrome://extensions icon is the same robot
   the floating card shows. Re-run after touching the logo:

     npm run icons              # icons/*.png for the extension
     npm run icons -- --android # android/ adaptive-icon foregrounds

   Needs @resvg/resvg-js (a devDependency): `npm install` once.

   Two cuts of the same mark:
     128 / 48  full logo (both scribble rings) with a soft neon halo
     32 / 16   tile only, zoomed in, thicker strokes — at toolbar size the
               scribble is noise and the face needs every pixel it can get
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

let Resvg;
try {
  ({ Resvg } = require('@resvg/resvg-js'));
} catch {
  console.error('tools/make-icons.js needs @resvg/resvg-js: run `npm install` (it is a devDependency) and retry.');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'icons');

/** The LOGO literal in content.js, evaluated to the SVG markup string. */
function loadLogo() {
  const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const m = src.match(/LOGO: ('<svg class="nexa-logo-svg"[\s\S]*?<\/svg>'),/);
  if (!m) throw new Error('ICONS.LOGO not found in content.js');
  // the literal is a '...' + '...' concatenation with // comment lines between
  const svg = new Function('return ' + m[1].replace(/^\s*\/\/.*$/gm, ''))();
  if (!/<\/svg>$/.test(svg) || !svg.includes('nexa-ring-b')) throw new Error('LOGO markup did not evaluate cleanly');
  return svg;
}

const GLOW =
  '<filter id="nexa-glow" x="-15%" y="-15%" width="130%" height="130%" color-interpolation-filters="sRGB">' +
  // the widget's halo: the mark's silhouette, blurred, tinted purple
  '<feGaussianBlur in="SourceAlpha" stdDeviation="2.2" result="b"/>' +
  '<feFlood flood-color="#a78bfa" flood-opacity=".7"/>' +
  '<feComposite in2="b" operator="in" result="halo"/>' +
  '<feMerge><feMergeNode in="halo"/><feMergeNode in="SourceGraphic"/></feMerge>' +
  '</filter>';

/**
 * One size's SVG. viewBox crops the 100x100 mark; `strokes` / `radii` scale
 * every stroke-width / circle radius (thin lines vanish under ~1px);
 * `rings` false drops the scribble; `glow` adds the halo; `tile` recolours
 * the tile and `ink` replaces the gradient with one flat colour — at toolbar
 * size the gradient turns to mush, so the small cuts use one light violet.
 */
function variant(logo, { viewBox, strokes = 1, radii = 1, rings = true, glow = false, tile = null, ink = null }) {
  let svg = logo
    // standalone SVG needs the namespace the inline (HTML-parsed) markup omits
    .replace(/ class="nexa-logo-svg"/, ' xmlns="http://www.w3.org/2000/svg"')
    .replace(/viewBox="0 0 100 100"/, `viewBox="${viewBox}"`)
    .replace(/stroke-width="([\d.]+)"/g, (_, w) => `stroke-width="${(+w * strokes).toFixed(2)}"`)
    .replace(/ r="([\d.]+)"/g, (_, r) => ` r="${(+r * radii).toFixed(2)}"`);
  if (!rings) {
    // the whole stroke group: ring-a, then the spin group holding ring-b
    svg = svg.replace(/<g fill="none"[^>]*>[\s\S]*?<\/g><\/g>/, '');
    if (svg.includes('nexa-ring')) throw new Error('could not strip the scribble rings');
  }
  if (tile) {
    const before = svg;
    svg = svg.replace(/(<rect x="23" y="23" width="54" height="54" rx="17" fill=")[^"]+(")/, `$1${tile}$2`);
    if (svg === before) throw new Error('could not find the tile rect');
  }
  if (ink) svg = svg.replace(/url\(#nexa-g\)/g, ink);
  if (glow) {
    svg = svg
      .replace('</defs>', GLOW + '</defs>')
      .replace(/<\/defs>([\s\S]*)<\/svg>$/, '</defs><g filter="url(#nexa-glow)">$1</g></svg>');
  }
  return svg;
}

const SIZES = {
  // the full mark spans ~8..92; ~6 units of margin keep the halo off the edge
  128: { viewBox: '2.5 2.5 95 95', glow: true },
  48:  { viewBox: '2.5 2.5 95 95', glow: true, strokes: 1.15 },
  // tile + ears + antenna span x 17.6..82.4, y 8.6..78.3
  32:  { viewBox: '13 6.5 74 74', rings: false, strokes: 1.35, radii: 1.15, ink: '#c4b5fd' },
  16:  { viewBox: '13 6.5 74 74', rings: false, strokes: 2.1, radii: 1.5, ink: '#c4b5fd' },
};

function render(svg, size) {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' });
  const img = r.render();
  if (img.width !== size || img.height !== size) throw new Error(`rendered ${img.width}x${img.height}, wanted ${size}`);
  return img.asPng();
}

/** A contact sheet: every icon at 1x and 4x (pixelated), on dark and light. */
function previewSheet(pngs) {
  const cell = 128 * 4 + 40;
  const rows = ['#202124', '#ffffff'];
  let body = '';
  rows.forEach((bg, row) => {
    const y0 = row * cell;
    body += `<rect x="0" y="${y0}" width="${cell * 4}" height="${cell}" fill="${bg}"/>`;
    Object.keys(pngs).forEach((size, col) => {
      const uri = 'data:image/png;base64,' + pngs[size].toString('base64');
      const x0 = col * cell + 20, y = y0 + 20;
      body += `<image href="${uri}" x="${x0}" y="${y}" width="${size * 4}" height="${size * 4}" image-rendering="optimizeSpeed"/>`;
      body += `<image href="${uri}" x="${x0}" y="${y + size * 4 + 12}" width="${size}" height="${size}"/>`;
      body += `<text x="${x0 + size + 8}" y="${y + size * 4 + 12 + size}" font-family="sans-serif" font-size="18" fill="${row ? '#333' : '#ddd'}">${size}px</text>`;
    });
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cell * 4}" height="${cell * 2}">${body}</svg>`;
  return new Resvg(svg).render().asPng();
}

// Android adaptive-icon foreground: the launcher masks the outer 17% on
// every side, so the mark is drawn inside the central 66% (the safe zone)
// of a 108dp canvas, on the navy the app's ic_launcher.xml supplies.
const ANDROID_DENSITIES = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };

function androidIcons(logo, resDir) {
  const svg = variant(logo, { viewBox: '-13.5 -13.5 127 127', glow: true });
  for (const [density, size] of Object.entries(ANDROID_DENSITIES)) {
    const dir = path.join(resDir, 'mipmap-' + density);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'ic_launcher_foreground.png');
    fs.writeFileSync(file, render(svg, size));
    console.log('wrote ' + path.relative(ROOT, file) + ' (' + size + 'px)');
  }
}

function main() {
  const logo = loadLogo();
  if (process.argv.includes('--android')) {
    androidIcons(logo, path.join(ROOT, 'android', 'app', 'src', 'main', 'res'));
    return;
  }
  const pngs = {};
  for (const [size, cfg] of Object.entries(SIZES)) {
    pngs[size] = render(variant(logo, cfg), +size);
    const file = path.join(OUT, `icon${size}.png`);
    fs.writeFileSync(file, pngs[size]);
    console.log(`wrote ${path.relative(ROOT, file)} (${pngs[size].length} bytes)`);
  }
  if (process.argv.includes('--preview')) {
    const file = path.resolve(process.argv[process.argv.indexOf('--preview') + 1] || 'icons-preview.png');
    fs.writeFileSync(file, previewSheet(pngs));
    console.log(`wrote preview ${file}`);
  }
}

main();
