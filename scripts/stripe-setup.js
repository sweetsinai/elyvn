#!/usr/bin/env node
/**
 * ELYVN Stripe Product Setup
 *
 * Run ONCE to create Stripe products and prices.
 * Usage: STRIPE_SECRET_KEY=sk_live_xxx node scripts/stripe-setup.js
 *
 * After running, copy the output price IDs to Railway env vars.
 */

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('Error: STRIPE_SECRET_KEY not set');
  console.error('Usage: STRIPE_SECRET_KEY=sk_live_xxx node scripts/stripe-setup.js');
  process.exit(1);
}

const Stripe = require('stripe');
const stripe = new Stripe(key);

async function setup() {
  console.log(`Creating ELYVN Stripe products (${key.startsWith('sk_live') ? 'LIVE' : 'TEST'} mode)...\n`);

  // Starter — $199/mo
  const starter = await stripe.products.create({
    name: 'ELYVN Starter',
    description: '500 calls, 1,000 SMS, 200 emails/month, AI Phone Agent, SMS Auto-Reply, Missed Call Text-Back, Telegram Alerts',
  });
  const starterPrice = await stripe.prices.create({
    product: starter.id,
    unit_amount: 19900,
    currency: 'usd',
    recurring: { interval: 'month' },
  });
  console.log(`Starter:  product=${starter.id}  price=${starterPrice.id}`);

  // Pro — $399/mo
  const pro = await stripe.products.create({
    name: 'ELYVN Pro',
    description: '1,500 calls, 3,000 SMS, 500 emails/month, Everything in Starter + Follow-Up Sequences, AI Brain + Lead Scoring, Weekly Revenue Reports',
  });
  const proPrice = await stripe.prices.create({
    product: pro.id,
    unit_amount: 39900,
    currency: 'usd',
    recurring: { interval: 'month' },
  });
  console.log(`Pro:      product=${pro.id}  price=${proPrice.id}`);

  // Premium — $799/mo
  const premium = await stripe.products.create({
    name: 'ELYVN Premium',
    description: 'Everything in Pro + New Customer Finder, Automated Outreach, Unlimited everything, Priority Support',
  });
  const premiumPrice = await stripe.prices.create({
    product: premium.id,
    unit_amount: 79900,
    currency: 'usd',
    recurring: { interval: 'month' },
  });
  console.log(`Premium:  product=${premium.id}  price=${premiumPrice.id}`);

  console.log('\n--- ADD THESE TO RAILWAY ENV VARS ---');
  console.log(`STRIPE_PRICE_STARTER=${starterPrice.id}`);
  console.log(`STRIPE_PRICE_PRO=${proPrice.id}`);
  console.log(`STRIPE_PRICE_PREMIUM=${premiumPrice.id}`);
}

setup().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
