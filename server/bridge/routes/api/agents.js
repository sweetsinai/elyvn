'use strict';

/**
 * Multi-Agent API Routes
 *
 * Exposes the ELYVN multi-agent system to the dashboard:
 *   GET  /agents/health  — agent system health
 *   POST /agents/run     — invoke a specific agent
 *   POST /agents/pipeline — run a multi-agent pipeline
 */

const express = require('express');
const router = express.Router();
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/AppError');
const { success } = require('../../utils/response');
const { validateBody } = require('../../middleware/validateRequest');
const { z } = require('zod');

// Schemas
const RunAgentSchema = z.object({
  agent: z.enum(['receptionist', 'outreach', 'qualification', 'scheduling']),
  message: z.string().min(1).max(10000),
  systemOverride: z.string().max(5000).optional(),
});

const PipelineSchema = z.object({
  pipeline: z.enum(['newLead', 'reply', 'outreach', 'scoring']),
  data: z.record(z.unknown()),
});

// GET /agents/health — system health check
router.get('/agents/health', (req, res) => {
  try {
    const { getAgentHealth } = require('../../utils/agents');
    const { isEnabled } = require('../../utils/agents/orchestrator');

    return success(res, {
      enabled: isEnabled(),
      ...getAgentHealth(),
      feature_flag: 'ELYVN_MANAGED_AGENTS',
      current_value: process.env.ELYVN_MANAGED_AGENTS || 'false',
    });
  } catch (err) {
    return success(res, {
      enabled: false,
      error: err.message,
    });
  }
});

// POST /agents/run — invoke a single agent
router.post('/agents/run', validateBody(RunAgentSchema), async (req, res, next) => {
  try {
    const { isEnabled } = require('../../utils/agents/orchestrator');
    if (!isEnabled()) {
      return next(new AppError('FEATURE_DISABLED', 'Multi-agent system is not enabled. Set ELYVN_MANAGED_AGENTS=true', 422));
    }

    const { runAgent } = require('../../utils/agents');
    const { agent, message, systemOverride } = req.body;

    const result = await runAgent(agent, message, { systemOverride });
    return success(res, {
      agent,
      response: result.text,
      parsed: result.parsed,
      elapsed_ms: result.elapsed,
    });
  } catch (err) {
    logger.error('[agents] Run error:', err.message);
    next(err);
  }
});

// POST /agents/pipeline — run a multi-agent pipeline
router.post('/agents/pipeline', validateBody(PipelineSchema), async (req, res, next) => {
  try {
    const orchestrator = require('../../utils/agents/orchestrator');
    if (!orchestrator.isEnabled()) {
      return next(new AppError('FEATURE_DISABLED', 'Multi-agent system is not enabled. Set ELYVN_MANAGED_AGENTS=true', 422));
    }

    const { pipeline, data } = req.body;
    const db = req.app.locals.db;
    let result;

    switch (pipeline) {
      case 'newLead':
        result = await orchestrator.newLeadPipeline({ db, ...data });
        break;
      case 'reply':
        result = await orchestrator.replyPipeline({ db, ...data });
        break;
      case 'outreach':
        result = await orchestrator.outreachPipeline(data.prospect, data.client);
        break;
      case 'scoring':
        result = await orchestrator.scoringPipeline(data.lead, data.interactions);
        break;
      default:
        return next(new AppError('VALIDATION_ERROR', `Unknown pipeline: ${pipeline}`, 422));
    }

    return success(res, { pipeline, result });
  } catch (err) {
    logger.error('[agents] Pipeline error:', err.message);
    next(err);
  }
});

module.exports = router;
