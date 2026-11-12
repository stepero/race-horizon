// Spustí hru v Chrome (puppeteer-core) a uloží snímky obrazovky do ./shots
// Použitie: npm run dev (v inom termináli) a potom
//   node scripts/screenshot.mjs "<query>" <názov> [čakanie_v_s] [url]
// napr.: node scripts/screenshot.mjs "quick=monza&laps=2" monza 8
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const query = process.argv[2] ?? '';
const name = process.argv[3] ?? 'shot';
const wait = Number(process.argv[4] ?? 6);
const base = process.argv[5] ?? 'http://localhost:5173/';
const hold = (process.argv[6] ?? '').split(',').filter(Boolean); // klávesy držané počas čakania, napr. ArrowUp

fs.mkdirSync('shots', { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1440,810'],
  defaultViewport: { width: 1440, height: 810 },
});
try {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(`${base}${query ? '?' + query : ''}`, { waitUntil: 'load' });
  // CLICK="Okruhové preteky,Štart" – postupne klikne na tlačidlá podľa textu
  for (const label of (process.env.CLICK ?? '').split(',').filter(Boolean)) {
    await new Promise((r) => setTimeout(r, 500));
    const ok = await page.evaluate((txt) => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.toLowerCase().includes(txt.toLowerCase()));
      if (b) b.click();
      return !!b;
    }, label);
    if (!ok) console.log(`tlačidlo "${label}" sa nenašlo`);
  }
  // EVAL="<js>" – po načítaní spustí kód v stránke (napr. pretočenie pretekov cez window.__rh.race)
  if (process.env.EVAL) {
    if (query.includes('quick')) await page.waitForFunction(() => window.__rh?.race, { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 500));
    console.log('eval:', JSON.stringify(await page.evaluate(process.env.EVAL)));
  }
  for (const k of hold) await page.keyboard.down(k);
  await new Promise((r) => setTimeout(r, wait * 1000));
  const out = `shots/${name}.png`;
  await page.screenshot({ path: out });
  const info = await page.evaluate(() => {
    const rh = window.__rh;
    const r = rh?.race;
    if (!r) return null;
    const p = r.player;
    return { phase: r.phase, time: +r.time.toFixed(1), speedKph: +(p.st.vx * 3.6).toFixed(0), pos: p.pos, lap: p.lapsDone, surface: p.surface, fuel: +p.st.fuel.toFixed(1) };
  });
  console.log(out, JSON.stringify(info));
  if (logs.length) console.log(logs.slice(0, 15).join('\n'));
} finally {
  await browser.close();
}
