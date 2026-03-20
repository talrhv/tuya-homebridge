"use strict";

import axios from "axios";
import { createHash, createHmac, randomUUID } from "node:crypto";
import CountryUtil from "../util/countryutil.mjs";

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function md5Hex(value) {
  return createHash("md5").update(value).digest("hex");
}

function hmacSha256UpperHex(value, key) {
  return createHmac("sha256", key).update(value).digest("hex").toUpperCase();
}

function buildSortedQuery(params) {
  const entries = Object.entries(params ?? {})
    .filter(([_, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [String(k), String(v)]);

  entries.sort(([a], [b]) => a.localeCompare(b));

  return entries.map(([k, v]) => `${k}=${v}`).join("&");
}

class TuyaSHOpenAPI {
  constructor(
    accessId,
    accessKey,
    username,
    password,
    countryCode,
    appSchema,
    log,
    lang = "en",
  ) {
    this.countryCode = countryCode;
    this.endpoint = this.countryCode
      ? new CountryUtil().getEndPointWithCountryCode(this.countryCode)
      : "https://openapi.tuyaus.com";

    this.access_id = accessId;
    this.access_key = accessKey;
    this.lang = lang;

    this.username = username;
    this.password = password;
    this.appSchema = appSchema;

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
    return randomUUID();
  }

  async _refreshAccessTokenIfNeed(path) {
    if (
      path.startsWith("/v1.0/iot-01/associated-users/actions/authorized-login")
    )
      return;

    const now = Date.now();
    if (this.tokenInfo.expire - 60_000 > now) return;

    this.tokenInfo.access_token = "";

    const md5pwd = md5Hex(String(this.password));

    let res;
    try {
      res = await this.post(
        "/v1.0/iot-01/associated-users/actions/authorized-login",
        {
          country_code: this.countryCode,
          username: this.username,
          password: md5pwd,
          schema: this.appSchema,
        },
      );
    } catch (e) {
      this.log?.error?.(e);
      throw e;
    }

    if (!res?.success) {
      this.log?.log?.("Attention ⚠️  TuyaSH login failed.");
      throw new Error(`TuyaSH login failed: ${JSON.stringify(res)}`);
    }

    const { access_token, refresh_token, uid, expire_time, platform_url } =
      res.result ?? {};

    if (platform_url) {
      this.endpoint = platform_url;
    }

    const expiresInSeconds = Number(expire_time ?? 0);

    this.tokenInfo = {
      access_token: access_token ?? "",
      refresh_token: refresh_token ?? "",
      uid: uid ?? "",
      expire: now + expiresInSeconds * 1000,
    };
  }

  // Gets the list of devices under the associated user
  async getDevices() {
    const res = await this.get("/v1.0/iot-01/associated-users/devices", {
      size: 100,
    });
    if (!res?.success)
      throw new Error(`getDevices failed: ${JSON.stringify(res)}`);

    const tempIds = res.result?.devices?.map((d) => d.id) ?? [];
    const deviceIdsGroups = this._group(tempIds, 20);

    const devicesFunctions = [];
    for (const ids of deviceIdsGroups) {
      const functions = await this.getDevicesFunctions(ids);
      devicesFunctions.push(...functions);
    }

    const devices = [];
    for (const d of res.result.devices) {
      devices.push(
        Object.assign(
          {},
          d,
          devicesFunctions.find((j) => j.devices?.[0] === d.id),
        ),
      );
    }

    return devices;
  }

  _group(array, subGroupLength) {
    const newArray = [];
    for (let i = 0; i < array.length; i += subGroupLength) {
      newArray.push(array.slice(i, i + subGroupLength));
    }
    return newArray;
  }

  // single device gets the instruction set
  async getDeviceFunctions(deviceID) {
    const res = await this.get(`/v1.0/devices/${deviceID}/functions`);
    if (!res?.success)
      throw new Error(`getDeviceFunctions failed: ${JSON.stringify(res)}`);
    return res.result;
  }

  // Batch access to device instruction sets
  async getDevicesFunctions(devIds = []) {
    const res = await this.get("/v1.0/devices/functions", {
      device_ids: devIds.join(","),
    });
    if (!res?.success)
      throw new Error(`getDevicesFunctions failed: ${JSON.stringify(res)}`);
    return res.result;
  }

  // Get individual device details
  async getDeviceInfo(deviceID) {
    const res = await this.get(`/v1.0/devices/${deviceID}`);
    if (!res?.success)
      throw new Error(`getDeviceInfo failed: ${JSON.stringify(res)}`);
    return res.result;
  }

  // Batch access to device details
  async getDeviceListInfo(devIds = []) {
    if (devIds.length === 0) return [];
    const res = await this.get("/v1.0/devices", {
      device_ids: devIds.join(","),
    });
    if (!res?.success)
      throw new Error(`getDeviceListInfo failed: ${JSON.stringify(res)}`);
    return res.result.list;
  }

  // Gets the individual device state
  async getDeviceStatus(deviceID) {
    const res = await this.get(`/v1.0/devices/${deviceID}/status`);
    if (!res?.success)
      throw new Error(`getDeviceStatus failed: ${JSON.stringify(res)}`);
    return res.result;
  }

  // Remove the device based on the device ID
  async removeDevice(deviceID) {
    const res = await this.delete(`/v1.0/devices/${deviceID}`);
    if (!res?.success)
      throw new Error(`removeDevice failed: ${JSON.stringify(res)}`);
    return res.result;
  }

  // sendCommand
  async sendCommand(deviceID, params) {
    const res = await this.post(`/v1.0/devices/${deviceID}/commands`, params);
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
    const requestUrl = this._getSignUrl(path, params);

    this.log?.log?.(
      `TuyaSHOpenAPI request: ${method.toUpperCase()} ${this.endpoint}${requestUrl} body=${JSON.stringify(body)}`,
    );

    const res = await axios({
      baseURL: this.endpoint,
      url: requestUrl,
      method,
      headers,
      data: body,
      timeout: 30_000,
      validateStatus: () => true,
    });

    this.log?.log?.(
      `TuyaSHOpenAPI response: ${JSON.stringify(res.data)} path=${path}`,
    );

    return res.data;
  }

  async get(path, params) {
    return this.request("get", path, params, null);
  }

  async post(path, params) {
    return this.request("post", path, null, params);
  }

  async delete(path, params) {
    return this.request("delete", path, params, null);
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

export default TuyaSHOpenAPI;
