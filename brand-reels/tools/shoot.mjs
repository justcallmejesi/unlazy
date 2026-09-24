import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=')];
}));
const palette = args.p || 'p1';
const variant = args.v || 'v1';
const photo   = args.photo ? `&photo=${encodeURIComponent(args.photo)}` : '';
const outDir  = args.out;
const port    = args.port || '8899';
const times   = args.times ? args.times.split(',').map(Number) : null;
const fps     = Number(args.fps || 30);
const dur     = Number(args.dur || 10);

fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--force-color-profile=srgb', '--disable-lcd-text', '--font-render-hinting=none',
         '--hide-scrollbars', '--disable-gpu']
});
const page = await browser.newPage({
  viewport: { width: 720, height: 1280 },
  deviceScaleFactor: 1
});
await page.goto(`http://127.0.0.1:${port}/index.html?p=${palette}&v=${variant}${photo}`, { waitUntil: 'load' });
await page.waitForFunction('window.READY === true', null, { timeout: 60000 });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(400);

const list = times ?? Array.from({ length: Math.round(fps * dur) }, (_, i) => i / fps);
let n = 0;
for (const t of list) {
  await page.evaluate(tt => window.renderFrame(tt), t);
  const name = times ? `t${t.toFixed(2)}.png` : `f${String(n).padStart(4, '0')}.png`;
  await page.screenshot({ path: path.join(outDir, name) });
  n++;
  if (!times && n % 60 === 0) process.stdout.write(`  ${n}/${list.length}\n`);
}
await browser.close();
console.log(`done: ${n} frames -> ${outDir}`);
