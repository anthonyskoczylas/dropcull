// Builds a fake card dump in fixtures/ so DropCull can be tested end to end:
// sharp/blurry/dark/bright photos, a 3-shot burst, and a short video,
// spread across two "shoots" via file timestamps.
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';

const exec = promisify(execFile);
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
await fs.rm(dir, { recursive: true, force: true });
await fs.mkdir(dir, { recursive: true });

// A detail-rich test scene: gradients, grid lines, text — plenty of edges for
// the blur detector to chew on.
function sceneSVG(shift = 0) {
  let details = '';
  for (let i = 0; i < 30; i++) {
    const x = (i * 61 + shift) % 1660;
    details += `<line x1="${x}" y1="0" x2="${x + 140}" y2="1080" stroke="#1f2937" stroke-width="2"/>`;
    details += `<circle cx="${(x * 1.7 + 200) % 1660}" cy="${(i * 137) % 1080}" r="${8 + (i % 5) * 6}" fill="hsl(${(i * 47) % 360},70%,55%)"/>`;
    details += `<text x="${(x + 60) % 1500}" y="${(i * 89 + 40) % 1040}" font-size="22" fill="#e5e7eb" font-family="monospace">DC-${i}-sample-text</text>`;
  }
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1660" height="1080">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0e7490"/><stop offset="0.5" stop-color="#fbbf24"/><stop offset="1" stop-color="#7c2d12"/>
    </linearGradient></defs>
    <rect width="1660" height="1080" fill="url(#g)"/>${details}</svg>`);
}

const base = await sharp(sceneSVG()).jpeg({ quality: 90 }).toBuffer();
const write = (name, buf) => fs.writeFile(path.join(dir, name), buf);

// Shoot A (morning): sharp base, 3-shot burst, one blurry
await write('IMG_0001.jpg', base);
for (let i = 0; i < 3; i++) {
  const b = await sharp(sceneSVG(i * 4)).jpeg({ quality: 90 }).toBuffer(); // tiny shift = burst twins
  await write(`IMG_000${2 + i}.jpg`, b);
}
await write('IMG_0005.jpg', await sharp(base).blur(14).jpeg().toBuffer());

// Shoot B (afternoon): dark, bright, normal, video
await write('DJI_0101.jpg', await sharp(base).linear(0.12, 0).jpeg().toBuffer());   // way underexposed
await write('DJI_0102.jpg', await sharp(base).linear(2.4, 90).jpeg().toBuffer());   // blown out
await write('DJI_0103.jpg', await sharp(sceneSVG(500)).jpeg({ quality: 90 }).toBuffer());
await exec(ffmpegPath, ['-f', 'lavfi', '-i', 'testsrc2=duration=3:size=640x360:rate=30',
  '-pix_fmt', 'yuv420p', '-y', path.join(dir, 'DJI_0104.mp4')]);

// Timestamps: shoot A ~8:00, burst 3s apart; shoot B ~15:00 (>3h gap => new shoot)
const t = (h, m, s = 0) => new Date(2026, 6, 8, h, m, s);
const times = {
  'IMG_0001.jpg': t(8, 0), 'IMG_0002.jpg': t(8, 2, 0), 'IMG_0003.jpg': t(8, 2, 3),
  'IMG_0004.jpg': t(8, 2, 6), 'IMG_0005.jpg': t(8, 9),
  'DJI_0101.jpg': t(15, 0), 'DJI_0102.jpg': t(15, 2), 'DJI_0103.jpg': t(15, 4), 'DJI_0104.mp4': t(15, 6),
};
for (const [name, d] of Object.entries(times)) await fs.utimes(path.join(dir, name), d, d);

console.log('fixtures ready →', dir);
