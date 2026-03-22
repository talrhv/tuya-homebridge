"use strict";

import dgram from "node:dgram";

export default class UdpScanner {
  constructor(log) {
    this.log = log;
    this.gatewayIp = null;
    this.server = dgram.createSocket("udp4");
  }

  start() {
    this.server.on("message", (msg, rinfo) => {
      if (msg.length >= 28 && msg.readUInt32BE(0) === 0x000055aa) {
        if (this.gatewayIp !== rinfo.address) {
          this.gatewayIp = rinfo.address;
          this.log.info(
            `🎯 [UDP Hunter] Bypass Activated! Tuya Gateway locked at IP [${this.gatewayIp}]`,
          );
        }
      }
    });

    this.server.on("error", (err) => {
      this.log.error(`🚨 [UDP Hunter] Server error:\n${err.stack}`);
      this.server.close();
    });

    this.server.on("listening", () => {
      this.log.info(
        "📡 [UDP Hunter] Pragmatic Radar is active on port 6667...",
      );
    });

    this.server.bind(6667);
  }

  getDeviceIp(deviceId) {
    return this.gatewayIp;
  }
}
