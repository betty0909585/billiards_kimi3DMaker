# verify_darts2.py — focused close-up capture: one in-page async flow, one
# host round-trip. Expects `node serve.mjs` on :8017.
import asyncio, base64, json
from playwright.async_api import async_playwright

URL = 'http://localhost:8017/'

async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        page = await browser.new_page(viewport={'width': 1600, 'height': 900})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(URL)
        await page.wait_for_selector('#btn-start')
        for _ in range(90):
            if await page.evaluate("() => !!(window.__diorama && window.__diorama.root)"):
                break
            await page.wait_for_timeout(1000)
        await page.evaluate("() => document.getElementById('btn-start').click()")
        await page.wait_for_timeout(600)

        res = await page.evaluate('''() => (async () => {
          const D = window.__debug;
          const until = (fn, ms = 30000) => new Promise((res, rej) => {
            const t0 = performance.now();
            const iv = setInterval(() => {
              if (fn()) { clearInterval(iv); res(1); }
              else if (performance.now() - t0 > ms) { clearInterval(iv); rej(new Error('until timeout')); }
            }, 16);
          });
          const untilFrame = (n) => new Promise(res => {
            const step = () => (--n <= 0 ? res(1) : requestAnimationFrame(step));
            requestAnimationFrame(step);
          });
          const out = { hits: [] };
          D.enterDarts();
          await until(() => window.__game.player.mode === 'darts');
          for (const [i, [dy, dz]] of [[0, [0.1415, 0]], [1, [0, 0]], [2, [0.2285, 0]]]) {
            D.throwDartAt(dy, dz);
            await until(() => D.darts.landed >= i + 1, 45000);
            const h = D.darts.round.darts[i];
            out.hits.push(h.ring + ':' + h.score);
          }
          await until(() => D.darts.push > 0.6, 45000);
          D.updateDarts(0); D.render();
          out.stuck = window.__darts.stuckCount();
          out.total = D.darts.round.total();
          out.shot = document.querySelector('#app canvas').toDataURL('image/png');
          await until(() => D.darts.round.darts.length === 0 && window.__darts.stuckCount() === 0);
          await untilFrame(2);
          D.render();
          out.cleared = document.querySelector('#app canvas').toDataURL('image/png');
          out.best = D.darts.best;
          D.exitDarts();
          out.modeAfter = window.__game.player.mode;
          return out;
        })()''')

        print('hits:', json.dumps(res['hits']), 'total:', res['total'],
              'stuck:', res['stuck'], 'best:', res['best'], 'modeAfter:', res['modeAfter'])
        for key, name in [('shot', 'darts-stuck.png'), ('cleared', 'darts-cleared.png')]:
            with open(f'evidence/{name}', 'wb') as fh:
                fh.write(base64.b64decode(res[key].split(',', 1)[1]))
        print('console errors:', errors if errors else 'none')
        await browser.close()

asyncio.run(main())
