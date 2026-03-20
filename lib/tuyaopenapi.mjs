"use strict";

import axios from "axios";
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
  constructor(endpoint, accessId, accessKey, log, lang = "en") {
    this.endpoint = endpoint;
    this.access_id = accessId;
    this.access_key = accessKey;
    this.lang = lang;
    this.log = log;

    this.assetIDArr = [];
    this.deviceArr = [];

    this.tokenInfo = {
      access_token: "",
      refresh_token: "",
      uid: "",
      // absolute epoch ms
      expire: 0,
    };
  }

  _nonce() {
    // uuid v4, no external dependency
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

  // Get all devices
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

  // Gets a list of human-actionable assets
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

  // Query the list of device IDs under the asset
  async getDeviceIDList(assetID) {
    const res = await this.get(`/v1.0/iot-02/assets/${assetID}/devices`);
    if (!res?.success)
      throw new Error(`getDeviceIDList failed: ${JSON.stringify(res)}`);
    return res.result.list;
  }

  // Gets the device instruction set
  async getDeviceFunctions(deviceID) {
    const res = await this.get(`/v1.0/iot-03/devices/${deviceID}/functions`);
    if (!res?.success)
      throw new Error(`getDeviceFunctions failed: ${JSON.stringify(res)}`);
    return res.result;
  }

  // Get individual device information
  async getDeviceInfo(deviceID) {
    const res = await this.get(`/v1.0/iot-03/devices/${deviceID}`);
    if (!res?.success)
      throw new Error(`getDeviceInfo failed: ${JSON.stringify(res)}`);
    return res.result;
  }

  // Batch access to device information
  async getDeviceListInfo(devIds = []) {
    if (devIds.length === 0) return [];

    const res = await this.get("/v1.0/iot-03/devices", {
      device_ids: devIds.join(","),
    });
    if (!res?.success)
      throw new Error(`getDeviceListInfo failed: ${JSON.stringify(res)}`);
    return res.result.list;
  }

  // Gets the individual device state
  async getDeviceStatus(deviceID) {
    const res = await this.get(`/v1.0/iot-03/devices/${deviceID}/status`);
    if (!res?.success)
      throw new Error(`getDeviceStatus failed: ${JSON.stringify(res)}`);
    return res.result;
  }

  // Batch access to device status
  async getDeviceListStatus(devIds = []) {
    if (devIds.length === 0) return [];

    const res = await this.get("/v1.0/iot-03/devices/status", {
      device_ids: devIds.join(","),
    });
    if (!res?.success)
      throw new Error(`getDeviceListStatus failed: ${JSON.stringify(res)}`);
    return res.result;
  }

  async sendCommand(deviceID, params) {
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

    const res = await axios({
      baseURL: this.endpoint,
      url: path,
      method,
      headers,
      params,
      data: body,
      timeout: 30_000,
      validateStatus: () => true,
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
    const headers = `client_id:${this.access_id}
`;
    const url = this._getSignUrl(path, params);
    return `${httpMethod}
${contentSHA256}
${headers}
${url}`;
  }

  _getSignUrl(path, params) {
    if (!params || Object.keys(params).length === 0) return path;
    const query = buildSortedQuery(params);
    return query ? `${path}?${query}` : path;
  }
}

export default TuyaOpenAPI;
