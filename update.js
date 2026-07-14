// DropCull self-updater.
// Runs before the app starts (the launchers call it). Checks GitHub for a newer
// VERSION; if found, downloads the repo zip and installs it over this folder.
// FAIL-SAFE BY DESIGN: any problem — no internet, GitHub down, bad zip — and it
// exits quietly so the app just starts with the version already installed.
//
// Exit codes: 0 = nothing to do (or update failed safely), 10 = updated
// (launchers see 10 and run `npm install` in case dependencies changed).
//
// Never overwrites the launchers (DropCull.bat / DropCull.command): a batch file
// must not be rewritten while it is executing.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO = 'Anthonyskoczylas/dropcull';
const RAW_VERSION = `https://raw.githubusercontent.com/${REPO}/main/VERSION`;
const ZIP_URL = `https://codeload.github.com/${REPO}/zip/refs/heads/main`;
const SKIP = new Set(['DropCull.bat', 'DropCull.command', 'node_modules', '.git', '_DropCull', 'fixtures']);

function copyInto(srcDir, dstDir) {
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const s = path.join(srcDir, e.name), d = path.join(dstDir, e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyInto(s, d); }
    else fs.copyFileSync(s, d);
  }
}

(async () => {
  try {
    const local = fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim();
    const remote = (await (await fetch(RAW_VERSION, { signal: AbortSignal.timeout(6000) })).text()).trim();
    if (!/^[\w.\-]+$/.test(remote) || remote === local) return;

    console.log(`  New DropCull version found (${local} → ${remote}) — updating…`);
    const zip = Buffer.from(await (await fetch(ZIP_URL, { signal: AbortSignal.timeout(120000) })).arrayBuffer());

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dropcull-update-'));
    const zipPath = path.join(tmp, 'update.zip');
    fs.writeFileSync(zipPath, zip);
    // tar ships with Windows 10+ and macOS, and it extracts zips too.
    execFileSync('tar', ['-xf', zipPath, '-C', tmp]);

    const src = path.join(tmp, 'dropcull-main');
    if (!fs.existsSync(path.join(src, 'server.js'))) throw new Error('bad update package');
    copyInto(src, __dirname);
    fs.rmSync(tmp, { recursive: true, force: true });

    console.log('  Updated. Finishing up…');
    process.exit(10);
  } catch {
    // Offline, GitHub unreachable, or anything unexpected: start the app as-is.
  }
})();
