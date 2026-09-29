'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, TODAY, TOMORROW, paidEvent } = require('./helpers');

const goodBooking = (over = {}) => ({ serviceId: 's1', barberId: 'b1', date: TOMORROW, time: '11:00', name: 'Dana Whitfield', phone: '(516) 555-8888', email: 'dana@example.com', notes: 'skin fade', optIn: true, ...over });
const lastBooking = (app) => app.db.raw.prepare('SELECT * FROM bookings ORDER BY created_at DESC, rowid DESC').get();

test('public data exposes nothing private', async () => {
  const app = await startApp();
  try {
    const c = app.client();
    const r = await c.get('/api/public');
    assert.equal(r.status, 200);
    assert.equal(r.json.barbers.length, 8);
    assert.equal(r.json.services.length, 11);
    const s = JSON.stringify(r.json);
    for (const bad of ['pin', 'email', 'hash', 'token', 'password', 'phone_norm']) assert.ok(!s.toLowerCase().includes(bad.toLowerCase()) || bad === 'phone', `public json contains "${bad}"`);
    assert.ok(!('ownerEmail' in r.json.shop));
    assert.equal(r.json.today, TODAY);
    // security headers
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-powered-by'), null);
  } finally { await app.stop(); }
});

test('availability is computed on the server in shop time', async () => {
  const app = await startApp();
  try {
    const c = app.client();
    const r = await c.get('/api/availability?service=s1&barber=b1&days=3');
    assert.equal(r.status, 200);
    assert.equal(r.json.days[0].date, TODAY);
    const todaySlots = r.json.days[0].slots.map((s) => s.time);
    assert.ok(!todaySlots.includes('10:00'), 'a slot at the current time should not be bookable');
    assert.ok(!todaySlots.includes('10:30'), 'lead time of 30 minutes');
    assert.ok(todaySlots.includes('11:00'));
    assert.ok(r.json.days[1].slots.map((s) => s.time).includes('09:00'));
    const any = await c.get('/api/availability?service=s1&barber=any&days=1');
    assert.ok(any.json.days[0].slots.every((s) => typeof s.barberId === 'string'));
    assert.equal((await c.get('/api/availability?service=nope&barber=any')).status, 400);
    assert.equal((await c.get("/api/availability?service=s1';DROP TABLE bookings;--")).status, 400);
  } finally { await app.stop(); }
});

test('first-time owner setup is protected by the setup key, then closes', async () => {
  const app = await startApp();
  try {
    const c = app.client();
    assert.equal((await c.get('/api/setup/status')).json.needsSetup, true);
    assert.equal((await c.post('/api/setup', { setupKey: 'wrong', email: 'a@b.co', password: 'longenoughpassword' })).status, 403);
    assert.equal((await c.post('/api/setup', { setupKey: app.env.SETUP_KEY, email: 'a@b.co', password: 'short' })).status, 400);
    assert.equal((await c.post('/api/setup', { setupKey: app.env.SETUP_KEY, email: 'owner@example.com', password: 'correct horse battery staple' })).status, 200);
    assert.equal((await c.get('/api/owner/session')).json.authed, true);
    assert.equal((await c.get('/api/setup/status')).json.needsSetup, false);
    const c2 = app.client();
    assert.equal((await c2.post('/api/setup', { setupKey: app.env.SETUP_KEY, email: 'evil@example.com', password: 'another long password' })).status, 403, 'setup must not be re-runnable');
    // and no owner endpoint works without a session
    for (const p of ['/api/owner/state', '/api/owner/customers.csv', '/api/owner/export.json']) assert.equal((await c2.get(p)).status, 401, p);
    assert.equal((await c2.post('/api/owner/bookings', {})).status, 401);
  } finally { await app.stop(); }
});

test('owner login locks after 5 wrong passwords and never says which part was wrong', async () => {
  const app = await startApp();
  try {
    await app.ownerClient();
    const c = app.client();
    for (let i = 0; i < 5; i++) {
      const r = await c.post('/api/owner/login', { email: 'owner@example.com', password: 'wrong-password-' + i });
      assert.equal(r.status, 401);
      assert.equal(r.json.error, 'Email or password is not right.');
    }
    const locked = await c.post('/api/owner/login', { email: 'owner@example.com', password: 'correct horse battery staple' });
    assert.equal(locked.status, 429, 'correct password must be refused while locked');
    app.clock.setFixed(app.clock.nowMs() + 16 * 60e3);
    const ok = await c.post('/api/owner/login', { email: 'owner@example.com', password: 'correct horse battery staple' });
    assert.equal(ok.status, 200);
    const unk = await app.client().post('/api/owner/login', { email: 'nobody@example.com', password: 'x'.repeat(12) });
    assert.equal(unk.json.error, 'Email or password is not right.');
  } finally { await app.stop(); }
});

