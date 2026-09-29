'use strict';
const Stripe = require('stripe');

// Card and Apple Pay details never touch this server: the customer pays on Stripe's own page.
// This code only asks Stripe to create that page and then listens (with a signature check) for
// Stripe's message that the payment really happened.
function makePayments(config) {
  const enabled = !!config.stripe.secretKey;
  const opts = { maxNetworkRetries: 1, timeout: 20000 };
  if (config.stripe.host) { opts.host = config.stripe.host; opts.port = config.stripe.port; opts.protocol = config.stripe.protocol || 'https'; }
  const stripe = enabled ? new Stripe(config.stripe.secretKey, opts) : null;

  return {
    enabled,
    webhookConfigured: !!config.stripe.webhookSecret,
    async createCheckout({ booking, feeCents, token, shopName }) {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{
          quantity: 1,
          price_data: {
            currency: 'usd', unit_amount: feeCents,
            product_data: { name: `Booking fee — ${shopName}`, description: 'Holds your chair. Non-refundable; not credited toward the service.' },
          },
        }],
        metadata: { booking_id: booking.id },
        client_reference_id: booking.id,
        ...(booking.email ? { customer_email: booking.email } : {}),
        payment_intent_data: { description: `${shopName} booking fee`, metadata: { booking_id: booking.id } },
        success_url: `${config.baseUrl}/?pay=success&t=${encodeURIComponent(token)}`,
        cancel_url: `${config.baseUrl}/?pay=cancel&t=${encodeURIComponent(token)}`,
        expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
      });
      return { id: session.id, url: session.url };
    },
    constructEvent(rawBody, signature) {
      return stripe.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
    },
  };
}
module.exports = { makePayments };
