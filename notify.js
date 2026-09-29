'use strict';
const { fmtDateLong, fmtTime } = require('./format');

function makeNotify({ db, mailer, clock, config }) {
  const svc = (id) => db.raw.prepare('SELECT name FROM services WHERE id = ?').get(id);
  const barber = (id) => db.raw.prepare('SELECT name FROM barbers WHERE id = ?').get(id);
  const shop = () => db.settings();

  function details(b) {
    return `Barber: ${barber(b.barber_id)?.name || ''}\nService: ${svc(b.service_id)?.name || ''}\nWhen: ${fmtDateLong(b.date)} at ${fmtTime(b.time)}\nConfirmation #: ${b.id.slice(0, 8).toUpperCase()}`;
  }

  return {
    // every new booking is emailed to the owner's chosen address, and confirmed to the customer if they gave an email
    bookingConfirmed(b) {
      const s = shop();
      if (s.ownerEmail && b.source === 'online') {
        mailer.queue(s.ownerEmail, `New booking: ${b.customer_name}, ${fmtDateLong(b.date)} ${fmtTime(b.time)}`,
          `New ${s.name} booking\n\nCustomer: ${b.customer_name}\nPhone: ${b.phone}${b.email ? '\nEmail: ' + b.email : ''}\n${details(b)}\n${b.notes ? 'Notes: ' + b.notes + '\n' : ''}Booking fee paid: ${b.fee_paid ? 'yes ($' + (b.fee_cents / 100).toFixed(2) + ')' : 'no'}`, 'owner-alert');
      }
      if (b.email) {
        mailer.queue(b.email, `You're booked at ${s.name} — ${fmtDateLong(b.date)} at ${fmtTime(b.time)}`,
          `Hi ${b.customer_name.split(' ')[0]},\n\nYou're booked at ${s.name}.\n\n${details(b)}\nWhere: ${s.address}\n\nPlease arrive about 10 minutes early. ` +
          `${b.fee_cents ? `Your $${(b.fee_cents / 100).toFixed(2)} booking fee holds your chair and is non-refundable. ` : ''}To change or cancel, call ${s.phone} at least ${s.cancelWindowHours} hours before your appointment.\n\n— ${s.name}`, 'customer-confirmation');
      }
      db.raw.prepare('UPDATE bookings SET alerted_at = ? WHERE id = ?').run(clock.nowMs(), b.id);
    },
    reminder(b) {
      const s = shop();
      mailer.queue(b.email, `Reminder: your ${s.name} appointment — ${fmtDateLong(b.date)} at ${fmtTime(b.time)}`,
        `Hi ${b.customer_name.split(' ')[0]},\n\nA quick reminder of your appointment.\n\n${details(b)}\nWhere: ${s.address}\n\nNeed to change plans? Call ${s.phone} at least ${s.cancelWindowHours} hours ahead to keep your fee.\n\n— ${s.name}`, 'reminder');
    },
    refundNeeded(b) {
      const s = shop();
      if (s.ownerEmail) mailer.queue(s.ownerEmail, `ACTION NEEDED: refund ${b.customer_name}'s booking fee`,
        `${b.customer_name} (${b.phone}) paid the booking fee, but the time slot had already been taken.\nPlease refund the fee in your Stripe Dashboard and contact them.\nStripe payment: ${b.stripe_payment_intent || 'see Dashboard'}`, 'refund-needed');
    },
    test(to) { mailer.queue(to, 'Barberchops test email', 'If you can read this, booking alerts will reach this inbox.', 'test'); },
  };
}
module.exports = { makeNotify };
