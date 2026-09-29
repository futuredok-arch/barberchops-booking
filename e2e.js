'use strict';
// End-to-end browser test: real Chromium against the real server (fake clock, fake Stripe, fake mail).
//   npm run e2e         (uses /opt/pw-browsers/chromium unless CHROMIUM_PATH is set)
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startApp } = require('./helpers');

const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const EXE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const SETUP_KEY = 'test-setup-key-1234567890';
const OWNER_EMAIL = 'owner@example.com', OWNER_PW = 'correct horse battery staple';
const BOARD_PIN = '654321', BARBER_PIN = '246810';

/* ---------------- tiny test harness ---------------- */
let checks = 0;
const t0 = Date.now();
function ok(cond, msg) { assert.ok(cond, msg); checks++; console.log('  ok  ' + msg); }
function eq(a, b, msg) { assert.deepEqual(a, b, msg); checks++; console.log('  ok  ' + msg); }
async function section(name, fn) { console.log('\n# ' + name); await fn(); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, msg, timeout = 8000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(100); }
  throw new Error('timed out waiting for: ' + msg + (last instanceof Error ? ' (' + last.message + ')' : ''));
}

/* ---------------- watchers: console errors, CSP violations, storage writes ---------------- */
const consoleErrors = [], cspEvents = [], storageWrites = [], httpErrors = [], expectedHttp = [];
function expectHttp(status, urlPart, n = 1) { for (let i = 0; i < n; i++) expectedHttp.push({ status, urlPart }); }

async function newContext(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ...opts });
  await ctx.exposeBinding('__cspReport', (src, info) => { cspEvents.push(info); });
  await ctx.exposeBinding('__storageReport', (src, info) => { storageWrites.push(info); });
  await ctx.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => window.__cspReport({ directive: e.violatedDirective, blocked: e.blockedURI, src: e.sourceFile, line: e.lineNumber }));
    for (const S of [Storage.prototype]) {
      const orig = S.setItem;
      S.setItem = function (k, v) { try { window.__storageReport({ key: String(k), len: String(v).length }); } catch (e) { /* ignore */ } return orig.apply(this, arguments); };
    }
  });
  // Google Fonts is not reachable from CI: answer with empty CSS so nothing errors
  await ctx.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '/* offline */' }));
  ctx.on('page', (page) => watch(page));
  return ctx;
}
function watch(page) {
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const text = m.text();
    const mm = /Failed to load resource: the server responded with a status of (\d+)/.exec(text);
    if (mm) { httpErrors.push({ status: +mm[1], url: m.location().url || '' }); return; }
    if (m.type() === 'warning' && !/content security|refused to|csp/i.test(text)) return;
    consoleErrors.push(`[${m.type()}] ${text} @ ${m.location().url}`);
  });
  page.on('pageerror', (e) => consoleErrors.push('[pageerror] ' + e.message));
}

/* ---------------- helpers ---------------- */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(w, h) {
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) { rows[o + 1 + x * 3] = (x * 255 / w) | 0; rows[o + 2 + x * 3] = (y * 255 / h) | 0; rows[o + 3 + x * 3] = ((x + y) * 7) & 255; }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}
const bodyText = (page) => page.evaluate(() => document.body.textContent.replace(/\s+/g, " "));
async function noHScroll(page, label) {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, bw: document.body.scrollWidth }));
  ok(m.sw <= m.iw && m.bw <= m.iw, `${label}: no horizontal page scroll (${m.sw}px content in ${m.iw}px)`);
}
async function noInlineHandlers(page, label) {
  const bad = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('*').forEach((el) => {
      for (const a of el.attributes) if (/^on/i.test(a.name)) out.push(el.tagName + '[' + a.name + ']');
      if (el.tagName === 'SCRIPT' && !el.getAttribute('src')) out.push('inline <script>');
      if (el.tagName === 'A' && /^\s*javascript:/i.test(el.getAttribute('href') || '')) out.push('javascript: href');
    });
    return out;
  });
  eq(bad, [], `${label}: no inline handlers/scripts in the DOM`);
}
async function shot(page, name, opts = {}) { await page.screenshot({ path: path.join(SHOTS, name + '.png'), ...opts }); }
const fillF = async (page, id, value) => { await page.locator('#' + id).fill(value); };

/* customer wizard driver (mobile) */
async function goToTimeStep(page, barberId, serviceId) {
  await page.locator('[data-action="start-booking"]').first().click();
  await page.locator(`[data-action="pick-barber"][data-id="${barberId}"]`).click();
  await page.locator('.wiz-nav .btn-primary').click();
  await page.locator(`[data-action="pick-service"][data-id="${serviceId}"]`).click();
  await page.locator('.wiz-nav .btn-primary').click();
  await page.waitForSelector('.slot-btn');
}
async function pickSlot(page, index = 0) {
  const btn = page.locator('.slot-btn').nth(index);
  const label = (await btn.innerText()).trim();
  await btn.click();
  await page.locator('.wiz-nav .btn-primary').click();
  return label;
}
async function fillInfo(page, { name, phone, email = '', notes = '', optIn }) {
  await page.waitForSelector('#f_w_name');
  await fillF(page, 'f_w_name', name); await fillF(page, 'f_w_phone', phone);
  if (email) await fillF(page, 'f_w_email', email);
  if (notes) await fillF(page, 'f_w_notes', notes);
  if (optIn !== undefined) { const cb = page.locator('[data-f="w.optIn"]'); if ((await cb.isChecked()) !== optIn) await cb.click(); }
}

