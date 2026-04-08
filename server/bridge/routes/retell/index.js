'use strict';

/**
 * index.js — Retell router entry point
 *
 * Mounts the webhook sub-router and re-exports as a single Express router
 * so that existing require('./retell') references remain backward-compatible.
 */

const express = require('express');
const router = express.Router();

const webhookRouter = require('./webhook');

// All Retell webhook traffic is handled under /
router.use('/', webhookRouter);

module.exports = router;
