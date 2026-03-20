"use strict";

import settings from "./src/settings.mjs";
import platformModule from "./src/platform.mjs";

/**
 * Homebridge Plugin Initializer.
 *
 * Must be the default export.
 * @param {import('homebridge').API} api
 */
export default (api) => {
  api.registerPlatform(
    settings.PLUGIN_NAME,
    settings.PLATFORM_NAME,
    platformModule.TuyaPlatform,
  );
};
