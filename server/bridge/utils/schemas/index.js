'use strict';

const common = require('./common');
const lead = require('./lead');
const auth = require('./auth');
const billing = require('./billing');
const client = require('./client');
const form = require('./form');
const onboard = require('./onboard');
const message = require('./message');
const scrape = require('./scrape');

module.exports = {
  ...common,
  ...lead,
  ...auth,
  ...billing,
  ...client,
  ...form,
  ...onboard,
  ...message,
  ...scrape,
};
