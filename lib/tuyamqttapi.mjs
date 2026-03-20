"use strict";

import { connect } from "mqtt";
import { randomUUID, createDecipheriv } from "node:crypto";

const LINK_ID = randomUUID();
const GCM_TAG_LENGTH = 16;

class TuyaOpenMQ {
  constructor(api, type, log) {
    this.type = type;
    this.api = api;
    this.log = log;

    this.message_listeners = new Set();
    this.client = null;
    this.running = false;
  }

  start() {
    this.running = true;
    void this._loop_start();
  }

  stop() {
    this.running = false;
    try {
      this.client?.end(true);
    } catch {
      // ignore
    }
  }

  async _loop_start() {
    while (this.running) {
      let res;
      try {
        res = await this._getMQConfig("mqtt");
      } catch (e) {
        this.log?.error?.("TuyaOpenMQ config error", e);
        this.stop();
        return;
      }

      if (!res?.success) {
        this.log?.error?.(`TuyaOpenMQ config failed: ${JSON.stringify(res)}`);
        this.stop();
        return;
      }

      const mqConfig = res.result;
      const { url, client_id, username, password, expire_time, source_topic } =
        mqConfig;
      this.deviceTopic = source_topic?.device;

      this.log?.log?.(`TuyaOpenMQ connecting: ${url}`);

      const client = connect(url, {
        clientId: client_id,
        username,
        password,
      });

      client.on("connect", () => this.log?.log?.("TuyaOpenMQ connected"));
      client.on("error", (err) => this.log?.error?.("TuyaOpenMQ error", err));
      client.on("end", () => this.log?.log?.("TuyaOpenMQ end"));
      client.on("message", (topic, payload) =>
        this._onMessage(topic, payload, mqConfig),
      );

      if (this.deviceTopic) {
        client.subscribe(this.deviceTopic);
      }

      try {
        this.client?.end(true);
      } catch {
        // ignore
      }
      this.client = client;

      // reconnect periodically (per Tuya expire_time)
      const sleepMs = Math.max(60, Number(expire_time ?? 7200) - 60) * 1000;
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }

  async _getMQConfig(linkType) {
    return this.api.post("/v1.0/iot-03/open-hub/access-config", {
      uid: this.api.tokenInfo.uid,
      link_id: LINK_ID,
      link_type: linkType,
      topics: "device",
      msg_encrypted_version: this.type,
    });
  }

  _onMessage(topic, payload, mqConfig) {
    try {
      const message = JSON.parse(payload.toString());

      const dataStr =
        this.type === "2.0"
          ? this._decodeMQMessage(message.data, mqConfig.password, message.t)
          : this._decodeMQMessage_1_0(message.data, mqConfig.password);

      message.data = JSON.parse(dataStr);

      this.log?.log?.(
        `TuyaOpenMQ onMessage: topic=${topic}, message=${JSON.stringify(message)}`,
      );

      if (this.deviceTopic === topic) {
        for (const listener of this.message_listeners) {
          try {
            listener(message.data);
          } catch (e) {
            this.log?.error?.("TuyaOpenMQ listener error", e);
          }
        }
      }
    } catch (e) {
      this.log?.error?.("TuyaOpenMQ message parse/decrypt error", e);
    }
  }

  // msg_encrypted_version: 1.0 (AES-128-ECB, PKCS7)
  _decodeMQMessage_1_0(b64msg, password) {
    const key = Buffer.from(String(password).substring(8, 24), "utf8");
    const encrypted = Buffer.from(String(b64msg), "base64");

    const decipher = createDecipheriv("aes-128-ecb", key, null);
    decipher.setAutoPadding(true);

    const out = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return out.toString("utf8");
  }

  // msg_encrypted_version: 2.0 (AES-128-GCM)
  _decodeMQMessage(data, password, t) {
    const tmpbuffer = Buffer.from(String(data), "base64");
    const key = String(password).substring(8, 24);

    const iv_length = tmpbuffer.readUIntBE(0, 4);
    const iv_buffer = tmpbuffer.slice(4, iv_length + 4);

    // strip IV (head) and auth tag (tail)
    const data_buffer = tmpbuffer.slice(
      iv_length + 4,
      tmpbuffer.length - GCM_TAG_LENGTH,
    );

    const decipher = createDecipheriv("aes-128-gcm", key, iv_buffer);
    decipher.setAuthTag(tmpbuffer.slice(tmpbuffer.length - GCM_TAG_LENGTH));

    // AAD: 6-byte big-endian timestamp (t)
    const ts = Number(t);
    const tsInt = Number.isFinite(ts) ? Math.floor(ts) : 0;

    const aad = Buffer.allocUnsafe(6);
    aad.writeUIntBE(tsInt, 0, 6);
    decipher.setAAD(aad);

    const out = Buffer.concat([decipher.update(data_buffer), decipher.final()]);
    return out.toString("utf8");
  }

  addMessageListener(listener) {
    this.message_listeners.add(listener);
  }

  removeMessageListener(listener) {
    this.message_listeners.delete(listener);
  }
}

export default TuyaOpenMQ;
