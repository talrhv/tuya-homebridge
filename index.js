'use strict';

const { PLUGIN_NAME, PLATFORM_NAME } = require('./src/settings');
const { TuyaPlatform } = require('./src/platform');

/**
 * Homebridge Plugin Initializer.
 *
 * Must be the default export.
 * @param {import('homebridge').API} api
 */
module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, TuyaPlatform);
};
