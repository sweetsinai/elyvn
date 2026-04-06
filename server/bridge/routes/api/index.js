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

module.exports = router;
