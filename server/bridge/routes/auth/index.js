/**
 * Auth router — mounts all auth sub-routes.
 * Backward-compatible: exports verifyToken, createToken, requireVerified
 * so any require('./auth') consumers keep working unchanged.
 */
const express = require('express');
const router = express.Router();

const { createToken, verifyToken } = require('./utils');
const { requireVerified } = require('./middleware');

router.use('/signup', require('./register'));
router.use('/login', require('./login'));
router.use('/', require('./session'));
router.use('/', require('./email'));

module.exports = router;
module.exports.verifyToken = verifyToken;
module.exports.createToken = createToken;
module.exports.requireVerified = requireVerified;
