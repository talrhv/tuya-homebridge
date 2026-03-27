"use strict";

import BaseAccessory from "./base_accessory.mjs";

const WINDOW_POSITION_CODES = ["percent_state", "position", "cur_pos"];
const WINDOW_TARGET_CODES = [
  "percent_control",
  "percent_state",
  "position",
  "cur_pos",
];
const WINDOW_CONTROL_CODES = ["control"];

class WindowCoveringAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.WINDOW_COVERING,
      Service.WindowCovering,
    );

    this.statusArr = deviceConfig.status || [];

    // מיפוי ה-DPs של טויה
    this.fullySituationMap = null; // קובע אם 100% זה פתוח או סגור
    this.percentControlMap = null; // שליטה (Target Position)
    this.positionMap = null; // מצב נוכחי (Current Position)

    // ניהול המצב המקומי
    this.currentPosition = 0;
    this.targetPosition = 0;

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  static buildMatterContext(device) {
    const fullyOpenDefault = this.isFullyOpenDefault(device);
    return {
      controlCode: this.pickSupportedCode(device, WINDOW_CONTROL_CODES),
      targetCode: this.pickSupportedCode(device, WINDOW_TARGET_CODES),
      fullyOpenDefault,
      profile: `window:${fullyOpenDefault ? "open" : "closed"}`,
    };
  }

  static createMatterAccessory(platform, device) {
    const matterContext = this.buildMatterContext(device);
    const position = this.openPercentToMatterClosed100ths(
      this.readWindowOpenPercent(device, matterContext),
    );

    return {
      UUID: platform.api.matter.uuid.generate(`tuya:${device.id}`),
      displayName: device.name || "unnamed",
      serialNumber: String(device.id),
      manufacturer: "Tuya",
      model:
        device.product_name ||
        device.product_id ||
        device.model ||
        device.category ||
        "Unknown",
      firmwareRevision: String(
        device.version || device.firmwareVersion || "1.0.0",
      ),
      hardwareRevision: String(device.product_id || device.category || "1.0.0"),
      context: {
        deviceId: device.id,
        category: device.category,
        ...matterContext,
      },
      deviceType: platform.api.matter.deviceTypes.WindowCovering,
      clusters: {
        windowCovering: {
          currentPositionLiftPercent100ths: position,
          targetPositionLiftPercent100ths: position,
          operationalStatus: { global: 0, lift: 0, tilt: 0 },
          endProductType: 0,
          configStatus: {
            operational: true,
            onlineReserved: true,
            liftMovementReversed: false,
            liftPositionAware: true,
            tiltPositionAware: false,
            liftEncoderControlled: true,
            tiltEncoderControlled: false,
          },
        },
      },
      handlers: this.buildMatterHandlers(platform, {
        deviceId: device.id,
        ...matterContext,
      }),
    };
  }

  static buildMatterHandlers(platform, context) {
    return {
      windowCovering: {
        upOrOpen: async () =>
          this.sendMatterControl(
            platform,
            context.deviceId,
            context.controlCode,
            "open",
          ),
        downOrClose: async () =>
          this.sendMatterControl(
            platform,
            context.deviceId,
            context.controlCode,
            "close",
          ),
        stopMotion: async () =>
          this.sendMatterControl(
            platform,
            context.deviceId,
            context.controlCode,
            "stop",
          ),
        goToLiftPercentage: async ({ liftPercent100thsValue }) => {
          const openPercent = this.matterClosed100thsToOpenPercent(
            liftPercent100thsValue,
          );
          await this.setMatterTarget(platform, context, openPercent);
        },
      },
    };
  }

  static async syncMatterState(matterBridge, accessory, device) {
    const position = this.openPercentToMatterClosed100ths(
      this.readWindowOpenPercent(device, accessory?.context),
    );

    await matterBridge.api.matter.updateAccessoryState(
      accessory.UUID,
      matterBridge.api.matter.clusterNames.WindowCovering,
      {
        currentPositionLiftPercent100ths: position,
        targetPositionLiftPercent100ths: position,
      },
    );
  }

  static async setMatterTarget(platform, context, openPercent) {
    const code = context?.targetCode || "percent_control";
    const tuyaPercent = this.openPercentToTuyaPercent(
      openPercent,
      context?.fullyOpenDefault,
    );

    await platform.tuyaOpenApi.sendCommand(context.deviceId, {
      commands: [
        {
          code,
          value: code === "position" ? String(tuyaPercent) : tuyaPercent,
        },
      ],
    });
  }

  static async sendMatterControl(platform, deviceId, code, action) {
    await platform.tuyaOpenApi.sendCommand(deviceId, {
      commands: [{ code: code || "control", value: action }],
    });
  }

  static readWindowOpenPercent(source, context = {}) {
    const raw =
      this.getStatusValue(source, "percent_state") ??
      this.getStatusValue(source, WINDOW_TARGET_CODES);
    const value = Number(raw);

    if (!Number.isFinite(value)) {
      return 100;
    }

    return this.normalizeOpenPercent(
      value,
      context?.fullyOpenDefault ?? this.isFullyOpenDefault(source),
    );
  }

  static normalizeOpenPercent(value, fullyOpenDefault) {
    const safe = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    return fullyOpenDefault ? safe : 100 - safe;
  }

  static openPercentToTuyaPercent(openPercent, fullyOpenDefault) {
    const safe = Math.max(
      0,
      Math.min(100, Math.round(Number(openPercent) || 0)),
    );
    return fullyOpenDefault ? safe : 100 - safe;
  }

  static openPercentToMatterClosed100ths(openPercent) {
    const safe = Math.max(0, Math.min(100, Number(openPercent) || 0));
    return Math.round((100 - safe) * 100);
  }

  static matterClosed100thsToOpenPercent(closedPercent100ths) {
    const safe = Math.max(0, Math.min(10000, Number(closedPercent100ths) || 0));
    return Math.round(100 - safe / 100);
  }

  static isFullyOpenDefault(source) {
    return (
      this.getStatusValue(source, "situation_set") === "fully_open" ||
      source?.category === "clkg"
    );
  }

  static pickSupportedCode(source, candidates) {
    for (const code of [candidates].flat(2).filter(Boolean)) {
      if (this.hasCode(source, code)) {
        return code;
      }
    }
    return null;
  }

  static hasCode(source, code) {
    if (!source || !code) {
      return false;
    }

    return (
      this.extractStatusEntries(source).some((entry) => entry?.code === code) ||
      this.extractFunctionEntries(source).some((entry) => entry?.code === code)
    );
  }

  static extractStatusEntries(source) {
    if (!source) return [];
    if (Array.isArray(source.status)) return source.status.filter(Boolean);
    if (Array.isArray(source.data?.status))
      return source.data.status.filter(Boolean);
    if (Array.isArray(source.statusList))
      return source.statusList.filter(Boolean);
    if (Array.isArray(source.bizData?.status))
      return source.bizData.status.filter(Boolean);
    return [];
  }

  static extractFunctionEntries(source) {
    if (Array.isArray(source?.functions))
      return source.functions.filter(Boolean);
    if (Array.isArray(source?.function)) return source.function.filter(Boolean);
    return [];
  }

  static getStatusValue(source, codes) {
    const entries = this.extractStatusEntries(source);
    for (const code of [codes].flat(2).filter(Boolean)) {
      const entry = entries.find((candidate) => candidate?.code === code);
      if (entry) {
        return entry.value;
      }
    }
    return undefined;
  }

  /**
   * הגדרת ה-Handlers עבור Homebridge 2.0
   */
  initStatus() {
    const { Characteristic } = this.platform.api.hap;
    const service = this.service;

    // --- Current Position ---
    service
      .getCharacteristic(Characteristic.CurrentPosition)
      .onGet(() => this.currentPosition);

    // --- Target Position ---
    service
      .getCharacteristic(Characteristic.TargetPosition)
      .onGet(() => this.targetPosition)
      .onSet(async (value) => {
        await this.sendTuyaCommand(Characteristic.TargetPosition, value);
      });

    // --- Position State (בדרך כלל במצב STOPPED אלא אם כן יש לוגיקה לזיהוי תנועה) ---
    service
      .getCharacteristic(Characteristic.PositionState)
      .onGet(() => Characteristic.PositionState.STOPPED);
  }

  /**
   * שליחת פקודה לטויה עם טיפול בשגיאות
   */
  async sendTuyaCommand(characteristic, value) {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    try {
      // המרת אחוזים לפי הלוגיקה של המנוע הספציפי
      const tuyaPercent = this._getCorrectPercent(value);

      let code = this.percentControlMap?.code || "percent_control";
      let tuyaValue = tuyaPercent;

      // אם הקוד הוא 'position', טויה מצפה למחרוזת
      if (code === "position") {
        tuyaValue = String(tuyaPercent);
      }

      const command = {
        commands: [{ code, value: tuyaValue }],
      };

      await this.platform.tuyaOpenApi.sendCommand(this.deviceId, command);

      this.targetPosition = value;
      this.log.debug(
        `[${this.deviceConfig.name}] Target position set to ${value}% (Tuya: ${tuyaValue})`,
      );
    } catch (error) {
      this.log.error(`[SET] Failed to set position:`, error);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * עדכון ערכים בזמן אמת מה-MQTT
   */
  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;
    if (!statusArr) return;

    this.statusArr = statusArr;

    for (const statusMap of statusArr) {
      switch (statusMap.code) {
        case "situation_set":
          this.fullySituationMap = statusMap;
          break;

        case "percent_control":
        case "position": {
          this.percentControlMap = statusMap;
          const targetPos = this._getCorrectPercent(parseInt(statusMap.value));
          this.targetPosition = targetPos;

          if (isRefresh) {
            this.service
              .getCharacteristic(Characteristic.TargetPosition)
              .updateValue(targetPos);
          }

          if (!this._isHaveDPCodeOfPercentState()) {
            this.currentPosition = targetPos;
            if (isRefresh) {
              this.service
                .getCharacteristic(Characteristic.CurrentPosition)
                .updateValue(targetPos);
            }
          }
          break;
        }

        case "percent_state": {
          this.positionMap = statusMap;
          const currentPos = this._getCorrectPercent(parseInt(statusMap.value));
          this.currentPosition = currentPos;

          if (isRefresh) {
            this.service
              .getCharacteristic(Characteristic.CurrentPosition)
              .updateValue(currentPos);
          }
          break;
        }
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  /**
   * לוגיקת היפוך אחוזים (Backend Precision)
   * בודק אם 100% זה פתוח לגמרי או סגור לגמרי
   */
  _getCorrectPercent(value) {
    return WindowCoveringAccessory.normalizeOpenPercent(
      value,
      WindowCoveringAccessory.isFullyOpenDefault({
        category: this.deviceConfig.category,
        status: this.statusArr,
      }),
    );
  }

  _isHaveDPCodeOfPercentState() {
    return this.statusArr.some((item) => item.code.includes("percent_state"));
  }

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default WindowCoveringAccessory;
