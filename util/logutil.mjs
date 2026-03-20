"use strict";

/**
 * Thin wrapper around the Homebridge logger.
 *
 * Backwards compatibility:
 * - existing code calls `log.log(...)`, which we keep as a debug-only logger.
 */
class LogUtil {
  /**
   * @param {import('homebridge').Logger} hbLog
   * @param {boolean} isDebug
   */
  constructor(hbLog, isDebug = false) {
    this.hbLog = hbLog;
    this.isDebug = Boolean(isDebug);
  }

  info(...args) {
    this.hbLog.info(...args);
  }

  warn(...args) {
    this.hbLog.warn(...args);
  }

  error(...args) {
    this.hbLog.error(...args);
  }

  debug(...args) {
    if (!this.isDebug) return;
    if (typeof this.hbLog.debug === "function") {
      this.hbLog.debug(...args);
    } else {
      this.hbLog.info(...args);
    }
  }

  // legacy alias
  log(...args) {
    this.debug(...args);
  }
}

export default LogUtil;
