'use strict';

const fs = require('fs');
const path = require('path');

const htmlPath =
  process.argv[2] || path.join(process.env.HOME, 'Downloads', 'tick-website-v26 final.html');
const outPath = path.join(__dirname, '..', 'server', 'seed-data.json');

const html = fs.readFileSync(htmlPath, 'utf8');

function sliceArrayConst(name, nextLinePrefix) {
  const start = html.indexOf(`const ${name}=`);
  if (start < 0) throw new Error(`Missing ${name}`);
  const open = html.indexOf('[', start);
  const next = html.indexOf(nextLinePrefix, open);
  if (next < 0) throw new Error(`Missing end marker after ${name}`);
  const inner = html.slice(open, next).trim();
  return new Function(`return ${inner}`)();
}

const products = sliceArrayConst('DEFAULT_PRODS', '\nconst DEFAULT_ARCHIVE');
const archive = sliceArrayConst('DEFAULT_ARCHIVE', '\nconst DEFAULT_STRAPS');
const straps = sliceArrayConst('DEFAULT_STRAPS', '\nconst DEFAULT_SETTINGS');
const settingsMatch = html.match(/const DEFAULT_SETTINGS=(\{[\s\S]*?\});/);
if (!settingsMatch) throw new Error('DEFAULT_SETTINGS');
const settings = new Function(`return ${settingsMatch[1]}`)();
const episodes = sliceArrayConst('DEFAULT_EPISODES', '\nconst ANNOUNCES');

const payload = { products, archive, straps, episodes, settings };
fs.writeFileSync(outPath, JSON.stringify(payload, null, 0));
console.log('Wrote', outPath, {
  products: products.length,
  archive: archive.length,
  straps: straps.length,
  episodes: episodes.length,
});
