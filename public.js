'use strict';
const express = require('express');
const V = require('../validate');
const sched = require('../schedule');
const { firstName } = require('../format');

// Everything here is safe for anyone on the internet to see. No phone numbers, emails,
// last names, PINs or other customers' bookings ever come out of these routes.
module.exports = function publicRoutes(ctx) {
  const { db, clock, bookings, config, payments, limits } = ctx;
  const r = express.Router();

  function photosFor(barberId) {
    const rows = db.raw.prepare('SELECT * FROM photos WHERE barber_id = ? ORDER BY created_at').all(barberId);
    return {
      photo: (rows.find((p) => p.kind === 'profile') || {}).file ? '/uploads/' + rows.find((p) => p.kind === 'profile').file : null,
      gallery: rows.filter((p) => p.kind === 'gallery').map((p) => '/uploads/' + p.file),
    };
  }

  r.get('/public', (req, res) => {
    const s = db.settings();
    res.json({
      today: clock.todayISO(),
      shop: {
        name: s.name, tagline: s.tagline, address: s.address, phone: s.phone, bookingFee: s.bookingFee,
        cancelWindowHours: s.cancelWindowHours, hours: s.hours, marketingPreTick: !!s.marketingPreTick,
        paymentsRequired: config.requirePayment && s.bookingFee > 0,
      },
      services: db.raw.prepare('SELECT id,category,name,duration,price,note FROM services WHERE active = 1 ORDER BY sort').all(),
      barbers: sched.loadBarbers(db).map((b) => ({ id: b.id, name: b.name, title: b.title, lang: b.lang, hasLogin: b.hasPin, ...photosFor(b.id) })),
    });
  });

  r.get('/availability', (req, res, next) => {
    try {
      const service = bookings.getService(V.cleanId(String(req.query.service || ''), 'service'));
      if (!service) throw V.bad('Unknown service');
      const barberQ = String(req.query.barber || 'any');
      const barberId = barberQ === 'any' ? null : V.cleanId(barberQ, 'barber');
      const days = V.cleanInt(String(req.query.days || '14'), { min: 1, max: 30, field: 'days' });
      res.json({ days: sched.availability(db, clock, db.getSetting('hours'), { barberId, duration: service.duration, days }) });
    } catch (e) { next(e); }
  });

  r.post('/bookings', limits.booking, async (req, res, next) => {
    try {
      const b = req.body || {};
      if (typeof b.website === 'string' && b.website.length) return res.json({ token: 'x'.repeat(32), status: 'pending', checkoutUrl: '/' }); // bot trap: quietly do nothing
      const phone = V.cleanPhone(b.phone);
      const input = {
        serviceId: V.cleanId(b.serviceId, 'service'),
        barberId: b.barberId ? V.cleanId(b.barberId, 'barber') : 'any',
        date: (V.cleanText(b.date, { min: 10, max: 10, field: 'date' })),
        time: (V.cleanText(b.time, { min: 5, max: 5, field: 'time' })),
        name: V.cleanText(b.name, { min: 2, max: 80, field: 'Name' }),
        phone: phone.display, phoneNorm: phone.norm,
        email: V.cleanEmail(b.email),
        notes: V.optText(b.notes, { max: 300, field: 'Notes', allowNewlines: true }),
        optIn: b.optIn === true,
      };
      const { isDate, isTime } = require('../clock');
      if (!isDate(input.date) || !isTime(input.time)) throw V.bad('That date or time is not valid');
      const out = await bookings.createOnline(input);
      res.json(out);
    } catch (e) { next(e); }
  });

  // the customer's own booking (found only by the long random token they were given)
  r.get('/bookings/status', (req, res) => {
    const b = bookings.byToken(String(req.query.t || ''));
    if (!b) return res.status(404).json({ error: 'Booking not found' });
    const svc = db.raw.prepare('SELECT name FROM services WHERE id = ?').get(b.service_id);
    const barber = db.raw.prepare('SELECT name FROM barbers WHERE id = ?').get(b.barber_id);
    res.json({
      status: b.status, service: svc && svc.name, barber: barber && barber.name, date: b.date, time: b.time,
      firstName: firstName(b.customer_name), feePaid: !!b.fee_paid, feeCents: b.fee_cents, confirmation: b.id.slice(0, 8).toUpperCase(), emailed: !!b.email,
    });
  });
  r.post('/bookings/cancel-pending', (req, res) => {
    bookings.cancelPending(String((req.body || {}).t || ''));
    res.json({ ok: true });
  });

  return r;
};
