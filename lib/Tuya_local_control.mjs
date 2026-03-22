"use strict";

import TuyAPI from "tuyapi";

export default class TuyaLocalControl {
  /**
   * שולח פקודה ישירות למכשיר ברשת המקומית
   */
  static async send(ip, deviceId, localKey, dpsMapping, log) {
    return new Promise((resolve, reject) => {
      // אתחול המכשיר (אנחנו מזריקים את ה-IP כדי לדלג על ה-find האיטי)
      const device = new TuyAPI({
        id: deviceId,
        key: localKey,
        ip: ip,
        version: "3.1", // רוב המכשירים כיום הם 3.3
        issueRefreshOnConnect: false, // חוסך זמן
      });

      const timeout = setTimeout(() => {
        device.disconnect();
        reject(new Error("Local connection timeout"));
      }, 100);

      device.on("error", (err) => {
        clearTimeout(timeout);
        device.disconnect();
        reject(err);
      });

      device.on("connected", async () => {
        try {
          // שליחת הפקודות בפורמט multiple של tuyapi
          await device.set({
            multiple: true,
            data: dpsMapping,
          });

          clearTimeout(timeout);
          device.disconnect();
          resolve();
        } catch (err) {
          clearTimeout(timeout);
          device.disconnect();
          reject(err);
        }
      });

      // מתחברים ישירות ל-IP
      device.connect().catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }
}
