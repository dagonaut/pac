// Browser test: two players (fake camera/mic) in headless Chromium play through import, draw,
// drag and drop, preview, tap/flip, sheets, fields and undo, and check they see the same thing.
//   AWS_PROFILE=pac PAC_KEY=<table key> npx tsx scripts/ui.ts [site] [card image] [screenshot dir]
// Defaults: http://localhost:5173 (run `VTT_SITE_URL=https://vtt.16watt.com npm run dev`),
// the first image in images/, and ./ui-shots. Ana (admin, GM) and Bo are temporary players
// ("zz…" ids, written to the Game table and removed at the end); the room "zz-ui-<time>" is
// archived at the end.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { makeTestPlayers } from './test-players.ts';

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

const ANA_COLOR = '#3fa7d6';
const testPlayers = await makeTestPlayers([
  { name: 'Ana', color: ANA_COLOR, admin: true, gm: true },
  { name: 'Bo', color: '#ee6352', admin: false, gm: false },
]);
const [anaP, boP] = testPlayers.players;

/** A browser signed in by opening the player's personal link (optionally with ?room=). */
async function player(p: { name: string; credential: string }, url = site) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${p.name}] page error:`, e.message));
  page.on('console', (m) => (m.type() === 'error' || process.env.DEBUG) && console.log(`[${p.name}] console ${m.type()}:`, m.text()));
  await page.goto(`${url}${url.includes('?') ? '&' : '?'}p=${p.credential}`);
  await page.waitForSelector('#rooms:not([hidden])');
  assert.equal(await page.locator('#me-name').innerText(), p.name);
  assert.ok(!page.url().includes('p='), 'the credential is dropped from the address bar');
  return page;
}

const log = (p: Page) => p.locator('#log').innerText();
const untilLog = (p: Page, text: string) => p.waitForFunction((t) => document.querySelector('#log')!.textContent!.includes(t), text, { timeout: 15000 });

let roomId = '';
try {
  // ---- Ana creates a room with the Example system --------------------------------------------
  const ana = await player(anaP);
  // Ana is an admin: the Players dialog lists both players with their links.
  await ana.click('#players-btn');
  await ana.waitForSelector('dialog.players-dialog .player-list li:has-text("Bo")');
  assert.equal(await ana.locator('dialog.players-dialog button:text-is("Copy link")').count(), 2);
  await shot(ana, '00a-players-dialog');
  await ana.click('dialog.players-dialog button:text-is("Close")');
  // Profile: the color shows on her face in the lobby.
  await ana.click('#profile-btn');
  await ana.waitForSelector('dialog.profile-dialog');
  await shot(ana, '00b-profile');
  await ana.click('dialog.profile-dialog button:text-is("Done")');
  await shot(ana, '01-lobby');
  const roomName = `zz-ui-${Date.now()}`;
  await ana.fill('#new-room input[name=name]', roomName);
  await ana.selectOption('#new-room select[name=system]', 'example');
  await ana.click('#new-room button[type=submit]');
  await ana.waitForSelector('#room-view:not([hidden])', { timeout: 20000 });
  await ana.waitForSelector('.zone[data-zone=loot]');
  roomId = new URL(ana.url()).searchParams.get('room')!;
  // A guest can't take a player's name.
  const imposter = await fetch(`${site}/api/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, room: roomId, name: 'ana' }),
  });
  assert.equal(imposter.status, 409, 'guest may not join as a player');
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
  const bo = await player(boP, `${site}/?room=${roomId}`);
  await bo.click('#room-list li.invited button:text-is("Join")');
  await bo.waitForSelector('#room-view:not([hidden])', { timeout: 20000 });
  await bo.waitForSelector('.table-surface .piece.tapped.face-down');
  assert.match(await log(bo), /imported/);

  // ---- Sheets: Ana creates hers and slots the card as a weapon ----------------------------------
  await ana.click('text=Create my sheet');
  await ana.click('.menu .menu-item:text-is("Example raider")'); // the Example system ships this template
  await ana.waitForSelector('.sheet-t .slot[data-slot="0"]');
  await ana.locator('.table-surface .piece').hover();
  await ana.keyboard.press('f'); // face up again
  await ana.waitForSelector('.table-surface .piece:not(.face-down)');
  const from = (await ana.locator('.table-surface .piece').boundingBox())!;
  const slot = (await ana.locator('.sheet-t .slot[data-slot="0"]').boundingBox())!;
  await ana.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await ana.mouse.down();
  // Halfway there, the dragged copy must be under the pointer (it used to appear far away).
  const dragX = (from.x + from.width / 2 + slot.x + slot.width / 2) / 2;
  const dragY = (from.y + from.height / 2 + slot.y + slot.height / 2) / 2;
  await ana.mouse.move(dragX, dragY, { steps: 6 });
  const ghost = (await ana.locator('.piece.ghost').boundingBox())!;
  assert.ok(dragX >= ghost.x && dragX <= ghost.x + ghost.width && dragY >= ghost.y && dragY <= ghost.y + ghost.height,
    `dragged copy ${JSON.stringify(ghost)} should be under the pointer (${dragX}, ${dragY})`);
  await ana.mouse.move(slot.x + slot.width / 2, slot.y + slot.height / 2, { steps: 6 });
  await ana.mouse.up();
  await ana.waitForSelector('.sheet-t .slot[data-slot="0"] .piece');

  // HP + then undo.
  const hp = ana.locator('.sf:has(label:text-is("HP"))');
  await hp.locator('button:text-is("+")').click();
  await ana.waitForFunction(() => (document.querySelector('input[data-field$="/hp"]') as HTMLInputElement)?.value === '11');
  await ana.keyboard.press('Control+z');
  await ana.waitForFunction(() => (document.querySelector('input[data-field$="/hp"]') as HTMLInputElement)?.value === '10');

  // Click a stat to roll it with its modifier; fill a harm track.
  await ana.click('.stat-roll:has-text("INT")');
  await untilLog(ana, 'rolled INT (2d6+2)');
  await ana.locator('.sf-track .track-box').nth(1).click();
  await ana.waitForFunction(() => document.querySelectorAll('.sf-track .track-box.filled').length === 2);
  await shot(ana, '05-sheet');

  // Templates: build one, export it, import it back.
  await ana.click('.dock-tab:text-is("Templates")');
  await ana.waitForSelector('dialog.templates .template-list li:has-text("Example raider")');
  await ana.click('dialog.templates button:text-is("New template")');
  await ana.waitForSelector('dialog.template-editor');
  await ana.fill('dialog.template-editor .builder > label.opt input', 'Test hero');
  await ana.click('dialog.template-editor .add-row button:text-is("+ Field")');
  const newRow = ana.locator('dialog.template-editor .field-row').last();
  await newRow.locator('.field-main input').first().fill('Luck');
  await newRow.locator('.field-main select').selectOption('die');
  await ana.waitForSelector('dialog.template-editor .preview-box .stat-roll:has-text("Luck")');
  await shot(ana, '05c-template-builder');
  await ana.click('dialog.template-editor button:text-is("Create template")');
  await ana.waitForSelector('dialog.templates .template-list li:has-text("Test hero")');
  const [download] = await Promise.all([
    ana.waitForEvent('download'),
    ana.click('dialog.templates li:has-text("Test hero") button:text-is("Export")'),
  ]);
  const exported = path.join(shots, 'test-hero.sheet.json');
  await download.saveAs(exported);
  const json = JSON.parse(readFileSync(exported, 'utf8'));
  assert.equal(json.name, 'Test hero');
  assert.match(json.$schema, /sheet\.schema\.json$/);
  assert.ok(json.sections[0].fields.some((f: { id: string; type: string }) => f.id === 'luck' && f.type === 'die'));
  await ana.setInputFiles('dialog.templates input[type=file]', exported);
  await ana.waitForFunction(() => document.querySelectorAll('dialog.templates .template-list li').length === 3);
  await ana.click('dialog.templates button:text-is("Close")');

  // System actions (Example system): Untap all, and Refill market's message when the deck is empty.
  assert.equal(await ana.locator('.piece.tapped').count(), 1);
  await ana.click('.system-action:text-is("Untap all")');
  await ana.waitForFunction(() => !document.querySelector('.piece.tapped'));
  await ana.click('.system-action:text-is("Refill market")');
  await untilLog(ana, 'The loot deck is empty.');

  // Library: add a second copy to the table, then make it bigger.
  await ana.click('.bar-actions >> text=Library');
  await ana.click('dialog .library .thumb');
  await ana.click('.menu .menu-item:text-is("Table")');
  await ana.waitForSelector('.table-surface .piece');
  await ana.click('dialog >> text=Close');
  await ana.locator('.table-surface .piece').click();
  await ana.fill('.menu .size-row input.pct', '150');
  await ana.press('.menu .size-row input.pct', 'Enter');
  await ana.waitForFunction(() => (document.querySelector('.table-surface .piece') as HTMLElement)?.style.getPropertyValue('--scale') === '1.5');

  // Counters: add "poison" in the third palette color; Bo sees the colored badge, and the hover
  // preview shows it too.
  await ana.locator('.table-surface .piece').click();
  await ana.fill('.menu .add-counter input', 'poison');
  await ana.click('.menu .add-counter .swatch >> nth=2');
  await ana.click('.menu .add-counter button[type=submit]');
  await bo.waitForFunction(() => {
    const b = document.querySelector('.table-surface .piece .badge.counter') as HTMLElement | null;
    return b?.title === 'poison: 1' && getComputedStyle(b).backgroundColor === 'rgb(89, 205, 144)';
  });
  await ana.locator('.table-surface .piece').hover();
  await ana.waitForSelector('.preview:not([hidden]) .preview-badges .badge.counter');
  await shot(ana, '05b-library-copy-bigger');

  // Bo sees Ana's sheet tab with the card in the Weapon slot.
  await bo.click('.dock-tab:text("Ana")');
  await bo.waitForSelector('.sheet-t .slot[data-slot="0"] .piece');
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

  // ---- Shapes and text ----------------------------------------------------------------------------
  await ana.selectOption('.draw-tools .tool-group select', 'rect');
  await ana.mouse.move(t.x + 500, t.y + 60);
  await ana.mouse.down();
  await ana.mouse.move(t.x + 600, t.y + 120, { steps: 8 });
  await bo.waitForSelector('svg.ink rect:not([data-stroke])', { state: 'attached', timeout: 10000 }); // live preview
  await ana.mouse.up();
  await bo.waitForSelector('svg.ink rect[data-stroke]', { state: 'attached' });
  await untilLog(bo, 'drew a box');

  // Still on the Shape tool: grab the box by its edge and drag it somewhere else.
  const boxEl = ana.locator('svg.ink rect[data-stroke]');
  const bb = (await boxEl.boundingBox())!;
  const boxX = await bo.locator('svg.ink rect[data-stroke]').getAttribute('x');
  await ana.mouse.move(bb.x + 1, bb.y + bb.height / 2); // on the outline (it isn't filled)
  await ana.mouse.down();
  await ana.mouse.move(bb.x + 101, bb.y + bb.height / 2 + 30, { steps: 8 });
  await ana.mouse.up();
  await bo.waitForFunction((x) => {
    const r = document.querySelector('svg.ink rect[data-stroke]');
    return !!r && Number(r.getAttribute('x')) - Number(x) === 100;
  }, boxX);
  assert.equal(await ana.locator('svg.ink rect').count(), 1, 'moving a box must not draw a new one');

  await ana.click('.draw-tools .tool[data-tool=text]');
  await ana.mouse.click(t.x + 650, t.y + 80);
  await ana.keyboard.type('Goblins');
  await ana.keyboard.press('Enter'); // a new line, not done yet
  await ana.keyboard.type('by the door');
  await ana.keyboard.press('Control+Enter');
  await bo.waitForFunction(() => {
    const spans = [...document.querySelectorAll('svg.ink text[data-stroke] tspan')].map((t) => t.textContent);
    return spans.join('|') === 'Goblins|by the door';
  });
  // Double-click to edit, drag to move.
  const label = ana.locator('svg.ink text[data-stroke]');
  await label.dblclick();
  await ana.keyboard.press('End');
  await ana.keyboard.press('Control+End');
  await ana.keyboard.type(' x3');
  await ana.mouse.click(t.x + 900, t.y + 200); // clicking away finishes
  await bo.waitForFunction(() => [...document.querySelectorAll('svg.ink text[data-stroke] tspan')].map((t) => t.textContent).join('|') === 'Goblins|by the door x3');
  const lb = (await label.boundingBox())!;
  const startX = await bo.locator('svg.ink text[data-stroke]').getAttribute('x');
  await ana.mouse.move(lb.x + 5, lb.y + lb.height / 2);
  await ana.mouse.down();
  await ana.mouse.move(lb.x + 85, lb.y + lb.height / 2 + 40, { steps: 8 });
  await ana.mouse.up();
  await bo.waitForFunction((x) => document.querySelector('svg.ink text[data-stroke]')?.getAttribute('x') !== x, startX);
  await shot(bo, '07b-shapes-and-text');
  await ana.keyboard.press('Escape');

  // Clear asks first: Cancel keeps everything; Clear removes it, and the toast's Undo brings it back.
  const inkCount = () => bo.locator('svg.ink [data-stroke]').count();
  const drawn = await inkCount();
  assert.ok(drawn >= 3);
  await ana.click('.draw-tools button:text-is("Clear")');
  await ana.waitForSelector('dialog.confirm[open]');
  await shot(ana, '07c-clear-confirm');
  await ana.click('dialog.confirm button:text-is("Cancel")');
  await ana.waitForSelector('dialog.confirm', { state: 'detached' });
  assert.equal(await inkCount(), drawn, 'Cancel keeps the drawings');
  await ana.click('.draw-tools button:text-is("Clear")');
  await ana.click('dialog.confirm button.danger');
  await bo.waitForFunction(() => !document.querySelector('svg.ink [data-stroke]'));
  await ana.click('.toast button:text-is("Undo")');
  await bo.waitForFunction((n) => document.querySelectorAll('svg.ink [data-stroke]').length === n, drawn);

  // ---- Images: hidden upload, set as map, spotlight, put on table ---------------------------------
  await ana.keyboard.press('Escape'); // back to the Move tool
  await ana.click('.drawer-tab');
  await ana.click('.drawer-head button:text-is("Upload")');
  await ana.setInputFiles('dialog.import input[type=file] >> nth=0', image);
  await ana.selectOption('dialog.import select', 'map');
  await ana.check('dialog.import input[type=checkbox]');
  await ana.click('dialog.import button[type=submit]');
  await ana.waitForSelector('.image-grid figure.hidden-image');
  await bo.click('.drawer-tab');
  await bo.waitForSelector('.drawer:not([hidden])');
  assert.equal(await bo.locator('.image-grid figure').count(), 0, 'Bo cannot see the hidden image');

  await ana.click('.image-grid .thumb');
  await ana.click('.menu .menu-item:text-is("Set as map")');
  await bo.waitForFunction(() => {
    const m = document.querySelector('img.map') as HTMLImageElement | null;
    return !!m && !m.hidden && m.naturalWidth > 0;
  });
  await bo.waitForSelector('.image-grid figure:not(.hidden-image)'); // setting the map revealed it
  await untilLog(bo, 'set the map to');
  // The map lands in the middle of the table, and Bo's view scrolls to it.
  await bo.waitForFunction(() => {
    const m = (document.querySelector('img.map') as HTMLElement).getBoundingClientRect();
    const v = (document.querySelector('.table-wrap') as HTMLElement).getBoundingClientRect();
    const cx = m.x + m.width / 2;
    const cy = m.y + m.height / 2;
    return cx > v.x && cx < v.x + v.width && cy > v.y && cy < v.y + v.height;
  }, null, { timeout: 5000 });
  assert.ok(Number.parseInt(await bo.locator('img.map').evaluate((e) => (e as HTMLElement).style.left), 10) > 0, 'map is placed away from the corner');
  assert.ok(Number.parseInt(await bo.locator('img.map').evaluate((e) => (e as HTMLElement).style.top), 10) >= 400, 'map keeps a margin above it');
  await shot(bo, '08a-map-centered');

  // Right-click the map: size it like a card, then Center puts it back in the middle (with margin).
  const mapBox = (await ana.locator('img.map').boundingBox())!;
  await ana.mouse.click(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2, { button: 'right' });
  await ana.waitForSelector('.menu .menu-heading:has-text("Map:")');
  await ana.fill('.menu .size-row input.pct', '400');
  await ana.press('.menu .size-row input.pct', 'Enter');
  await bo.waitForFunction(() => (document.querySelector('.map-controls input.pct') as HTMLInputElement)?.value === '400');
  await ana.click('.map-controls button:text-is("Center")');
  await bo.waitForFunction(() => {
    const m = document.querySelector('img.map') as HTMLImageElement;
    const w = m.naturalWidth * 4;
    return Number.parseInt(m.style.left, 10) === Math.round(Math.max(400, (3200 - w) / 2));
  });
  await shot(bo, '08b-map-big-centered');

  // Map size: typed %; the controls hide from players once someone holds the GM seat.
  await ana.fill('.map-controls input.pct', '50');
  await ana.press('.map-controls input.pct', 'Enter');
  await untilLog(bo, 'set the map to');
  await bo.waitForFunction(() => (document.querySelector('.map-controls input.pct') as HTMLInputElement)?.value === '50');
  assert.ok(await bo.locator('#gm-btn').isHidden(), 'Bo is not a GM player: no GM seat button');
  await ana.click('#gm-btn');
  await bo.waitForSelector('.map-controls', { state: 'hidden' });
  await ana.waitForSelector('.map-controls:not([hidden])');
  await ana.click('#gm-btn'); // leave the seat again

  await ana.click('.image-grid .thumb');
  await ana.click('.menu .menu-item:text-is("Show to everyone")');
  await bo.waitForSelector('.spotlight:not([hidden]):not(.local) img');
  await shot(bo, '08-bo-sees-spotlight');
  await bo.click('.spotlight button:text-is("Minimize")');
  await bo.waitForSelector('.spot-chip:not([hidden])');
  await ana.click('.spotlight button:text-is("Close for everyone")');
  await bo.waitForSelector('.spot-chip', { state: 'hidden' });

  await ana.click('.image-grid .thumb');
  const before = await ana.locator('.table-surface .piece').count();
  await ana.click('.menu .menu-item:text-is("Put on the table")');
  await ana.waitForFunction((n) => document.querySelectorAll('.table-surface .piece').length === n + 1, before);
  await ana.click('.drawer-tab'); // the tab closes the drawer too
  await ana.waitForSelector('.drawer', { state: 'hidden' });
  await shot(ana, '09-map-and-handout');

  // Layers: the handout (newest) is on top; send it to the back, then bring the card to the front.
  const pieceIds = await ana.locator('.table-surface .piece').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.piece!));
  const handout = pieceIds[pieceIds.length - 1];
  const zOf = (p: Page, id: string) => p.locator(`.table-surface .piece[data-piece="${id}"]`).evaluate((e) => Number((e as HTMLElement).style.zIndex));
  const topBefore = await zOf(bo, handout);
  /** Where to point at a table piece: scroll it into the (short) table view, then the middle of its
   *  part that's visible below the drawing toolbar. */
  async function piecePoint(p: Page, id: string) {
    const el = p.locator(`.table-surface .piece[data-piece="${id}"]`);
    await el.evaluate((e) => e.scrollIntoView({ block: 'center', inline: 'center' }));
    const b = (await el.boundingBox())!;
    const v = (await p.locator('.table-wrap').boundingBox())!;
    const tools = (await p.locator('.draw-tools').boundingBox())!;
    const top = Math.max(b.y, v.y, tools.y + tools.height + 2);
    const bottom = Math.min(b.y + b.height, v.y + v.height);
    return { x: (Math.max(b.x, v.x) + Math.min(b.x + b.width, v.x + v.width)) / 2, y: (top + bottom) / 2 };
  }
  async function clickPiece(p: Page, id: string) {
    const pt = await piecePoint(p, id);
    await p.mouse.click(pt.x, pt.y);
  }
  await clickPiece(ana, handout);
  await ana.click('.menu .menu-item:text-is("Send to back")');
  await bo.waitForFunction(([id, top]) => Number((document.querySelector(`.table-surface .piece[data-piece="${id}"]`) as HTMLElement).style.zIndex) < Number(top), [handout, String(topBefore)] as const);

  // Lock: Bo can't drag a locked card; Ana unlocks it.
  const card0 = pieceIds[0];
  const lockEl = (p: Page) => p.locator(`.table-surface .piece[data-piece="${card0}"]`);
  await clickPiece(ana, card0);
  await ana.click('.menu .menu-item:text-is("Lock in place")');
  await bo.waitForSelector(`.table-surface .piece.locked[data-piece="${card0}"] .badge.locked`);
  const lb0 = await piecePoint(bo, card0);
  const left0 = await lockEl(bo).evaluate((e) => (e as HTMLElement).style.left);
  await bo.mouse.move(lb0.x, lb0.y);
  await bo.mouse.down();
  await bo.mouse.move(lb0.x + 200, lb0.y + 150, { steps: 10 });
  assert.equal(await bo.locator('.piece.ghost').count(), 0, 'no drag for a locked card');
  await bo.mouse.up();
  await bo.waitForSelector('.menu .menu-item:text-is("Unlock")'); // a click still opens its menu
  await shot(bo, '09b-locked-menu');
  await bo.keyboard.press('Escape');
  assert.equal(await lockEl(bo).evaluate((e) => (e as HTMLElement).style.left), left0);
  await clickPiece(ana, card0);
  await ana.click('.menu .menu-item:text-is("Unlock")');
  await bo.waitForSelector(`.table-surface .piece[data-piece="${card0}"]:not(.locked)`);

  // The Sheets tab collapses and reopens the sheet dock.
  await ana.click('.dock-handle');
  await ana.waitForSelector('.dock-body', { state: 'detached' });
  await ana.click('.dock-handle');
  await ana.waitForSelector('.dock-body');

  // Dice + chat still work.
  await bo.fill('#roll-form input', '2d6+1');
  await bo.click('#roll-form button');
  await untilLog(ana, 'rolled 2d6+1');
  // ...and the result pops up on Bo's video tile for everyone.
  await ana.waitForSelector('.tile .roll-bubble b');
  // Player colors: Ana's name in Bo's log, and the stripe on Ana's tile.
  const anaRgb = `rgb(${[1, 3, 5].map((i) => parseInt(ANA_COLOR.slice(i, i + 2), 16)).join(', ')})`;
  assert.equal(await bo.locator('#log li > b:text-is("Ana")').first().evaluate((e) => getComputedStyle(e).color), anaRgb);
  await ana.waitForTimeout(400); // let the pop-in animation finish
  await shot(ana, '09c-roll-on-tile');

  // The Cards tab slides the deck/row bar closed and open.
  await ana.click('.bar-handle');
  await ana.waitForSelector('.board-bar', { state: 'hidden' });
  await shot(ana, '10a-cards-bar-closed');
  await ana.click('.bar-handle');
  await ana.waitForSelector('.zone[data-zone=loot]', { state: 'visible' });

  // Chat & dice panel: hide it, get an unread count, show it again.
  await bo.click('#side-tab');
  await bo.waitForSelector('#side', { state: 'hidden' });
  await ana.fill('#chat-form input', 'are you there?');
  await ana.click('#chat-form button');
  await bo.waitForSelector('#side-tab[data-unread="1"]');
  await shot(bo, '10-side-collapsed');
  await bo.click('#side-tab');
  await bo.waitForSelector('#side', { state: 'visible' });
  assert.equal(await bo.locator('#side-tab').getAttribute('data-unread'), null);

  const archived = await fetch(`${site}/api/rooms/archive`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, room: roomId, archived: true }),
  });
  assert.ok(archived.ok, 'archived the test room');
  console.log(`OK: ${roomId} (archived). Screenshots in ${shots}/`);
} finally {
  await testPlayers.remove();
  await browser.close();
}
