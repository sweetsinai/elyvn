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

  // Starter — $299/mo
  const starter = await stripe.products.create({
    name: 'ELYVN Starter',
    description: 'AI Phone Agent, SMS Auto-Reply, Missed Call Text-Back, Telegram Alerts, 500 calls/month',
  });
  const starterPrice = await stripe.prices.create({
    product: starter.id,
    unit_amount: 29900,
    currency: 'usd',
    recurring: { interval: 'month' },
  });
  console.log(`Starter:  product=${starter.id}  price=${starterPrice.id}`);

  // Growth — $499/mo
  const growth = await stripe.products.create({
    name: 'ELYVN Growth',
    description: 'Everything in Starter + Follow-Up Sequences, AI Brain + Lead Scoring, Weekly Revenue Reports, 1,500 calls/month',
  });
  const growthPrice = await stripe.prices.create({
    product: growth.id,
    unit_amount: 49900,
    currency: 'usd',
    recurring: { interval: 'month' },
  });
  console.log(`Growth:   product=${growth.id}  price=${growthPrice.id}`);

  // Scale — $799/mo
  const scale = await stripe.products.create({
    name: 'ELYVN Scale',
    description: 'Everything in Growth + New Customer Finder, Automated Outreach, Unlimited calls, Priority Support',
  });
  const scalePrice = await stripe.prices.create({
    product: scale.id,
    unit_amount: 79900,
    currency: 'usd',
    recurring: { interval: 'month' },
  });
  console.log(`Scale:    product=${scale.id}  price=${scalePrice.id}`);

  console.log('\n--- ADD THESE TO RAILWAY ENV VARS ---');
  console.log(`STRIPE_PRICE_STARTER=${starterPrice.id}`);
  console.log(`STRIPE_PRICE_GROWTH=${growthPrice.id}`);
  console.log(`STRIPE_PRICE_SCALE=${scalePrice.id}`);
}

setup().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
