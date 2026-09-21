#!/usr/bin/env node
/* ==========================================================================
   Nexa AI Bot — manifest sanity check

   Chrome reports a broken manifest only when the unpacked extension is
   loaded, so a typo in a script path or a missing icon survives until
   someone tries it in the browser. This parses manifest.json, checks that
   every file it references exists, and syntax-checks every script it loads.
   Runs in CI (.github/workflows/ci.yml) and via `npm run check`.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const problems = [];
const exists = (file) => fs.existsSync(path.join(ROOT, file));

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
} catch (error) {
  console.error('manifest.json does not parse: ' + error.message);
  process.exit(1);
}

if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3');
if (!manifest.name || !manifest.version) problems.push('name and version are required');

// Every file the manifest points at.
const referenced = new Set();
for (const file of Object.values(manifest.icons || {})) referenced.add(file);
if (manifest.action) {
  for (const file of Object.values(manifest.action.default_icon || {})) referenced.add(file);
  if (manifest.action.default_popup) referenced.add(manifest.action.default_popup);
}
if (manifest.background && manifest.background.service_worker) {
  referenced.add(manifest.background.service_worker);
}
const scripts = new Set();
for (const block of manifest.content_scripts || []) {
  for (const file of block.js || []) { referenced.add(file); scripts.add(file); }
  for (const file of block.css || []) referenced.add(file);
}
for (const block of manifest.web_accessible_resources || []) {
  for (const file of block.resources || []) {
    if (!/[*?]/.test(file)) referenced.add(file);
  }
}
for (const file of referenced) {
  if (!exists(file)) problems.push('missing file referenced by manifest.json: ' + file);
}

// Scripts must at least parse — a syntax error in a content script is a
// silent no-op in the browser (the widget just never appears).
if (manifest.background && manifest.background.service_worker) {
  scripts.add(manifest.background.service_worker);
}
for (const file of scripts) {
  if (!exists(file)) continue;
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
  } catch (error) {
    problems.push(file + ' does not parse: ' + String(error.stderr || error.message).trim().split('\n')[0]);
  }
}

// The popup's own scripts (not listed in the manifest) parse too.
if (manifest.action && manifest.action.default_popup && exists(manifest.action.default_popup)) {
  const html = fs.readFileSync(path.join(ROOT, manifest.action.default_popup), 'utf8');
  const dir = path.dirname(manifest.action.default_popup);
  for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
    const file = path.join(dir, match[1]).split(path.sep).join('/');
    if (!exists(file)) { problems.push('popup script missing: ' + file); continue; }
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
    } catch (error) {
      problems.push(file + ' does not parse: ' + String(error.stderr || error.message).trim().split('\n')[0]);
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error('FAIL  ' + problem);
  process.exit(1);
}
console.log('manifest.json OK — ' + referenced.size + ' referenced files present, ' +
  scripts.size + ' scripts parse (v' + manifest.version + ')');
