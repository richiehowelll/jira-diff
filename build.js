// build.js  –  node build.js chrome  |  node build.js firefox
const fs   = require('fs');
const path = require('path');

const target = process.argv[2];                    // "chrome" | "firefox"
if (!target) throw new Error('Please pass "chrome" or "firefox"');

// 1. merge manifests ---------------------------------------------------------
const base  = JSON.parse(fs.readFileSync('manifest.base.json'));
const patch = JSON.parse(fs.readFileSync(`manifest.${target}.json`));
const outManifest = Object.assign({}, base, patch);

// 2. copy everything into dist/<target> --------------------------------------
const outDir = path.join('dist', target);
fs.rmSync(outDir, { recursive: true, force: true });   // clean slate
fs.mkdirSync(outDir, { recursive: true });

/**
 * Recursively copy "src" → "dst", skipping dist/ itself.
 */
function copyRecursive(src, dst) {
  if (src.startsWith('dist')) return;               // skip build output
  const stat = fs.statSync(src);

  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
  } else {
    fs.copyFileSync(src, dst);
  }
}
copyRecursive('.', outDir);                         // copy project root

// 3. overwrite the manifest we just copied -----------------------------------
fs.writeFileSync(
  path.join(outDir, 'manifest.json'),
  JSON.stringify(outManifest, null, 2)
);

console.log(`✓ Built dist/${target}/ with ${Object.keys(outManifest).length} manifest keys`);
