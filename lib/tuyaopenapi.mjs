"use strict";

import axios from "axios";
import http from "node:http";
import https from "node:https";
import TuyaLocalControl from "./Tuya_local_control.mjs";
import { createHash, createHmac, randomUUID } from "node:crypto";

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmacSha256UpperHex(value, key) {
  return createHmac("sha256", key).update(value).digest("hex").toUpperCase();
}

function buildSortedQuery(params) {
  const entries = Object.entries(params ?? {})
    .filter(([_, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [String(k), String(v)]);

  entries.sort(([a], [b]) => a.localeCompare(b));

  return entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

class TuyaOpenAPI {
  constructor(
    endpoint,
    accessId,
    accessKey,
    log,
    lang = "en",
    udpScanner = null,
  ) {
    this.endpoint = endpoint;
    this.access_id = accessId;
    this.access_key = accessKey;
    this.lang = lang;
    this.log = log;
    this.udpScanner = udpScanner;
    this.deviceSchema = new Map();

    this.assetIDArr = [];
    this.deviceArr = [];

    this.tokenInfo = {
      access_token: "",
      refresh_token: "",
      uid: "",
      expire: 0,
    };

    this.axiosClient = axios.create({
      baseURL: this.endpoint,
      httpAgent: new http.Agent({ keepAlive: true }),
      httpsAgent: new https.Agent({ keepAlive: true }),
      timeout: 30000,
      validateStatus: () => true,
    });
  }

  _nonce() {
    return randomUUID();
  }

  isLogin() {
    return (
      Boolean(this.tokenInfo?.access_token) &&
      this.tokenInfo.access_token.length > 0
    );
  }

  async _refreshAccessTokenIfNeed(path) {
    if (!this.isLogin()) return;
    if (path.startsWith("/v1.0/token")) return;

    const now = Date.now();
    if (this.tokenInfo.expire - 60_000 > now) return;
    if (!this.tokenInfo.refresh_token) return;

    this.tokenInfo.access_token = "";

    const res = await this.get(`/v1.0/token/${this.tokenInfo.refresh_token}`);
    if (!res?.success)
      throw new Error(`Token refresh failed: ${JSON.stringify(res)}`);

    const { access_token, refresh_token, uid, expire_time, expire } =
      res.result ?? {};
    const expiresInSeconds = Number(expire_time ?? expire ?? 0);

    this.tokenInfo = {
      access_token: access_token ?? "",
      refresh_token: refresh_token ?? "",
      uid: uid ?? "",
      expire: now + expiresInSeconds * 1000,
    };
  }

  async login(username, password) {
    const res = await this.post("/v1.0/iot-03/users/login", {
      username,
      password: sha256Hex(String(password)).toLowerCase(),
    });

    if (!res?.success) {
      throw new Error(`Login failed: ${JSON.stringify(res)}`);
    }

    const { access_token, refresh_token, uid, expire_time, expire } =
      res.result ?? {};
    const expiresInSeconds = Number(expire_time ?? expire ?? 0);
    const now = Date.now();

    this.tokenInfo = {
      access_token: access_token ?? "",
      refresh_token: refresh_token ?? "",
      uid: uid ?? "",
      expire: now + expiresInSeconds * 1000,
    };

    return res.result;
  }

  async getDeviceList() {
    const assets = await this.get_assets();

    let deviceDataArr = [];
    for (const asset of assets) {
      const res = await this.getDeviceIDList(asset.asset_id);
      deviceDataArr = deviceDataArr.concat(res);
    }

    const deviceIdArr = deviceDataArr.map((d) => d.device_id);

    const devicesInfoArr = await this.getDeviceListInfo(deviceIdArr);
    const devicesStatusArr = await this.getDeviceListStatus(deviceIdArr);

    const devices = [];
    for (const info of devicesInfoArr) {
      const functions = await this.getDeviceFunctions(info.id);

      // בניית מילון התרגום עבור השליטה המקומית ושמירת ה-Local Key
      const dpMapping = {};
      if (functions && functions.functions) {
        functions.functions.forEach((f) => {
          // שומרים את הקשר בין 'switch_1' ל-'1'
          if (f.dp_id) dpMapping[f.code] = String(f.dp_id);
        });
      }

      // שמירה בזיכרון לשלימוּש עתידי ב-sendCommand
      this.deviceSchema.set(info.id, {
        localKey: info.local_key,
        dpMapping: dpMapping,
      });

      devices.push(
        Object.assign(
          {},
          info,
          functions,
          devicesStatusArr.find((j) => j.id === info.id),
        ),
      );
    }

    return devices;
  }

  async get_assets() {
    const res = await this.get("/v1.0/iot-03/users/assets", {
      parent_asset_id: null,
      page_no: 0,
      page_size: 100,
    });
    if (!res?.success)
      throw new Error(`get_assets failed: ${JSON.stringify(res)}`);
    return res.result.assets;
  }

  async getDeviceIDList(assetID) {
    const res = await this.get(`/v1.0/iot-02/assets/${assetID}/devices`);
    if (!res?.success)
      throw new Error(`getDeviceIDList failed: ${JSON.stringify(res)}`);
    return res.result.list;
  }

  async getDeviceFunctions(deviceID) {
    const res = await this.get(`/v1.0/iot-03/devices/${deviceID}/functions`);
    if (!res?.success)
      throw new Error(`getDeviceFunctions failed: ${JSON.stringify(res)}`);
    return res.result;
  }

  async getDeviceInfo(deviceID) {
    const res = await this.get(`/v1.0/iot-03/devices/${deviceID}`);
    if (!res?.success)
      throw new Error(`getDeviceInfo failed: ${JSON.stringify(res)}`);
    return res.result;
  }

  async getDeviceListInfo(devIds = []) {
    if (devIds.length === 0) return [];

    const res = await this.get("/v1.0/iot-03/devices", {
      device_ids: devIds.join(","),
    });
    if (!res?.success)
      throw new Error(`getDeviceListInfo failed: ${JSON.stringify(res)}`);
    return res.result.list;
  }

  async getDeviceStatus(deviceID) {
    const res = await this.get(`/v1.0/iot-03/devices/${deviceID}/status`);
    if (!res?.success)
      throw new Error(`getDeviceStatus failed: ${JSON.stringify(res)}`);
    return res.result;
  }

  async getDeviceListStatus(devIds = []) {
    if (devIds.length === 0) return [];

    const res = await this.get("/v1.0/iot-03/devices/status", {
      device_ids: devIds.join(","),
    });
    if (!res?.success)
      throw new Error(`getDeviceListStatus failed: ${JSON.stringify(res)}`);
    return res.result;
  }

  // --- נקודת המפגש: ראוטינג של הפקודות ---
  async sendCommand(deviceID, params) {
    const localIp = this.udpScanner
      ? this.udpScanner.getDeviceIp(deviceID)
      : null;
    const schema = this.deviceSchema.get(deviceID);

    // ננסה שליטה מקומית רק אם יש לנו IP, מפתח הצפנה, ופקודות
    if (localIp && schema && schema.localKey && params.commands) {
      try {
        // המרה מהפורמט של הענן [{code: 'switch_1', value: true}] לפורמט של tuyapi {'1': true}
        const dpsMapping = {};
        let canUseLocal = true;

        for (const cmd of params.commands) {
          const dpId = schema.dpMapping[cmd.code];
          if (dpId) {
            dpsMapping[dpId] = cmd.value;
          } else {
            // אם יש פקודה שאין לנו תרגום שלה, נבטל את המקומי ונעבור לענן כדי לא לעשות נזק
            canUseLocal = false;
            break;
          }
        }

        if (canUseLocal && Object.keys(dpsMapping).length > 0) {
          this.log.debug(
            `⚡ [Hybrid Mode] Sending LOCAL command to ${localIp} (DPs: ${JSON.stringify(dpsMapping)})`,
          );

          await TuyaLocalControl.send(
            localIp,
            deviceID,
            schema.localKey,
            dpsMapping,
            this.log,
          );

          this.log.debug(`✅ [Hybrid Mode] Local command successful!`);
          return { success: true }; // יציאה מוקדמת - הפקודה הצליחה בלי ענן!
        }
      } catch (error) {
        this.log.warn(
          `⚠️ [Hybrid Mode] Local command failed (${error.message}). Falling back to Cloud...`,
        );
        // לא זורקים שגיאה! נותנים לקוד להמשיך לבלוק הבא של הענן.
      }
    }

    this.log.debug(`☁️ [Hybrid Mode] Sending CLOUD command for ${deviceID}`);
    const res = await this.post(
      `/v1.0/iot-03/devices/${deviceID}/commands`,
      params,
    );
    if (!res?.success)
      throw new Error(`sendCommand failed: ${JSON.stringify(res)}`);

    return res.result;
  }

  async request(method, path, params = null, body = null) {
    await this._refreshAccessTokenIfNeed(path);

    const now = Date.now();
    const access_token = this.tokenInfo.access_token || "";
    const nonce = this._nonce();

    const stringToSign = this._getStringToSign(method, path, params, body);

    const headers = {
      t: `${now}`,
      client_id: this.access_id,
      nonce,
      "Signature-Headers": "client_id",
      sign: this._getSign(
        this.access_id,
        this.access_key,
        access_token,
        now,
        nonce,
        stringToSign,
      ),
      sign_method: "HMAC-SHA256",
      access_token,
      lang: this.lang,
      dev_lang: "javascript",
      dev_channel: "homebridge",
      devVersion: "2.0.0",
    };

    this.log?.log?.(
      `TuyaOpenAPI request: ${method.toUpperCase()} ${this.endpoint}${path} params=${JSON.stringify(params)} body=${JSON.stringify(body)}`,
    );

    // --- שימוש ב-Client המהיר שחוסך את ה-Handshake ---
    const res = await this.axiosClient.request({
      url: path,
      method,
      headers,
      params,
      data: body,
    });

    this.log?.log?.(
      `TuyaOpenAPI response: ${JSON.stringify(res.data)} path=${path}`,
    );
    return res.data;
  }

  async get(path, params) {
    return this.request("get", path, params, null);
  }

  async post(path, params) {
    return this.request("post", path, null, params);
  }

  _getSign(
    access_id,
    access_key,
    access_token = "",
    timestamp = 0,
    nonce,
    stringToSign,
  ) {
    const message =
      access_id + access_token + `${timestamp}` + nonce + stringToSign;
    return hmacSha256UpperHex(message, access_key);
  }

  _getStringToSign(method, path, params, body) {
    const httpMethod = method.toUpperCase();
    const bodyStream = body ? JSON.stringify(body) : "";
    const contentSHA256 = sha256Hex(bodyStream);
    const headers = `client_id:${this.access_id}\n`;
    const url = this._getSignUrl(path, params);
    return `${httpMethod}\n${contentSHA256}\n${headers}\n${url}`;
  }

  _getSignUrl(path, params) {
    if (!params || Object.keys(params).length === 0) return path;
    const query = buildSortedQuery(params);
    return query ? `${path}?${query}` : path;
  }
}

export default TuyaOpenAPI;