async function main() {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  const appA = await startApp();                                // fake Stripe + fake mail
  const appB = await startApp({}, { stripe: false });           // no Stripe key -> dev-pay page
  const A = appA.base, B = appB.base;
  let slowPage = null;

  try {
    /* ============================================================== static hygiene */
    await section('served HTML is CSP-clean', async () => {
      const html = await (await fetch(A + '/')).text();
      ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'index.html has no inline <script>');
      ok(!/\son[a-z]+\s*=/i.test(html), 'index.html has no inline event-handler attributes');
      const js = await (await fetch(A + '/app.js')).text();
      ok(!/\beval\s*\(|new Function\s*\(|document\.write\s*\(/.test(js), 'app.js never uses eval / new Function / document.write');
      ok(!/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/.test(js), 'app.js never touches browser storage');
      const csp = (await fetch(A + '/')).headers.get('content-security-policy');
      ok(/script-src 'self'(;|$)/.test(csp), 'server sends script-src \'self\'');
    });

    /* ============================================================== customer: dev-pay journey (app B) */
    const custCtx = await newContext(browser);
    const cp = await custCtx.newPage();
    let bookingPhone = '(516) 555-0142';
    await section('customer booking on mobile (dev payment page)', async () => {
      await cp.goto(B + '/');
      await cp.waitForSelector('.hero h1');
      ok((await cp.title()).includes('Barberchops'), 'landing page loads with the shop name');
      ok(await cp.locator('.brand-logo use').count() === 1, 'logo renders');
      await noHScroll(cp, 'landing 390px'); await noInlineHandlers(cp, 'landing');
      const teamCount = await cp.locator('.team-card').count();
      eq(teamCount, 8, 'team strip shows all 8 barbers from the server');
      ok((await bodyText(cp)).includes('Hot Lather Head Shave'), 'price list is rendered from the server');
      ok((await cp.locator('.footer-bottom button[data-action="go-staff"]').innerText()).includes('Team login'), 'discreet "Team login" link in the footer');
      ok((await cp.locator('.footer-bottom button[data-action="go-board"]').count()) === 1, '"Shop screen" footer link exists');
      await shot(cp, '01-mobile-home-top');
      await cp.locator('#app .team-grid').scrollIntoViewIfNeeded();
      await cp.evaluate(() => window.scrollBy(0, -120));
      await shot(cp, '02-mobile-home-team');

      // wizard
      await goToTimeStep(cp, 'b1', 's1');
      await noHScroll(cp, 'time step 390px');
      ok(/step 3 of 6/i.test(await bodyText(cp)), 'mobile progress indicator shows the step');
      await shot(cp, '03-mobile-time-step');
      await pickSlot(cp, 0);
      // info step
      await cp.waitForSelector('#f_w_name');
      ok(await cp.locator('[data-f="w.optIn"]').isChecked(), 'marketing consent checkbox is pre-ticked (shop setting)');
      eq(await cp.locator('#f_website').inputValue(), '', 'honeypot "website" field is empty');
      ok((await cp.locator('#f_website').evaluate((e) => e.name)) === 'website', 'honeypot field is named "website"');
      await cp.locator('.consent-letter summary').click();
      ok((await cp.locator('.consent-body').innerText()).includes('not a condition'), 'consent letter text is shown');
      // validation
      await cp.locator('.wiz-nav .btn-primary').click();
      ok((await bodyText(cp)).includes('Please enter your full name'), 'info step validates the name');
      ok((await bodyText(cp)).includes('10-digit US phone'), 'info step validates the phone number');
      await fillInfo(cp, { name: 'Jordan "JD" O\'Neil & Sons', phone: bookingPhone, email: 'jordan@example.com', notes: 'skin fade, keep the top' });
      await noHScroll(cp, 'info step 390px');
      await shot(cp, '04-mobile-info-step');
      await cp.locator('.wiz-nav .btn-primary').click();
      await cp.waitForSelector('[data-action="book"]');
      const payText = await bodyText(cp);
      ok(payText.includes('$5') && /non-refundable/.test(payText) && payText.includes('12 hours'), 'pay step explains the $5 fee and the 12-hour cancel window');
      await shot(cp, '05-mobile-pay-step');
    });
    await section('slot-taken conflict returns to the time step with fresh times', async () => {
      // rebuild cleanly: find which slot the page selected and book it from another "browser"
      const sel = await cp.evaluate(() => { const w = document.querySelector('.summary-box'); return w ? w.innerText : ''; });
      ok(/at 1?\d:\d\d (AM|PM)/.test(sel), 'summary shows the chosen time');
      const m = /at (\d{1,2}):(\d\d) (AM|PM)/.exec(sel);
      let h = +m[1] % 12; if (m[3] === 'PM') h += 12;
      const hhmm = String(h).padStart(2, '0') + ':' + m[2];
      const c2 = appB.client();
      const r = await c2.post('/api/bookings', { serviceId: 's1', barberId: 'b1', date: '2026-09-30', time: hhmm, name: 'Other Person', phone: '516-555-0999' });
      eq(r.status, 200, 'another customer grabs that exact time first');
      expectHttp(409, '/api/bookings');
      await cp.locator('[data-action="book"]').click();
      await cp.waitForSelector('.notice-error');
      const txt = await bodyText(cp);
      ok(/just taken/.test(txt), 'shows "that time was just taken"');
      ok((await cp.locator('.step-title').innerText()).includes('Pick a date'), 'sent back to the time step');
      await cp.waitForSelector('.slot-btn');
      const stillThere = await cp.locator(`.slot-btn[data-time="${hhmm}"]`).count();
      eq(stillThere, 0, 'the taken time is gone from the refreshed availability');
      await shot(cp, '06-mobile-slot-taken');
      await cp.locator('.slot-btn').first().click();
      await cp.locator('.wiz-nav .btn-primary').click();
      eq(await cp.locator('#f_w_name').inputValue(), 'Jordan "JD" O\'Neil & Sons', 'form entries survive the conflict');
      await cp.locator('.wiz-nav .btn-primary').click();
      await cp.waitForSelector('[data-action="book"]');
    });
    let confirmCode = '';
    await section('pay via the dev payment page and see the confirmation', async () => {
      const btn = cp.locator('[data-action="book"]');
      await btn.dblclick();          // a nervous double tap must not book twice
      await cp.waitForSelector('.confirm-wrap', { timeout: 15000 });
      confirmCode = (await cp.locator('#confirm-code').innerText()).trim();
      ok(/^[A-Z0-9]{8}$/.test(confirmCode), 'confirmation code shown (' + confirmCode + ')');
      const t = await bodyText(cp);
      ok(t.includes('The Quality Cut') && t.includes('Joe') && t.includes('September 30'), 'confirmation shows service, barber, date');
      ok(/confirmation email is on its way/.test(t), 'confirmation notes that an email was sent');
      ok(!/pay=|[?&]t=/.test(cp.url()), 'payment token was removed from the address bar');
      await noHScroll(cp, 'confirmation 390px');
      await shot(cp, '07-mobile-confirmation');
      await until(() => appB.fakeMail.sent.some((m) => m.to.includes('jordan@example.com')), 'customer confirmation email');
      ok(true, 'customer confirmation email was queued and sent');
      const owner = await appB.ownerClient();
      const st = (await owner.get('/api/owner/state')).json;
      const bk = st.bookings.find((b) => b.customerName.startsWith('Jordan'));
      ok(bk && bk.status === 'upcoming' && bk.feePaid, 'booking is upcoming and fee paid on the server');
      eq(appB.db.raw.prepare("SELECT COUNT(*) c FROM bookings WHERE customer_name LIKE 'Jordan%'").get().c, 1, 'double-tapping Pay created exactly one booking');
      ok(bk.customerName === 'Jordan "JD" O\'Neil & Sons', 'special characters stored exactly');
      const cust = st.customers.find((c) => c.name.startsWith('Jordan'));
      ok(cust && cust.optIn === true, 'the pre-ticked consent was recorded as an opt-in');
      // no other data leaks: the honeypot stays empty and nothing was saved in the browser
      eq(storageWrites, [], 'no page has written to localStorage/sessionStorage so far');
    });
    await section('customer: book another (consent unticked) + back button + keyboard focus', async () => {
      await cp.locator('[data-action="book-another"]').click();
      await cp.waitForSelector('[data-action="pick-barber"]');
      ok((await cp.locator('.step-title').innerText()).includes('Choose your barber'), 'book another restarts the wizard');
    });

    /* ============================================================== 320px width */
    await section('no horizontal scroll at 320px', async () => {
      const ctx = await newContext(browser, { viewport: { width: 320, height: 640 } });
      const p = await ctx.newPage();
      await p.goto(B + '/'); await p.waitForSelector('.hero h1');
      await noHScroll(p, 'landing 320px');
      await goToTimeStep(p, 'any', 's4');
      await noHScroll(p, 'time step 320px');
      await pickSlot(p, 1);
      await p.waitForSelector('#f_w_name');
      await noHScroll(p, 'info step 320px');
      await ctx.close();
    });

    /* ============================================================== owner (app A) */
    const ownCtx = await newContext(browser, { permissions: ['clipboard-read', 'clipboard-write'] });
    const op = await ownCtx.newPage();
    await section('owner first-time setup and login', async () => {
      await op.goto(A + '/#owner');
      await op.waitForSelector('form[data-submit="owner-setup"]');
      ok((await bodyText(op)).includes('Set up your owner account'), 'first-time setup screen shown');
      await fillF(op, 'f_os_key', 'wrong-key-wrong-key'); await fillF(op, 'f_os_email', OWNER_EMAIL); await fillF(op, 'f_os_pw', OWNER_PW); await fillF(op, 'f_os_pw2', 'short');
      await op.locator('button[type="submit"]').click();
      ok((await bodyText(op)).includes('don’t match'), 'password confirmation mismatch is caught before sending');
      await fillF(op, 'f_os_pw2', OWNER_PW);
      expectHttp(403, '/api/setup');
      await op.locator('button[type="submit"]').click();
      await op.waitForSelector('.notice-error');
      ok((await bodyText(op)).includes('setup key is not right'), 'wrong setup key is rejected with the server message');
      await fillF(op, 'f_os_key', SETUP_KEY);
      await op.locator('button[type="submit"]').click();
      await op.waitForSelector('.dash-tabs');
      ok((await bodyText(op)).includes('Owner dashboard'), 'owner dashboard opens after setup');
      await op.locator('[data-action="o-logout"]').click();
      await op.waitForSelector('form[data-submit="owner-login"]');
      await fillF(op, 'f_ol_email', OWNER_EMAIL); await fillF(op, 'f_ol_pw', 'not the password');
      expectHttp(401, '/api/owner/login');
      await op.locator('button[type="submit"]').click();
      await op.waitForSelector('.notice-error');
      ok((await bodyText(op)).includes('not right'), 'wrong password shows a friendly error');
      await fillF(op, 'f_ol_pw', OWNER_PW);
      await op.locator('button[type="submit"]').click();
      await op.waitForSelector('.dash-tabs');
      ok(true, 'owner signs in with email + password');
      await noInlineHandlers(op, 'owner dashboard');
      await noHScroll(op, 'owner dashboard 390px');
      await shot(op, '08-owner-dashboard-mobile', { fullPage: false });
    });

    let samId = '', inviteUrl = '';
    await section('owner adds a barber, makes an invite link, uploads photos', async () => {
      await op.locator('[data-action="o-tab"][data-k="team"]').click();
      await fillF(op, 'f_nb_name', 'Sam'); await fillF(op, 'f_nb_title', 'Test Barber');
      await op.locator('[data-action="o-nb-lang"][data-k="es"]').click();
      await op.locator('form[data-submit="o-add-barber"] button[type="submit"]').click();
      await op.waitForSelector('.tcard[data-barber]:has-text("Sam")');
      samId = await op.locator('.tcard:has-text("Sam") >> nth=0').getAttribute('data-barber');
      ok(/^b/.test(samId), 'new barber appears with a server id (' + samId + ')');
      const card = op.locator(`.tcard[data-barber="${samId}"]`);
      await card.locator('[data-action="o-invite"][data-k="link"]').click();
      await card.locator('.invite-box input').waitFor();
      inviteUrl = await card.locator('.invite-box input').inputValue();
      ok(new RegExp('^' + A.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/\\?staff=[A-Za-z0-9_-]{20,}$').test(inviteUrl), 'one-time invite link is shown: ' + inviteUrl.slice(0, 40) + '…');
      await card.locator('[data-action="o-copy"]').click();
      await until(async () => (await card.locator('[data-action="o-copy"]').textContent()).trim() === 'Copied', 'Copy button feedback');
      const clip = await op.evaluate(() => navigator.clipboard.readText()).catch(() => inviteUrl);
      eq(clip, inviteUrl, 'Copy button puts the link on the clipboard');
      ok((await card.textContent()).includes('Invite pending'), 'barber card shows "Invite pending"');
      // photos
      await card.locator('[data-action="o-manage"]').click();
      const png = makePng(1600, 1200);
      await card.locator('input[data-k="profile"]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: png });
      await card.locator('.pick-avatar.has-photo').first().waitFor({ timeout: 10000 });
      await card.locator('input[data-k="gallery"]').setInputFiles([1, 2].map((i) => ({ name: `g${i}.png`, mimeType: 'image/png', buffer: makePng(900 + i * 100, 700) })));
      await op.waitForFunction((id) => document.querySelectorAll(`.tcard[data-barber="${id}"] .manage-thumb`).length === 2, samId, { timeout: 10000 });
      const pub = (await fetch(A + '/api/public').then((r) => r.json())).barbers.find((b) => b.id === samId);
      ok(/^\/uploads\/[A-Za-z0-9._-]+\.jpg$/.test(pub.photo) && pub.gallery.length === 2, 'photos uploaded (resized to JPEG in the browser) and served from /uploads');
      const jpeg = Buffer.from(await (await fetch(A + pub.photo)).arrayBuffer());
      ok(jpeg[0] === 0xff && jpeg[1] === 0xd8, 'uploaded profile photo is a real JPEG');
      await shot(op, '09-owner-team-manage', { fullPage: false });
      await card.locator('[data-action="o-manage"]').click();
    });

    await section('owner adds a manual booking and sees full customer details', async () => {
      await op.locator('[data-action="o-tab"][data-k="today"]').click();
      await op.locator('[data-action="o-na-toggle"]').click();
      await op.locator('#f_na_barber').selectOption(samId);
      await op.locator('#f_na_service').selectOption('s1');
      await op.waitForSelector('.new-appt-panel .slot-btn');
      await op.locator('.new-appt-panel .slot-btn').first().click();
      await fillF(op, 'f_na_name', 'Mike Donnelly'); await fillF(op, 'f_na_phone', '(516) 555-0110'); await fillF(op, 'f_na_email', 'mike.d@example.com'); await fillF(op, 'f_na_notes', 'private note xyz');
      await op.locator('[data-f="na.optin"]').check();
      await op.locator('form[data-submit="o-na-submit"] button[type="submit"]').click();
      await op.waitForSelector('.appt-card:has-text("Mike Donnelly")');
      const t = await op.locator('.appt-card:has-text("Mike Donnelly")').innerText();
      ok(t.includes('516-555-0110') && t.includes('mike.d@example.com') && t.includes('private note xyz'), 'owner sees phone, email and notes on the booking card');
      ok((await bodyText(op)).includes('Added by you'), 'manual booking marked as added by the owner');
    });

    await section('owner: customers tab, opt-in, CSV + backup downloads, block/unblock', async () => {
      await op.locator('[data-action="o-tab"][data-k="customers"]').click();
      await op.waitForSelector('.breakdown-table');
      const row = op.locator('tr:has-text("Mike Donnelly")');
      ok(await row.locator('input[type="checkbox"]').isChecked(), 'opt-in tick box reflects the booking form');
      await row.locator('input[type="checkbox"]').uncheck();
      await until(async () => !(await op.locator('tr:has-text("Mike Donnelly") input[type="checkbox"]').isChecked()), 'opt-in untick saved');
      await op.locator('tr:has-text("Mike Donnelly") input[type="checkbox"]').check();
      const dl = op.waitForEvent('download');
      await op.locator('#dl-csv').click();
      const d = await dl;
      const csv = fs.readFileSync(await d.path(), 'utf8');
      ok(d.suggestedFilename().endsWith('.csv') && csv.startsWith('First Name,Last Name,Phone'), 'CSV link downloads a contacts file: ' + d.suggestedFilename());
      ok(csv.includes('Mike,Donnelly,5165550110'), 'CSV contains the opted-in customer');
      const dl2 = op.waitForEvent('download'); await op.locator('#dl-csv-all').click();
      ok(fs.readFileSync(await (await dl2).path(), 'utf8').includes('Mike,Donnelly'), '"all contacts" CSV variant works');
      const dl3 = op.waitForEvent('download'); await op.locator('#dl-backup').click();
      const bk = JSON.parse(fs.readFileSync(await (await dl3).path(), 'utf8'));
      ok(Array.isArray(bk.bookings) && bk.bookings.length >= 1 && !JSON.stringify(bk).includes('pin_hash'), 'backup JSON downloads (no secrets inside)');
      // block + unblock
      await fillF(op, 'f_blk_phone', '516-555-0666'); await fillF(op, 'f_blk_name', 'repeat no-show');
      await op.locator('form[data-submit="o-block-add"] button[type="submit"]').click();
      await op.waitForSelector('.settings-item:has-text("516-555-0666")');
      const blockedTry = await appA.client().post('/api/bookings', { serviceId: 's1', barberId: 'b2', date: '2026-10-01', time: '10:00', name: 'Blocked Guy', phone: '516-555-0666' });
      eq(blockedTry.json.code, 'blocked', 'a blocked number cannot book online');
      await op.locator('.settings-item:has-text("516-555-0666") [data-action="o-unblock"]').click();
      await until(async () => (await op.locator('.settings-item:has-text("516-555-0666")').count()) === 0, 'unblock');
    });

    /* ============================================================== barber via the invite link */
    const barCtx = await newContext(browser);
    const bp = await barCtx.newPage();
    const barberBodies = [];
    bp.on('response', async (res) => { if (res.url().includes('/api/')) { try { barberBodies.push({ url: res.url(), text: await res.text() }); } catch (e) { /* ignore */ } } });
    await section('barber PIN setup through the invite link, then the schedule', async () => {
      await bp.goto(inviteUrl);
      await bp.waitForSelector('form[data-submit="staff-setup"]');
      ok((await bodyText(bp)).includes('Sam') && (await bodyText(bp)).includes('Crea tu acceso'), 'invite link lands on the setup screen (Sam is set to Spanish)');
      eq(await bp.evaluate(() => document.documentElement.lang), 'es', '<html lang> follows the language');
      await bp.locator('[data-action="staff-lang"][data-k="en"]').click();
      ok((await bodyText(bp)).includes('Create your login'), 'language can be switched before signing in');
      ok(await bp.locator('#f_st_newpin').evaluate((e) => e.inputMode === 'numeric' && e.maxLength === 6), 'PIN field is numeric with a 6-digit limit');
      await fillF(bp, 'f_st_newpin', '12345'); await fillF(bp, 'f_st_newpin2', '12345');
      await bp.locator('button[type="submit"]').click();
      ok((await bodyText(bp)).includes('exactly 6 digits'), '5-digit PIN rejected');
      await fillF(bp, 'f_st_newpin', BARBER_PIN); await fillF(bp, 'f_st_newpin2', '111111');
      await bp.locator('button[type="submit"]').click();
      ok((await bodyText(bp)).includes('don’t match'), 'mismatched confirmation rejected');
      await fillF(bp, 'f_st_newpin', BARBER_PIN); await fillF(bp, 'f_st_newpin2', BARBER_PIN);
      await bp.locator('button[type="submit"]').click();
      await bp.waitForSelector('#staff-name');
      eq(await bp.locator('#staff-name').innerText(), 'Sam', 'barber is signed in and sees their own schedule');
      ok(!/staff=/.test(bp.url()), 'invite token removed from the URL');
      await until(async () => (await bp.evaluate(() => fetch('/api/staff/me').then((r) => r.json()))).barber.lang === 'en', 'language choice saved to the server');
      await noHScroll(bp, 'barber schedule 390px'); await noInlineHandlers(bp, 'barber view');
    });
    await section('an invite link works only once', async () => {
      const ctx = await newContext(browser);
      const p = await ctx.newPage();
      expectHttp(404, '/api/staff/setup-info');
      await p.goto(inviteUrl);
      await p.waitForSelector('text=expired');
      ok(true, 'the used invite link now says it has expired');
      await ctx.close();
    });
    await section('barber view shows first names only — nothing private in the DOM or the network', async () => {
      // give Sam a booking made by a real customer with a distinctive last name / phone / email / note
      await bp.locator('[data-action="staff-refresh"]').click();
      await bp.waitForSelector('.staff-appt-row');
      const rowText = await bp.locator('.staff-appt-row').first().innerText();
      ok(rowText.includes('Mike') && rowText.includes('The Quality Cut'), 'appointment shows first name + service');
      const html = await bp.content(); const text = await bodyText(bp);
      for (const secret of ['Donnelly', '555-0110', '5165550110', 'mike.d@example.com', 'private note xyz']) {
        ok(!html.includes(secret) && !text.includes(secret), `barber DOM never contains "${secret}"`);
      }
      const net = barberBodies.map((b) => b.text).join('\n');
      for (const secret of ['Donnelly', '555-0110', '5165550110', 'mike.d@example.com', 'private note xyz']) ok(!net.includes(secret), `barber network responses never contain "${secret}"`);
      ok(net.includes('"firstName":"Mike"'), 'barber API returns the first name');
      await shot(bp, '10-barber-schedule', { fullPage: true });
    });
    await section('barber: Spanish toggle, time off, done, sign out / sign in', async () => {
      await bp.locator('[data-action="staff-lang"][data-k="es"]').click();
      await until(async () => (await bodyText(bp)).includes('Cerrar sesión'), 'Spanish UI');
      const t = await bodyText(bp);
      ok(t.includes('Tiempo libre') && t.includes('Solo hora, nombre de pila') && t.includes('El Corte de Calidad'), 'schedule, hint and service names are in Spanish');
      eq(await bp.evaluate(() => document.documentElement.lang), 'es', '<html lang="es"> while in Spanish');
      ok(/Hoy — (mié|jue|vie|sáb|dom|lun|mar), 30 sep/.test(t), 'dates are formatted in Spanish ("Hoy — mié, 30 sep")');
      await shot(bp, '11-barber-spanish', { fullPage: false });
      // time off: all day tomorrow -> not bookable
      await fillF(bp, 'f_st_offDate', '2026-10-01');
      await bp.locator('[data-action="staff-add-off"]').click();
      await bp.waitForSelector('.off-item');
      const av = await fetch(A + '/api/availability?service=s1&barber=' + samId + '&days=3').then((r) => r.json());
      eq(av.days[1].slots.length, 0, 'all-day time off removes tomorrow from public availability');
      await bp.locator('[data-action="staff-rm-off"]').click();
      await until(async () => (await bp.locator('.off-item').count()) === 0, 'time off removed');
      // partial block
      await bp.locator('[data-action="staff-off-mode"][data-k="part"]').click();
      await fillF(bp, 'f_st_offDate', '2026-09-30'); await fillF(bp, 'f_st_offFrom', '14:00'); await fillF(bp, 'f_st_offTo', '15:00');
      await bp.locator('[data-action="staff-add-off"]').click();
      await bp.waitForSelector('.off-item');
      const av2 = await fetch(A + '/api/availability?service=s1&barber=' + samId + '&days=1').then((r) => r.json());
      ok(!av2.days[0].slots.some((s) => s.time === '14:00' || s.time === '14:30'), 'a time range block hides those slots');
      await bp.locator('[data-action="staff-rm-off"]').click();
      // done
      await bp.locator('[data-action="staff-mark"][data-k="completed"]').first().click();
      await until(async () => (await bp.locator('.staff-appt-row').count()) === 0, 'appointment marked done disappears');
      // sign out / in
      await bp.locator('[data-action="staff-logout"]').click();
      await bp.waitForSelector('[data-action="staff-pick"]');
      ok((await bodyText(bp)).includes('Sam'), 'sign-in lists barbers who have a login');
      await bp.locator(`[data-action="staff-pick"][data-id="${samId}"]`).click();
      await fillF(bp, 'f_st_pin', '000000');
      expectHttp(401, '/api/staff/login');
      await bp.locator('button[type="submit"]').click();
      await bp.waitForSelector('.notice-error');
      ok((await bodyText(bp)).length > 0 && /PIN/i.test(await bp.locator('.notice-error').innerText()), 'wrong PIN shows a friendly message');
      await fillF(bp, 'f_st_pin', BARBER_PIN);
      await bp.locator('button[type="submit"]').click();
      await bp.waitForSelector('#staff-name');
      ok(true, 'barber signs back in with the 6-digit PIN');
      // a returning barber opening #staff goes straight to the schedule (cookie session)
      await bp.goto(A + '/#staff'); await bp.reload();
      await bp.waitForSelector('#staff-name');
      ok(true, 'HttpOnly cookie session restores the schedule after a reload');
      ok(!(await bp.evaluate(() => document.cookie)).includes('bc_staff'), 'session cookie is HttpOnly (not readable by scripts)');
      // owner sees the status change
      await op.locator('[data-action="o-tab"][data-k="today"]').click();
      await op.locator('[data-action="o-refresh"]').click();
      await until(async () => (await op.locator('.appt-card:has-text("Mike Donnelly") .pill-completed').count()) === 1, 'owner sees completed');
    });

    /* ============================================================== Stripe path (app A) */
    await section('Stripe Checkout redirect + return + webhook (fake Stripe)', async () => {
      const ctx = await newContext(browser);
      let mode = 'success';
      await ctx.route('https://checkout.stripe.test/**', (route) => {
        const s = appA.fakeStripe.sessions[appA.fakeStripe.sessions.length - 1];
        const url = mode === 'success' ? s.params.success_url : s.params.cancel_url;
        route.fulfill({ status: 302, headers: { location: url }, body: '' });
      });
      const p = await ctx.newPage();
      await p.goto(A + '/'); await p.waitForSelector('.team-card');
      // "Book with Joe" from the team strip jumps straight to the service step
      await p.locator('.team-card [data-action="quick-book"][data-id="b1"]').click();
      ok((await p.locator('.step-title').innerText()).includes('Choose a service'), 'team card starts the wizard at the service step');
      await p.locator('[data-action="pick-service"][data-id="s2"]').click();
      await p.locator('.wiz-nav .btn-primary').click();
      await p.waitForSelector('.slot-btn');
      // choose a later day too
      await p.locator('.day-btn:not([disabled])').nth(1).click();
      await p.waitForSelector('.slot-btn');
      await pickSlot(p, 0);
      await fillInfo(p, { name: 'Casey Stripe', phone: '516-555-0177', email: 'casey@example.com', optIn: false });
      await p.locator('.wiz-nav .btn-primary').click();
      await p.waitForSelector('[data-action="book"]');
      // success: leave the webhook for later so the page has to poll
      await p.locator('[data-action="book"]').click();
      await p.waitForSelector('text=Finishing your payment', { timeout: 10000 });
      ok(true, 'redirected to Stripe, came back to /?pay=success and is polling');
      ok(!/pay=|[?&]t=/.test(p.url()), 'token stripped from the URL right away');
      await sleep(2500);
      const s = appA.fakeStripe.sessions[appA.fakeStripe.sessions.length - 1];
      const bookingId = s.params['metadata[booking_id]'];
      ok(bookingId, 'Stripe session carries the booking id');
      const { paidEvent } = require('./helpers');
      const hook = await appA.sendWebhook(appA.client(), paidEvent('evt_e2e_1', bookingId, s.id));
      eq(hook.status, 200, 'signed webhook accepted');
      await p.waitForSelector('.confirm-wrap', { timeout: 15000 });
      ok((await bodyText(p)).includes('Kids Cut') && /CONFIRMATION #[A-Z0-9]{8}/.test(await bodyText(p)), 'polling picks up the webhook and shows the confirmation');
      // cancel path: a second booking, come back with ?pay=cancel
      mode = 'cancel';
      await p.locator('[data-action="book-another"]').click();
      await p.locator('[data-action="pick-barber"][data-id="b2"]').click();
      await p.locator('.wiz-nav .btn-primary').click();
      await p.locator('[data-action="pick-service"][data-id="s6"]').click();
      await p.locator('.wiz-nav .btn-primary').click();
      await p.waitForSelector('.slot-btn');
      const slot = await p.locator('.slot-btn').first().getAttribute('data-time');
      await p.locator('.slot-btn').first().click();
      await p.locator('.wiz-nav .btn-primary').click();
      await fillInfo(p, { name: 'Casey Cancel', phone: '516-555-0188' });
      await p.locator('.wiz-nav .btn-primary').click();
      await p.locator('[data-action="book"]').click();
      await p.waitForSelector('text=Payment not completed', { timeout: 10000 });
      ok((await bodyText(p)).includes('time was released'), 'cancel return says the payment did not happen and the time was released');
      const date = (await fetch(A + '/api/availability?service=s6&barber=b2&days=1').then((r) => r.json())).days[0];
      ok(date.slots.some((x) => x.time === slot), 'the released time is bookable again');
      await p.locator('[data-action="book-another"]').click();
      await p.waitForSelector('[data-action="pick-barber"]');
      ok(true, '"Try again" restarts the wizard');
      await ctx.close();
    });

    /* ============================================================== a stuck payment (runs ~60s in the background) */
    await section('payment that never confirms shows the calm fallback (60s window, checked at the end)', async () => {
      const ctx = await newContext(browser);
      slowPage = { ctx, page: await ctx.newPage(), started: Date.now() };
      const r = await appA.client().post('/api/bookings', { serviceId: 's1', barberId: 'b3', date: '2026-10-02', time: '11:00', name: 'Slow Payer', phone: '516-555-0155' });
      eq(r.json.status, 'pending', 'created a pending booking that will never be paid');
      const tok = r.json.token;
      await slowPage.page.goto(A + '/?pay=success&t=' + tok);
      await slowPage.page.waitForSelector('text=Finishing your payment');
      ok(true, 'polling screen is shown while waiting');
    });

    /* ============================================================== settings & XSS escaping */
    await section('owner settings: hours, fee, policies, services, escaping', async () => {
      await op.locator('[data-action="o-tab"][data-k="settings"]').click();
      await op.waitForSelector('form[data-submit="o-set-info"]');
      await noHScroll(op, 'settings 390px');
      // shop name with characters that must be escaped
      await fillF(op, 'f_s_name', 'Barber\'s "Chops" &amp; Co');
      await op.locator('form[data-submit="o-set-info"] button[type="submit"]').click();
      await op.waitForSelector('form[data-submit="o-set-info"] .notice-ok');
      const pub = await fetch(A + '/api/public').then((r) => r.json());
      const p2 = await (await newContext(browser)).newPage();
      await p2.goto(A + '/'); await p2.waitForSelector('.footer-grid h4');
      eq(await p2.locator('.footer-grid h4').first().textContent(), pub.shop.name, 'shop name with quotes and &amp; is shown literally (escaped)');
      eq(await p2.locator('.brand-logo').evaluate((e) => e.getAttribute('aria-label')), pub.shop.name, 'attribute values are escaped too');
      await p2.context().close();
      await fillF(op, 'f_s_name', 'Barberchops');
      await op.locator('form[data-submit="o-set-info"] button[type="submit"]').click();
      await op.waitForSelector('form[data-submit="o-set-info"] .notice-ok');
      // hours: close Sunday
      await op.locator('[data-f="h.0.closed"]').check();
      await op.locator('form[data-submit="o-set-hours"] button[type="submit"]').click();
      await op.waitForSelector('form[data-submit="o-set-hours"] .notice-ok');
      eq((await fetch(A + '/api/public').then((r) => r.json())).shop.hours['0'], null, 'closing Sunday is saved in {0..6} format');
      await op.locator('[data-f="h.0.closed"]').uncheck();
      await op.locator('form[data-submit="o-set-hours"] button[type="submit"]').click();
      await op.waitForSelector('form[data-submit="o-set-hours"] .notice-ok');
      // policies + reminders + pre-tick
      await fillF(op, 'f_s_fee', '5'); await fillF(op, 'f_s_window', '12');
      await op.locator('form[data-submit="o-set-policy"] button[type="submit"]').click();
      await op.waitForSelector('form[data-submit="o-set-policy"] .notice-ok');
      // owner email + test email
      await fillF(op, 'f_s_ownerEmail', 'alerts@example.com');
      await op.locator('[data-action="o-test-email"]').click();
      await op.waitForSelector('form[data-submit="o-set-email"] .notice-ok');
      await until(() => appA.fakeMail.sent.some((m) => m.to.includes('alerts@example.com') && /test/i.test(m.subject)), 'test email delivered');
      ok(true, 'owner email saved and "send test email" delivers through the mail service');
      // services
      await fillF(op, 'f_sv_s5_p', '33');
      await op.locator('form[data-submit="o-set-services"] button[type="submit"]').click();
      await op.waitForSelector('form[data-submit="o-set-services"] .notice-ok');
      eq((await fetch(A + '/api/public').then((r) => r.json())).services.find((s) => s.id === 's5').price, 33, 'service price change reaches the public price list');
      // password change
      await fillF(op, 'f_pw_cur', OWNER_PW); await fillF(op, 'f_pw_new', OWNER_PW + '!'); await fillF(op, 'f_pw_new2', OWNER_PW + '!');
      await op.locator('form[data-submit="o-set-password"] button[type="submit"]').click();
      await op.waitForSelector('form[data-submit="o-set-password"] .notice-ok');
      ok(true, 'owner password can be changed');
      // system status + audit log
      const t = await bodyText(op);
      ok(/System status/.test(t) && /Stripe payments[\s\S]*Connected/.test(t) && /Email[\s\S]*Connected/.test(t), 'system status shows email + Stripe state');
      ok(/Recent security log/.test(t) && /settings changed/.test(t) && /login/.test(t), 'recent security log lists sign-ins and changes');
      await shot(op, '12-owner-settings', { fullPage: false });
      // TV screen PIN
      await fillF(op, 'f_s_boardpin', '12345');
      await op.locator('form[data-submit="o-set-boardpin"] button[type="submit"]').click();
      ok((await bodyText(op)).includes('exactly 6 digits'), 'screen PIN must be 6 digits');
      await fillF(op, 'f_s_boardpin', BOARD_PIN);
      await op.locator('form[data-submit="o-set-boardpin"] button[type="submit"]').click();
      await until(async () => (await bodyText(op)).includes('A PIN is set'), 'screen PIN saved');
      ok(true, 'TV screen PIN set from the owner dashboard');
    });

    /* ============================================================== TV board at 4K */
    await section('TV board: PIN login and 4K grid', async () => {
      const ctx = await newContext(browser, { viewport: { width: 3840, height: 2160 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
      const p = await ctx.newPage();
      await p.goto(A + '/#board');
      await p.waitForSelector('form[data-submit="board-login"]');
      await fillF(p, 'f_bd_pin', '111111');
      expectHttp(401, '/api/board/login');
      await p.locator('button[type="submit"]').click();
      await p.waitForSelector('.notice-error');
      ok(true, 'wrong screen PIN is rejected');
      await fillF(p, 'f_bd_pin', BOARD_PIN);
      await p.locator('button[type="submit"]').click();
      await p.waitForSelector('.bd-grid');
      await until(async () => (await p.locator('.bd-chip').count()) >= 1, 'bookings appear on the board');
      const m = await p.evaluate(() => {
        const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, clipped: e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1, text: e.textContent }; };
        return {
          iw: innerWidth, ih: innerHeight, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
          bodyOverflow: getComputedStyle(document.body).overflow,
          heads: [...document.querySelectorAll('.bd-head-cell .nm')].map(r), times: [...document.querySelectorAll('.bd-time')].map(r),
          chips: [...document.querySelectorAll('.bd-chip')].map(r), grid: r(document.querySelector('.bd-grid')), clock: document.getElementById('bd-clock').textContent,
          text: document.body.innerText, offenders: [...document.querySelectorAll('#app *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > innerWidth + 1 || b.bottom > innerHeight + 1 || b.left < -1 || b.top < -1); }).map((e) => e.className).slice(0, 5),
        };
      });
      ok(m.sw <= m.iw && m.sh <= m.ih, `no scrollbars at 3840x2160 (page ${m.sw}x${m.sh} in ${m.iw}x${m.ih})`);
      eq(m.offenders, [], 'nothing on the board spills outside the screen');
      eq(m.heads.length, 9, 'all 9 barbers are column headers (8 seeded + Sam)');
      ok(m.heads.every((h) => !h.clipped && h.l >= 0 && h.r <= m.iw), 'every barber name is fully visible');
      eq(m.times.length, 20, 'all 20 half-hour rows (9 AM – 7 PM) are present');
      ok(m.times.every((h) => h.t >= 0 && h.b <= m.ih), 'every time label is inside the screen');
      ok(m.times[0].text.trim() === '9:00 AM' && m.times[19].text.trim() === '6:30 PM', 'time axis runs 9:00 AM to 6:30 PM');
      ok(m.chips.length >= 1 && m.chips.every((c) => !c.clipped), 'booking chips are not clipped');
      ok(m.text.includes('Mike D.') && !m.text.includes('Donnelly') && !m.text.includes('555-0110'), 'board shows "Mike D." (label from the server) and no phone/last name');
      ok(/^10:0\d AM$/.test(m.clock.trim()), 'clock follows the SERVER time (10:0x AM), not the browser clock: ' + m.clock);
      const fontPx = await p.locator('.bd-name').first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
      ok(fontPx >= 40, `names are readable from across the room (${fontPx.toFixed(0)}px)`);
      ok(await p.locator('.bd-nowline').count() === 1, 'current-time line is drawn');
      await noInlineHandlers(p, 'board');
      await shot(p, '13-board-4k');
      // a smaller TV as well
      await p.setViewportSize({ width: 1920, height: 1080 });
      await sleep(300);
      const m2 = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, iw: innerWidth, ih: innerHeight }));
      ok(m2.sw <= m2.iw && m2.sh <= m2.ih, 'also fits 1920x1080 without scrolling');
      await p.setViewportSize({ width: 3840, height: 2160 });
      // lock (needs two deliberate taps)
      await p.locator('[data-action="board-lock"]').click({ force: true });
      ok((await p.locator('[data-action="board-lock"]').innerText()).includes('Tap again'), 'lock asks for a second tap');
      await p.locator('[data-action="board-lock"]').click({ force: true });
      await p.waitForSelector('form[data-submit="board-login"]');
      ok(true, 'locking returns to the PIN screen');
      await fillF(p, 'f_bd_pin', BOARD_PIN);
      await p.locator('button[type="submit"]').click();
      await p.waitForSelector('.bd-grid');
      // the device stays signed in (30-day cookie)
      await p.reload(); await p.waitForSelector('.bd-grid');
      ok(true, 'board stays signed in after a reload (cookie session)');
      // session ends on the server -> the next 20s poll returns to the PIN screen
      await ctx.clearCookies();
      expectHttp(401, '/api/board');
      await p.waitForSelector('form[data-submit="board-login"]', { timeout: 30000 });
      ok((await bodyText(p)).includes('locked'), 'a 401 during polling sends the screen back to its PIN entry');
      await ctx.close();
    });

    /* ============================================================== owner session expiry */
    await section('owner session expiry sends the owner back to sign-in', async () => {
      await ownCtx.clearCookies();
      expectHttp(401, '/api/owner/state');
      await op.locator('[data-action="o-refresh"]').click();
      await op.waitForSelector('form[data-submit="owner-login"]');
      ok((await bodyText(op)).includes('session ended'), '401 shows the login screen with a "session ended" note');
    });

    /* ============================================================== footer links */
    await section('footer links reach the team and shop-screen pages', async () => {
      const ctx = await newContext(browser);
      const p = await ctx.newPage();
      await p.goto(A + '/'); await p.waitForSelector('.footer-bottom');
      await p.locator('[data-action="go-staff"]').click();
      await p.waitForSelector('text=Team sign-in');
      ok(p.url().endsWith('#staff'), 'Team login link goes to #staff');
      await p.locator('[data-action="go-home"]').first().click();
      await p.waitForSelector('.hero');
      await p.locator('[data-action="go-board"]').click();
      await p.waitForSelector('form[data-submit="board-login"]');
      ok(p.url().endsWith('#board'), 'Shop screen link goes to #board');
      // expired/unknown invite link
      expectHttp(404, '/api/staff/setup-info');
      await p.goto(A + '/?staff=' + 'x'.repeat(40));
      await p.waitForSelector('text=expired');
      ok(true, 'an expired invite link shows a helpful message');
      await ctx.close();
    });

    /* ============================================================== wait for the stuck-payment page */
    await section('stuck payment: calm "finishing your payment" message after ~60s', async () => {
      const left = 68000 - (Date.now() - slowPage.started);
      if (left > 0) console.log(`  (waiting ${Math.ceil(left / 1000)}s for the 60s polling window)`);
      await slowPage.page.waitForSelector('text=We’re finishing your payment', { timeout: Math.max(5000, left + 10000) });
      const t = await bodyText(slowPage.page);
      ok(/email as soon as it goes through/.test(t) && !/error/i.test(t), 'shows a calm message (no error) and a way to check again');
      ok(await slowPage.page.locator('[data-action="pay-recheck"]').count() === 1, '"Check again" button is offered');
      await slowPage.ctx.close();
    });

    /* ============================================================== global assertions */
    await section('global: no console errors, no CSP violations, no browser storage', async () => {
      // every HTTP error seen must have been provoked on purpose by a test
      const unexpected = [];
      const pool = expectedHttp.slice();
      for (const e of httpErrors) {
        const i = pool.findIndex((x) => x.status === e.status && e.url.includes(x.urlPart));
        if (i === -1) unexpected.push(`${e.status} ${e.url}`); else pool.splice(i, 1);
      }
      eq(unexpected, [], 'no unexpected failed requests (' + httpErrors.length + ' deliberate 4xx responses seen)');
      eq(consoleErrors, [], 'zero console errors / pageerrors');
      eq(cspEvents, [], 'zero securitypolicyviolation events');
      eq(storageWrites, [], 'nothing was ever written to localStorage/sessionStorage');
    });
  } finally {
    await browser.close().catch(() => {});
    await appA.stop().catch(() => {}); await appB.stop().catch(() => {});
  }
}

main().then(() => {
  console.log(`\nE2E PASS: ${checks} checks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}).catch((e) => {
  console.error('\nE2E FAIL: ' + (e && e.stack || e));
  if (consoleErrors.length) console.error('console errors so far:\n' + consoleErrors.join('\n'));
  if (cspEvents.length) console.error('CSP events:', JSON.stringify(cspEvents));
  process.exit(1);
});