test('booking + Stripe: slot held, paid only when Stripe says so', async () => {
  const app = await startApp();
  try {
    const owner = await app.ownerClient();
    await owner.patch('/api/owner/settings', { ownerEmail: 'boss@example.com' });
    const c = app.client();
    const r = await c.post('/api/bookings', goodBooking());
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'pending');
    assert.match(r.json.checkoutUrl, /^https:\/\/checkout\.stripe\.test\/pay\/cs_test_1$/);
    // the session was created server-side with the right amount and metadata
    const sess = app.fakeStripe.sessions[0].params;
    assert.equal(sess['line_items[0][price_data][unit_amount]'], '500');
    assert.equal(sess['line_items[0][price_data][currency]'], 'usd');
    const b = lastBooking(app);
    assert.equal(sess['metadata[booking_id]'], b.id);
    assert.equal(b.status, 'pending');
    assert.equal(b.fee_paid, 0);
    // pending: the slot is held for others but no emails yet
    const slots = (await c.get('/api/availability?service=s1&barber=b1&days=2')).json.days[1].slots.map((s) => s.time);
    assert.ok(!slots.includes('11:00'), 'held slot must not be offered again');
    assert.equal(app.db.raw.prepare('SELECT COUNT(*) c FROM outbox').get().c, 0);
    // customer clicking "I paid" cannot confirm anything: only Stripe can
    const st = await c.get('/api/bookings/status?t=' + encodeURIComponent(r.json.token));
    assert.equal(st.json.status, 'pending');

    // forged / unsigned webhook does nothing
    const evt = paidEvent('evt_1', b.id, 'cs_test_1');
    const forged = await app.sendWebhook(c, evt, 't=1,v1=deadbeef');
    assert.equal(forged.status, 400);
    assert.equal(lastBooking(app).status, 'pending');

    // real, signed webhook confirms it
    const ok = await app.sendWebhook(c, evt);
    assert.equal(ok.status, 200);
    assert.equal(lastBooking(app).status, 'upcoming');
    assert.equal(lastBooking(app).fee_paid, 1);
    assert.equal((await c.get('/api/bookings/status?t=' + encodeURIComponent(r.json.token))).json.status, 'upcoming');

    // replay is ignored, and no duplicate emails
    const again = await app.sendWebhook(c, evt);
    assert.equal(again.json.duplicate, true);

    // emails: owner alert + customer confirmation
    await app.ctx.mailer.flush();
    const to = app.fakeMail.sent.map((m) => m.to[0]).sort();
    assert.deepEqual(to, ['boss@example.com', 'dana@example.com']);
    const ownerMail = app.fakeMail.sent.find((m) => m.to[0] === 'boss@example.com');
    assert.match(ownerMail.text, /Dana Whitfield/);
    assert.match(ownerMail.text, /516-555-8888/);
    assert.equal(app.fakeMail.sent[0].auth, 'Bearer mail_test_key');
  } finally { await app.stop(); }
});

test('webhook rejects wrong amounts and unknown bookings', async () => {
  const app = await startApp();
  try {
    const c = app.client();
    const r = await c.post('/api/bookings', goodBooking());
    const b = lastBooking(app);
    await app.sendWebhook(c, paidEvent('evt_amt', b.id, 'cs_test_1', 100)); // customer somehow paid $1
    assert.equal(lastBooking(app).status, 'pending');
    const unknown = await app.sendWebhook(c, paidEvent('evt_unk', 'doesnotexist', 'cs_x'));
    assert.equal(unknown.status, 200);
    assert.equal(app.db.raw.prepare(`SELECT COUNT(*) c FROM bookings WHERE status='upcoming'`).get().c, 0);
    assert.ok(r.json.token);
  } finally { await app.stop(); }
});

test('two people racing for the same slot: exactly one wins', async () => {
  const app = await startApp();
  try {
    const results = await Promise.all([
      app.client().post('/api/bookings', goodBooking({ phone: '(516) 555-1001', name: 'Racer One' })),
      app.client().post('/api/bookings', goodBooking({ phone: '(516) 555-1002', name: 'Racer Two' })),
      app.client().post('/api/bookings', goodBooking({ phone: '(516) 555-1003', name: 'Racer Three' })),
    ]);
    const codes = results.map((r) => r.status).sort();
    assert.deepEqual(codes, [200, 409, 409]);
    assert.equal(app.db.raw.prepare(`SELECT COUNT(*) c FROM bookings WHERE barber_id='b1' AND date=? AND time='11:00'`).get(TOMORROW).c, 1);
  } finally { await app.stop(); }
});

