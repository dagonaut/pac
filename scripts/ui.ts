// Browser test: two players (fake camera/mic) in headless Chromium play through import, draw,
// drag and drop, preview, tap/flip, sheets, fields and undo, and check they see the same thing.
//   PAC_KEY=<table key> npx tsx scripts/ui.ts [site] [card image] [screenshot dir]
// Defaults: http://localhost:5173 (run `VTT_SITE_URL=https://vtt.16watt.com npm run dev`),
// the first image in images/, and ./ui-shots. Archives its room "zz-ui-<time>" at the end.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';

const site = process.argv[2] ?? 'http://localhost:5173';
const image = process.argv[3] ?? path.join('images', readdirSync('images').find((f) => /\.(png|jpe?g|webp)$/i.test(f))!);
const shots = process.argv[4] ?? 'ui-shots';
const key = process.env.PAC_KEY ?? '';
if (!key) throw new Error('Set PAC_KEY to the table key.');
mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const shot = (p: Page, name: string) => p.screenshot({ path: path.join(shots, `${name}.png`) });

async function player(name: string, url = site) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] page error:`, e.message));
  page.on('console', (m) => (m.type() === 'error' || process.env.DEBUG) && console.log(`[${name}] console ${m.type()}:`, m.text()));
  await page.goto(url);
  await page.fill('#who input[name=name]', name);
  await page.fill('#who input[name=key]', key);
  await page.click('#who button[type=submit]');
  await page.waitForSelector('#rooms:not([hidden])');
  return page;
}

const log = (p: Page) => p.locator('#log').innerText();
const untilLog = (p: Page, text: string) => p.waitForFunction((t) => document.querySelector('#log')!.textContent!.includes(t), text, { timeout: 15000 });

// ---- Ana creates a room with the Example system --------------------------------------------
const ana = await player('Ana');
await shot(ana, '01-lobby');
const roomName = `zz-ui-${Date.now()}`;
await ana.fill('#new-room input[name=name]', roomName);
await ana.selectOption('#new-room select[name=system]', 'example');
await ana.click('#new-room button[type=submit]');
await ana.waitForSelector('#room-view:not([hidden])', { timeout: 20000 });
await ana.waitForSelector('.zone[data-zone=loot]');
const roomId = new URL(ana.url()).searchParams.get('room')!;
console.log('room', roomId);

// ---- Import the card into the loot deck ------------------------------------------------------
await ana.click('text=Import cards');
await ana.setInputFiles('dialog.import input[type=file] >> nth=0', image);
await ana.selectOption('dialog.import select', 'loot');
await shot(ana, '02-import-dialog');
await ana.click('dialog.import button[type=submit]');
await untilLog(ana, 'imported');
assert.match(await ana.locator('.zone[data-zone=loot] .zone-head small').innerText(), /^1$/);

// ---- Draw it to the market --------------------------------------------------------------------
await ana.click('.zone[data-zone=loot] .pile-stack');
await ana.click('.draw-box button[type=submit]');
const marketCard = ana.locator('.zone[data-zone=market] .piece');
await marketCard.waitFor();
assert.match((await marketCard.locator('img').getAttribute('src'))!, /^\/assets\//);
await ana.waitForFunction(() => (document.querySelector('.zone[data-zone=market] .piece img') as HTMLImageElement)?.naturalWidth > 0);
await shot(ana, '03-drawn-to-market');

// ---- Drag it onto the table ------------------------------------------------------------------
const box = (await marketCard.boundingBox())!;
const table = (await ana.locator('.table-wrap').boundingBox())!;
await ana.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await ana.mouse.down();
await ana.mouse.move(table.x + 300, table.y + 200, { steps: 12 });
await ana.mouse.up();
const tableCard = ana.locator('.table-surface .piece');
await tableCard.waitFor();

// Hover shows the large preview.
await tableCard.hover();
await ana.waitForSelector('.preview:not([hidden]) img');
await shot(ana, '04-table-with-preview');

// ---- Tap via the menu, flip via the keyboard ---------------------------------------------------
await tableCard.click();
await ana.click('.menu >> text=Tap');
await ana.waitForSelector('.table-surface .piece.tapped');
await tableCard.hover();
await ana.keyboard.press('f');
await ana.waitForSelector('.table-surface .piece.face-down');
await untilLog(ana, 'flipped');

// ---- Bo joins from the invite link and sees the same table -------------------------------------
const bo = await player('Bo', `${site}/?room=${roomId}`);
await bo.click('#room-list li.invited button:text-is("Join")');
await bo.waitForSelector('#room-view:not([hidden])', { timeout: 20000 });
await bo.waitForSelector('.table-surface .piece.tapped.face-down');
assert.match(await log(bo), /imported/);

// ---- Sheets: Ana creates hers and slots the card as a weapon ----------------------------------
await ana.click('text=Create my sheet');
await ana.waitForSelector('.sheet .slot[data-slot="0"]');
await ana.locator('.table-surface .piece').hover();
await ana.keyboard.press('f'); // face up again
await ana.waitForSelector('.table-surface .piece:not(.face-down)');
const from = (await ana.locator('.table-surface .piece').boundingBox())!;
const slot = (await ana.locator('.sheet .slot[data-slot="0"]').boundingBox())!;
await ana.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
await ana.mouse.down();
await ana.mouse.move(slot.x + slot.width / 2, slot.y + slot.height / 2, { steps: 12 });
await ana.mouse.up();
await ana.waitForSelector('.sheet .slot[data-slot="0"] .piece');

// HP + then undo.
const hp = ana.locator('.field:has(label:text-is("HP"))');
await hp.locator('button:text-is("+")').click();
await ana.waitForFunction(() => (document.querySelector('.field input[data-field$="/HP"]') as HTMLInputElement)?.value === '11');
await ana.keyboard.press('Control+z');
await ana.waitForFunction(() => (document.querySelector('.field input[data-field$="/HP"]') as HTMLInputElement)?.value === '10');
await shot(ana, '05-sheet');

// Library: add a second copy to the table, then make it bigger.
await ana.click('.bar-actions >> text=Library');
await ana.click('dialog .library .thumb');
await ana.click('.menu .menu-item:text-is("Table")');
await ana.waitForSelector('.table-surface .piece');
await ana.click('dialog >> text=Close');
await ana.locator('.table-surface .piece').click();
await ana.click('.menu .size-row button[title=Bigger]');
await ana.waitForFunction(() => (document.querySelector('.table-surface .piece') as HTMLElement)?.style.getPropertyValue('--scale') === '1.5');
await shot(ana, '05b-library-copy-bigger');

// Bo sees Ana's sheet tab with the card in the Weapon slot.
await bo.click('.dock-tab:text("Ana")');
await bo.waitForSelector('.sheet .slot[data-slot="0"] .piece');
await shot(bo, '06-bo-sees-ana-sheet');

// ---- Drawing: Bo sees the line while Ana is still drawing, then the saved stroke ---------------
await ana.click('.draw-tools .tool[data-tool=pen]');
const t = (await ana.locator('.table-wrap').boundingBox())!;
const midY = t.y + t.height * 0.6;
await ana.mouse.move(t.x + 160, midY);
await ana.mouse.down();
for (let i = 1; i <= 15; i++) await ana.mouse.move(t.x + 160 + i * 20, midY + Math.sin(i / 2) * 30);
await bo.waitForSelector('svg.ink path:not([data-stroke])', { state: 'attached', timeout: 10000 }); // live, unsaved
await ana.mouse.up();
await bo.waitForSelector('svg.ink path[data-stroke]', { state: 'attached' });
assert.equal(await bo.locator('svg.ink path').count(), 1, 'live path replaced by the saved one');
await shot(bo, '07-bo-sees-drawing');

// Ping shows up for Bo.
await ana.keyboard.press('p');
await ana.mouse.click(t.x + 600, t.y + t.height * 0.4);
await bo.waitForSelector('.ping', { state: 'attached', timeout: 10000 });

// Erase it, then undo brings it back.
await ana.keyboard.press('e');
const stroke = ana.locator('svg.ink path[data-stroke]');
const sb = (await stroke.boundingBox())!;
// Erase by sweeping across the line.
await ana.mouse.move(sb.x + sb.width / 2, sb.y - 5);
await ana.mouse.down();
await ana.mouse.move(sb.x + sb.width / 2, sb.y + sb.height + 5, { steps: 20 });
await ana.mouse.up();
await bo.waitForFunction(() => !document.querySelector('svg.ink path[data-stroke]'));
await ana.keyboard.press('Escape');
await ana.keyboard.press('Control+z');
await bo.waitForSelector('svg.ink path[data-stroke]', { state: 'attached' });

// Dice + chat still work.
await bo.fill('#roll-form input', '2d6+1');
await bo.click('#roll-form button');
await untilLog(ana, 'rolled 2d6+1');

const archived = await fetch(`${site}/api/rooms/archive`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, room: roomId, archived: true }),
});
assert.ok(archived.ok, 'archived the test room');
console.log(`OK: ${roomId} (archived). Screenshots in ${shots}/`);
await browser.close();
