const express = require('express');
const router = express.Router();

router.use(require('./stats'));
router.use(require('./calls'));
router.use(require('./messages'));
router.use(require('./leads'));
router.use(require('./clients'));
router.use(require('./intelligence'));
router.use(require('./scoring'));
router.use(require('./revenue'));
router.use(require('./bookings'));
router.use(require('./schedule'));
router.use(require('./chat'));
router.use(require('./reports'));
router.use(require('./health'));
router.use(require('./system'));
router.use(require('./exports'));
router.use(require('./usage'));
router.use(require('./settings'));
router.use(require('./referral'));
router.use(require('./agents'));

module.exports = router;
