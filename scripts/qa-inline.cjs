/**
 * scripts/qa-inline.cjs — runs check-inline-js.cjs across every portal page.
 *
 * The frontend is unbundled HTML/CSS/JS, so inline <script> blocks never pass
 * through node --check. This wrapper discovers every .html under public/pages
 * (plus the root login pages) and syntax-checks every inline script block.
 *
 * Part of Phase 4 regression hardening (wires check-inline-js.cjs into CI).
 *
 * Run:  node scripts/qa-inline.cjs
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CHECK = path.join(ROOT, 'scripts', 'check-inline-js.cjs');

function collectHtml(dir, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) collectHtml(p, out);
        else if (entry.name.endsWith('.html')) out.push(p);
    }
}

const files = [];
collectHtml(path.join(ROOT, 'public', 'pages'), files);
// Root login pages live directly under public/pages (already covered by the walk above).
files.sort();

let failed = 0;
for (const f of files) {
    try {
        execFileSync(process.execPath, [CHECK, f], { stdio: 'pipe' });
    } catch (e) {
        failed++;
    }
}

console.log(`\nqa-inline: ${files.length} page(s) checked, ${failed} failure(s).`);
process.exit(failed === 0 ? 0 : 1);
