'use strict';

const authentication = require('./authentication');
const logOutcome = require('./creates/log_outcome');
const getScores = require('./searches/get_scores');
const simulateSequence = require('./searches/simulate_sequence');

module.exports = {
  version: require('./package.json').version,
  platformVersion: require('zapier-platform-core').version,

  authentication,

  // Zapier "Triggers" — none for now (Layer5 is request/response, not event-driven)
  triggers: {},

  // Zapier "Searches" — read-only lookups
  searches: {
    [getScores.key]: getScores,
    [simulateSequence.key]: simulateSequence,
  },

  // Zapier "Creates" — actions that write data
  creates: {
    [logOutcome.key]: logOutcome,
  },

  // Zapier "Resources" — none
  resources: {},
};
