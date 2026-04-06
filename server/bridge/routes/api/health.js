const express = require('express');
const router = express.Router();

// GET /health/detailed — Detailed health with metrics
router.get('/health/detailed', (req, res) => {
  try {
    const { getMetrics } = require('../../utils/metrics');
    const metrics = getMetrics();
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      metrics,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

module.exports = router;