test('holds expire and free the slot; cancelling a pending payment frees it right away', async () => {
  const app = await startApp();
  try {
    const c = app.client();
    const r = await c.post('/api/bookings', goodBooking());
    app.clock.setFixed(app.clock.nowMs() + 40 * 60e3);
    app.housekeeping();
    assert.equal(lastBooking(app).status, 'expired');
    const r2 = await c.post('/api/bookings', goodBooking({ phone: '(516) 555-2002' }));
    assert.equal(r2.status, 200);
    await c.post('/api/bookings/cancel-pending', { t: r2.json.token });
    assert.equal(lastBooking(app).status, 'expired');
    assert.ok(r.json.token);
  } finally { await app.stop(); }
});

test('late payment for an expired hold whose slot was taken flags a refund instead of double booking', async () => {
  const app = await startApp();
  try {
    const c = app.client();
    await (await app.ownerClient()).patch('/api/owner/settings', { ownerEmail: 'boss@example.com' });
    await c.post('/api/bookings', goodBooking({ name: 'Slow Payer', phone: '(516) 555-3003' }));
    const slow = lastBooking(app);
    app.clock.setFixed(app.clock.nowMs() + 40 * 60e3); app.housekeeping();
    await c.post('/api/bookings', goodBooking({ name: 'Quick Payer', phone: '(516) 555-3004' }));
    const quick = lastBooking(app);
    await app.sendWebhook(c, paidEvent('evt_q', quick.id, quick.stripe_session_id));
    await app.sendWebhook(c, paidEvent('evt_s', slow.id, slow.stripe_session_id));
    const rows = app.db.raw.prepare(`SELECT id,status,needs_refund FROM bookings WHERE id IN (?,?)`).all(slow.id, quick.id);
    assert.equal(rows.find((r) => r.id === quick.id).status, 'upcoming');
    const s = rows.find((r) => r.id === slow.id);
    assert.equal(s.status, 'cancelled'); assert.equal(s.needs_refund, 1);
    await app.ctx.mailer.flush();
    assert.ok(app.fakeMail.sent.some((m) => /refund/i.test(m.subject)));
  } finally { await app.stop(); }
});

test('input validation, blocked numbers, honeypot, per-phone limits', async () => {
  const app = await startApp();
  try {
    const owner = await app.ownerClient();
    const c = app.client();
    for (const bad of [{ phone: '123' }, { name: 'A' }, { email: 'not-an-email' }, { date: '2020-01-01' }, { date: 'tomorrow' }, { time: '25:00' }, { serviceId: '../x' }, { time: '03:00' }, { name: 'x'.repeat(200) }, { notes: 'n'.repeat(500) }]) {
      const r = await c.post('/api/bookings', goodBooking(bad));
      assert.ok(r.status === 400 || r.status === 409, `${JSON.stringify(bad)} -> ${r.status}`);
    }
    const inj = await c.post('/api/bookings', goodBooking({ name: '<script>alert(1)</script>Bob Smith', notes: '<img src=x onerror=alert(1)>hi', phone: '(516) 555-4004' }));
    assert.equal(inj.status, 200);
    const stored = lastBooking(app);
    assert.ok(!/[<>]/.test(stored.customer_name + stored.notes), 'markup characters must be stripped');
    // honeypot
    const before = app.db.raw.prepare('SELECT COUNT(*) c FROM bookings').get().c;
    await c.post('/api/bookings', { ...goodBooking({ phone: '(516) 555-4005', time: '12:00' }), website: 'http://spam' });
    assert.equal(app.db.raw.prepare('SELECT COUNT(*) c FROM bookings').get().c, before);
    // blocked
    await owner.post('/api/owner/blocked', { phone: '(516) 555-6666', name: 'No Show Ned' });
    const bl = await c.post('/api/bookings', goodBooking({ phone: '516-555-6666', time: '13:00' }));
    assert.equal(bl.status, 403);
    // too many pending for one phone
    let last;
    for (let i = 0; i < 4; i++) last = await c.post('/api/bookings', goodBooking({ phone: '(516) 555-7007', time: ['14:00', '14:30', '15:00', '15:30'][i] }));
    assert.equal(last.status, 429);
  } finally { await app.stop(); }
});

test('payments not configured in production refuses bookings instead of taking free ones', async () => {
  const app = await startApp({ NODE_ENV: 'production', BASE_URL: 'https://book.example.com' }, { stripe: false });
  try {
    const r = await app.client().post('/api/bookings', goodBooking());
    assert.equal(r.status, 503);
    assert.equal(app.db.raw.prepare('SELECT COUNT(*) c FROM bookings').get().c, 0);
  } finally { await app.stop(); }
});

test('REQUIRE_PAYMENT=false confirms immediately (launch before Stripe is ready)', async () => {
  const app = await startApp({ REQUIRE_PAYMENT: 'false' }, { stripe: false });
  try {
    const r = await app.client().post('/api/bookings', goodBooking());
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'confirmed');
    assert.equal(lastBooking(app).status, 'upcoming');
  } finally { await app.stop(); }
});
