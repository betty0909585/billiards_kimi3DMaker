# verify_bar.py — headless acceptance for the three bar-stool games.
# Expects `node serve.mjs` on :8017.
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

        async def shot(expr, name):
            data = await page.evaluate(f'''() => {{
              window.__debug.render();
              return document.querySelector('#app canvas').toDataURL('image/png');
            }}''')
            with open(f'evidence/{name}', 'wb') as fh:
                fh.write(base64.b64decode(data.split(',', 1)[1]))

        # ---------- station hints ----------
        hints = {}
        for sid, (x, z) in {'darts': (-0.67, -2.20), 'drink': (-1.8, -2.85),
                            'dice': (-0.7, -2.85), 'roulette': (0.4, -2.85)}.items():
            await page.evaluate(f'''() => {{
              const g = window.__game;
              g.player.pos.set({x}, 1.62, {z});
              g.player.yaw = 0; g.player.pitch = -0.1;
            }}''')
            await page.wait_for_timeout(350)
            hints[sid] = await page.text_content('#hint')
        print('station hints:', json.dumps(hints, ensure_ascii=False))

        # ---------- drink ----------
        res = await page.evaluate('''() => (async () => {
          const D = window.__debug;
          D.enterDrink();
          const until = (fn, ms = 400000) => new Promise((res, rej) => {
            const t0 = performance.now();
            const iv = setInterval(() => {
              if (fn()) { clearInterval(iv); res(1); }
              else if (performance.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout')); }
            }, 16);
          });
          const out = {};
          // the glass starts empty: first LMB pours from the bottle
          D.barGames.drink.primary();
          await until(() => D.barGames.drink.pourT < 0 && D.barGames.drink.fill > 0.9);
          out.fillAfterPour = D.barGames.drink.fill;
          D.barGames.drink.primary(); // pick the glass up
          await until(() => D.barGames.lift.glass > 0.9);
          D.barGames.drink.primary(); // sip 1
          await until(() => D.barGames.drink.sipT < 0 && D.barGames.drink.count === 1);
          D.barGames.drink.primary(); // sip 2
          await until(() => D.barGames.drink.count === 2);
          out.count = D.barGames.drink.count;
          out.fill = D.barGames.drink.fill;
          out.tipsy = D.barGames.tipsy();
          out.barText = document.getElementById('bar-ui').textContent;
          // one more pour cycle (glass should be low now)
          D.barGames.drink.primary();
          await until(() => D.barGames.drink.pourT > 0.2 || D.barGames.drink.sipT > 0, 15000);
          out.thirdAction = D.barGames.drink.pourT >= 0 ? 'pour' : 'sip';
          await until(() => D.barGames.drink.pourT < 0 && D.barGames.drink.sipT < 0);
          return out;
        })()''')
        await shot(None, 'bar-drink.png')
        await page.evaluate('''() => (async () => {
          const D = window.__debug;
          await new Promise(r => setTimeout(r, 900));
          D.exitBar();
        })()''')
        print('drink:', json.dumps(res, ensure_ascii=False))

        # ---------- dice ----------
        res = await page.evaluate('''() => (async () => {
          const D = window.__debug;
          D.enterDice();
          const until = (fn, ms = 400000) => new Promise((res, rej) => {
            const t0 = performance.now();
            const iv = setInterval(() => {
              if (fn()) { clearInterval(iv); res(1); }
              else if (performance.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout')); }
            }, 16);
          });
          D.barGames.dice.primary(); // roll round 1
          await until(() => D.barGames.dice.st === 'show');
          const s1 = { ...D.barGames.dice.match.score() };
          const last1 = D.barGames.dice.last;
          D.barGames.dice.primary(); // round 2
          await until(() => D.barGames.dice.st === 'show' && D.barGames.dice.match.score().round === 2);
          const s2 = { ...D.barGames.dice.match.score() };
          let s3 = null;
          if (!s2.over) {
            D.barGames.dice.primary();
            await until(() => D.barGames.dice.st === 'show' && D.barGames.dice.match.score().round === 3);
            s3 = { ...D.barGames.dice.match.score() };
          }
          return { last1, s1, s2, s3,
                   barText: document.getElementById('bar-ui').textContent };
        })()''')
        await shot(None, 'bar-dice.png')
        print('dice:', json.dumps(res, ensure_ascii=False))
        await page.evaluate('() => window.__debug.exitBar()')

        # ---------- roulette (force click + force bang via rng stub) ----------
        res = await page.evaluate('''() => (async () => {
          const D = window.__debug;
          D.enterRoulette();
          const until = (fn, ms = 400000) => new Promise((res, rej) => {
            const t0 = performance.now();
            const iv = setInterval(() => {
              if (fn()) { clearInterval(iv); res(1); }
              else if (performance.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout')); }
            }, 16);
          });
          const out = {};
          await until(() => D.barGames.lift.gun > 0.9); // revolver picked up
          D.barGames.roulette.primary(); // spin -> raise -> fire
          await until(() => D.barGames.roulette.st === 'idle');
          out.afterFirst = { st: D.barGames.roulette.st, streak: D.barGames.roulette.streak };
          return out;
        })()''')
        print('roulette pull 1:', json.dumps(res, ensure_ascii=False))
        await shot(None, 'bar-roulette.png')
        # second pull for the gun-raise visual, then exit (whichever outcome)
        res2 = await page.evaluate('''() => (async () => {
          const D = window.__debug;
          const until = (fn, ms = 400000) => new Promise((res, rej) => {
            const t0 = performance.now();
            const iv = setInterval(() => {
              if (fn()) { clearInterval(iv); res(1); }
              else if (performance.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout')); }
            }, 16);
          });
          D.barGames.roulette.primary();
          await until(() => D.barGames.roulette.st === 'raise');
          return { st: D.barGames.roulette.st };
        })()''')
        await shot(None, 'bar-roulette-raise.png')
        res3 = await page.evaluate('''() => (async () => {
          const D = window.__debug;
          const until = (fn, ms = 400000) => new Promise((res, rej) => {
            const t0 = performance.now();
            const iv = setInterval(() => {
              if (fn()) { clearInterval(iv); res(1); }
              else if (performance.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout')); }
            }, 16);
          });
          await until(() => ['idle', 'dead'].includes(D.barGames.roulette.st) && D.barGames.roulette.t > 0.2);
          const wasDead = D.barGames.roulette.st === 'dead';
          if (wasDead) await until(() => D.barGames.roulette.st === 'idle');
          return { wasDead, streak: D.barGames.roulette.streak, veil: document.getElementById('veil').style.opacity };
        })()''')
        print('roulette pull 2:', json.dumps(res3, ensure_ascii=False))
        await page.evaluate('() => window.__debug.exitBar()')
        mode = await page.text_content('#mode')
        print('mode after exit:', json.dumps(mode, ensure_ascii=False))
        print('console errors:', errors if errors else 'none')
        await browser.close()

asyncio.run(main())
