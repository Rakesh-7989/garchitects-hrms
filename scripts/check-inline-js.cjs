/**
 * scripts/check-inline-js.cjs — syntax gate for the static portal pages.
 *
 * The frontend is unbundled HTML/CSS/JS, so inline <script> blocks never pass
 * through node --check. This extracts every inline (src-less) <script> from the
 * given .html files, concatenates them, and runs `node --check` on the result.
 *
 * Usage:
 *   node scripts/check-inline-js.cjs public/pages/employee/dashboard.html ...
 *
 * Exits 0 when every file parses, 1 when any block has a syntax error.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const files = process.argv.slice(2);
if (!files.length) {
    console.error('usage: node scripts/check-inline-js.cjs <file.html ...>');
    process.exit(2);
}

let failed = false;
for (const f of files) {
    let html;
    try {
        html = fs.readFileSync(f, 'utf8');
    } catch (e) {
        console.error(`  FAIL: cannot read ${f} - ${e.message}`);
        failed = true;
        continue;
    }
    const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    if (!blocks.length) {
        console.log(`  ok (no inline scripts): ${f}`);
        continue;
    }
    const tmp = path.join(
        os.tmpdir(),
        'inline-' + path.basename(f).replace(/[^\w.-]/g, '_') + '-' + process.pid + '.js'
    );
    fs.writeFileSync(tmp, blocks.join('\n;\n'));
    try {
        execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
        console.log(`  ok: ${f} (${blocks.length} inline block${blocks.length === 1 ? '' : 's'})`);
    } catch (e) {
        failed = true;
        console.error(`  FAIL: ${f}`);
        process.stdout.write(String(e.stdout || '') + '\n' + String(e.stderr || ''));
    } finally {
        try { fs.unlinkSync(tmp); } catch (_) { /* best-effort */ }
    }
}
process.exit(failed ? 1 : 0);