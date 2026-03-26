const express = require('express');
const router = express.Router();

// Import sub-routers
const scrapeRouter = require('./scrape');
const campaignsRouter = require('./campaigns');
const emailSendRouter = require('./email-send');
const repliesRouter = require('./replies');

// Mount sub-routers at appropriate paths
router.use('/', scrapeRouter);           // /scrape, /blast
router.use('/', campaignsRouter);        // /campaign, /campaign/:campaignId/generate, /campaign/:campaignId/ab-results
router.use('/', emailSendRouter);        // /campaign/:campaignId/send, /campaign/:campaignId/email/:emailId
router.use('/', repliesRouter);          // /replies, /replies/:emailId/classify, /auto-classify

module.exports = router;
