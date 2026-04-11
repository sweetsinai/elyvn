/**
 * ROI Calculator API (public — no auth required)
 * Powers the landing page ROI calculator and sales conversations.
 */
const express = require('express');
const router = express.Router();
const { logger } = require('../../utils/logger');

// Industry benchmarks (from market research)
const BENCHMARKS = {
  hvac:       { avgTicket: 500, missRate: 0.35, convertRate: 0.15, label: 'HVAC' },
  plumbing:   { avgTicket: 350, missRate: 0.40, convertRate: 0.15, label: 'Plumbing' },
  electrical: { avgTicket: 275, missRate: 0.35, convertRate: 0.12, label: 'Electrical' },
  dental:     { avgTicket: 200, missRate: 0.25, convertRate: 0.20, label: 'Dental' },
  medspa:     { avgTicket: 350, missRate: 0.30, convertRate: 0.18, label: 'Med Spa' },
  salon:      { avgTicket: 80,  missRate: 0.30, convertRate: 0.25, label: 'Salon' },
  auto:       { avgTicket: 400, missRate: 0.35, convertRate: 0.12, label: 'Auto Repair' },
  veterinary: { avgTicket: 250, missRate: 0.25, convertRate: 0.18, label: 'Veterinary' },
  gym:        { avgTicket: 60,  missRate: 0.30, convertRate: 0.20, label: 'Gym/Fitness' },
  realestate: { avgTicket: 5000, missRate: 0.40, convertRate: 0.05, label: 'Real Estate' },
  legal:      { avgTicket: 3000, missRate: 0.30, convertRate: 0.08, label: 'Legal' },
  general:    { avgTicket: 300, missRate: 0.35, convertRate: 0.15, label: 'General' },
};

// POST /calculator/roi — Calculate ROI for prospect
router.post('/roi', (req, res) => {
  try {
    const { industry, weekly_calls, avg_ticket, plan } = req.body;

    const benchmark = BENCHMARKS[industry] || BENCHMARKS.general;
    const calls = Math.min(Math.max(parseInt(weekly_calls) || 30, 1), 10000);
    const ticket = Math.min(Math.max(parseFloat(avg_ticket) || benchmark.avgTicket, 1), 100000);
    const missRate = benchmark.missRate;
    const convertRate = benchmark.convertRate;

    const planCosts = { solo: 99, starter: 199, pro: 399, premium: 799 };
    const monthlyCost = planCosts[plan] || 99;

    // Math
    const monthlyMissed = Math.round(calls * 4.33 * missRate);
    const recoveredCalls = monthlyMissed; // ELYVN answers all
    const newBookings = Math.round(recoveredCalls * convertRate);
    const monthlyRevenue = Math.round(newBookings * ticket);
    const annualRevenue = monthlyRevenue * 12;
    const annualCost = monthlyCost * 12;
    const roi = annualCost > 0 ? Math.round(((annualRevenue - annualCost) / annualCost) * 100) : 0;
    const paybackDays = monthlyRevenue > 0 ? Math.round((monthlyCost / monthlyRevenue) * 30) : 999;

    res.json({
      industry: benchmark.label,
      inputs: { weekly_calls: calls, avg_ticket: ticket, plan: plan || 'starter' },
      results: {
        monthly_missed_calls: monthlyMissed,
        calls_recovered_by_elyvn: recoveredCalls,
        new_bookings_per_month: newBookings,
        monthly_revenue_recovered: monthlyRevenue,
        annual_revenue_recovered: annualRevenue,
        elyvn_annual_cost: annualCost,
        net_annual_gain: annualRevenue - annualCost,
        roi_pct: roi,
        payback_days: paybackDays,
      },
      comparison: {
        human_receptionist_annual: 42000,
        elyvn_annual: annualCost,
        savings_vs_human: 42000 - annualCost,
      },
      headline: monthlyRevenue > monthlyCost
        ? `ELYVN pays for itself in ${paybackDays} days — recovering $${monthlyRevenue}/mo in missed revenue.`
        : `At ${calls} calls/week, ELYVN saves you $${Math.round(42000 / 12 - monthlyCost)}/mo vs a human receptionist.`,
    });
  } catch (err) {
    logger.error('[calculator] ROI error:', err);
    res.status(500).json({ error: 'Calculation failed' });
  }
});

// GET /calculator/benchmarks — Return industry benchmarks (for dropdown)
router.get('/benchmarks', (req, res) => {
  const list = Object.entries(BENCHMARKS).map(([id, b]) => ({
    id,
    label: b.label,
    avg_ticket: b.avgTicket,
    miss_rate_pct: Math.round(b.missRate * 100),
  }));
  res.json({ industries: list });
});

module.exports = router;
