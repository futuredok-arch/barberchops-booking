'use strict';
const express = require('express');

// Stripe -> this server. The signature check proves the message really came from Stripe;
// without it (or with a wrong one) nothing happens.
module.exports = function stripeRoutes(ctx) {
  const { db, payments, bookings, notify, clock } = ctx;
  const r = express.Router();

  r.post('/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
    if (!payments.enabled || !payments.webhookConfigured) return res.status(503).send('webhook not configured');
    let event;
    try { event = payments.constructEvent(req.body, req.headers['stripe-signature']); }
    catch { return res.status(400).send('bad signature'); }

    const seen = db.raw.prepare('SELECT 1 FROM stripe_events WHERE id = ?').get(event.id);
    if (seen) return res.json({ received: true, duplicate: true });

    try {
      const obj = event.data && event.data.object;
      if ((event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') && obj && obj.payment_status === 'paid') {
        const bookingId = obj.metadata && obj.metadata.booking_id;
        const row = bookingId && bookings.bookingRow(String(bookingId));
        if (row && (!row.stripe_session_id || row.stripe_session_id === obj.id) && obj.currency === 'usd') {
          const out = bookings.finalize(row.id, { sessionId: obj.id, paymentIntent: typeof obj.payment_intent === 'string' ? obj.payment_intent : null, amountCents: obj.amount_total });
          if (out.ok && !out.already) notify.bookingConfirmed(out.booking);
          if (!out.ok && out.reason === 'slot_lost') notify.refundNeeded(out.booking);
          if (!out.ok && out.reason === 'amount_mismatch') db.audit('stripe', 'amount_mismatch', `booking ${row.id}`);
        }
      } else if (event.type === 'checkout.session.expired' && obj && obj.metadata && obj.metadata.booking_id) {
        db.raw.prepare(`UPDATE bookings SET status = 'expired', hold_expires = 0 WHERE id = ? AND status = 'pending'`).run(String(obj.metadata.booking_id));
      }
      db.raw.prepare('INSERT OR IGNORE INTO stripe_events (id,created_at) VALUES (?,?)').run(event.id, clock.nowMs());
      res.json({ received: true });
    } catch (e) {
      // not recorded as seen, so Stripe will retry
      res.status(500).send('processing error');
    }
  });
  return r;
};
