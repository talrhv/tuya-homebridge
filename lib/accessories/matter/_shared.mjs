"use strict";

export const POWER_CODES = ["switch_led", "switch_led_1", "switch_1", "switch"];
export const SWITCH_CODES = [
  "switch",
  "switch_1",
  "switch_2",
  "switch_3",
  "switch_4",
  "switch_5",
  "switch_6",
  "switch_7",
  "switch_8",
];
export const COUNTDOWN_CODES = [
  "countdown",
  "countdown_1",
  "countdown_2",
  "countdown_3",
  "countdown_4",
  "countdown_5",
  "countdown_6",
  "countdown_7",
  "countdown_8",
];
export const BRIGHTNESS_CODES = [
  "bright_value_v2",
  "bright_value",
  "bright_value_1",
];
export const COLOR_TEMP_CODES = ["temp_value_v2", "temp_value"];
export const COLOR_CODES = ["colour_data_v2", "colour_data"];
export const WORK_MODE_CODES = ["work_mode"];

export function baseIdentity(bridge, device, extraContext = {}) {
  return {
    UUID: bridge.uuidFor(device.id),
    displayName: device.name || "unnamed",
    serialNumber: String(device.id).slice(-12),
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
      ...extraContext,
    },
  };
}

export function extractStatusEntries(source) {
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

export function listFunctions(source) {
  if (Array.isArray(source?.functions)) return source.functions;
  if (Array.isArray(source?.function)) return source.function;
  return [];
}

export function getStatusValue(source, ...codes) {
  const entries = extractStatusEntries(source);
  for (const code of codes.flat().filter(Boolean)) {
    const match = entries.find((entry) => entry?.code === code);
    if (match) return match.value;
  }
  return undefined;
}

export function mergeStatusArrays(existing = [], incoming = []) {
  const map = new Map();
  for (const entry of existing ?? []) {
    if (entry?.code) map.set(entry.code, entry);
  }
  for (const entry of incoming ?? []) {
    if (entry?.code) map.set(entry.code, entry);
  }
  return Array.from(map.values());
}

export function hasCode(device, code) {
  if (!device || !code) return false;
  if (extractStatusEntries(device).some((entry) => entry?.code === code))
    return true;
  if (listFunctions(device).some((entry) => entry?.code === code)) return true;
  return false;
}

export function pickSupportedCode(device, candidates) {
  for (const code of candidates) {
    if (hasCode(device, code)) return code;
  }
  return null;
}

export function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    return [
      "true",
      "1",
      "on",
      "opened",
      "open",
      "pir",
      "alarm",
      "detected",
    ].includes(value.toLowerCase());
  }
  return fallback;
}

export function getNumericRangeForCode(device, code, fallbackMin, fallbackMax) {
  const match = listFunctions(device).find((entry) => entry?.code === code);
  const values = match?.values;
  if (typeof values === "string") {
    try {
      const parsed = JSON.parse(values);
      return {
        min: Number.isFinite(Number(parsed.min))
          ? Number(parsed.min)
          : fallbackMin,
        max: Number.isFinite(Number(parsed.max))
          ? Number(parsed.max)
          : fallbackMax,
      };
    } catch {
      // ignore parse issues
    }
  }
  return { min: fallbackMin, max: fallbackMax };
}

export function rangeToPercent(raw, range, fallback = 100) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const min = Number(range?.min ?? 0);
  const max = Number(range?.max ?? 1000);
  if (max <= min) return fallback;
  const percent = ((value - min) / (max - min)) * 100;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

export function percentToRange(percent, min, max) {
  const safe = Math.max(0, Math.min(100, Number(percent) || 0));
  return Math.round(min + ((max - min) * safe) / 100);
}

export function percentToMatterLevel(percent) {
  const safe = Math.max(0, Math.min(100, Number(percent) || 0));
  return Math.max(1, Math.min(254, Math.round((safe / 100) * 254)));
}

export function matterLevelToPercent(level) {
  const safe = Math.max(1, Math.min(254, Number(level) || 1));
  return Math.max(0, Math.min(100, Math.round((safe / 254) * 100)));
}

export function percentToMatterSat(percent) {
  const safe = Math.max(0, Math.min(100, Number(percent) || 0));
  return Math.max(0, Math.min(254, Math.round((safe / 100) * 254)));
}

export function matterSatToPercent(value) {
  const safe = Math.max(0, Math.min(254, Number(value) || 0));
  return Math.max(0, Math.min(100, Math.round((safe / 254) * 100)));
}

export function degreesToMatterHue(degrees) {
  const safe = (((Number(degrees) || 0) % 360) + 360) % 360;
  return Math.max(0, Math.min(254, Math.round((safe / 360) * 254)));
}

export function matterHueToDegrees(value) {
  const safe = Math.max(0, Math.min(254, Number(value) || 0));
  return Math.max(0, Math.min(360, Math.round((safe / 254) * 360)));
}

export function colorTempPercentToMireds(percent) {
  const safe = Math.max(0, Math.min(100, Number(percent) || 0));
  const minMireds = 147;
  const maxMireds = 454;
  return Math.round(maxMireds - ((maxMireds - minMireds) * safe) / 100);
}

export function miredsToColorTempPercent(mireds) {
  const safe = Math.max(147, Math.min(454, Number(mireds) || 454));
  const minMireds = 147;
  const maxMireds = 454;
  return Math.round(((maxMireds - safe) / (maxMireds - minMireds)) * 100);
}

export function readBrightnessPercent(source, code) {
  const range = getNumericRangeForCode(source, code, 10, 1000);
  return rangeToPercent(
    getStatusValue(source, code || BRIGHTNESS_CODES),
    range,
  );
}

export function readColorTempPercent(source, code) {
  const range = getNumericRangeForCode(source, code, 0, 1000);
  return rangeToPercent(
    getStatusValue(source, code || COLOR_TEMP_CODES),
    range,
  );
}

export function readHsColor(source, code) {
  const raw = getStatusValue(source, code || COLOR_CODES);
  if (!raw) return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === "object") {
      return {
        h: Number(parsed.h ?? 0),
        s: Math.round(Number(parsed.s ?? 0) / 10),
        v: Math.round(Number(parsed.v ?? 1000) / 10),
      };
    }
  } catch {
    // ignore parse failure
  }
  return null;
}

export function readContactOpen(source) {
  const value = getStatusValue(source, [
    "doorcontact_state",
    "contact_state",
    "door_open",
  ]);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    return ["open", "opened", "true", "1"].includes(value.toLowerCase());
  }
  return false;
}

export function readLeakDetected(source) {
  const value = getStatusValue(source, [
    "gas_sensor_status",
    "gas_sensor_state",
    "ch4_sensor_state",
    "watersensor_state",
    "watersensor_status",
    "leak_state",
    "sensor_state",
  ]);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    return [
      "alarm",
      "warn",
      "warning",
      "true",
      "1",
      "leak",
      "detected",
      "wet",
    ].includes(value.toLowerCase());
  }
  return false;
}

export function readSmokeDetected(source) {
  const value = getStatusValue(source, [
    "smoke_sensor_status",
    "smoke_sensor_state",
    "smoke_state",
    "smoke_sensor_status",
    "smoke_alarm",
  ]);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    return [
      "alarm",
      "warn",
      "warning",
      "true",
      "1",
      "detected",
      "smoke",
    ].includes(value.toLowerCase());
  }
  return false;
}

export function readMotionDetected(source) {
  const value = getStatusValue(source, [
    "pir",
    "pir_state",
    "presence_state",
    "motion_state",
  ]);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    return [
      "pir",
      "presence",
      "motion",
      "alarm",
      "detected",
      "true",
      "1",
    ].includes(value.toLowerCase());
  }
  return false;
}

export function comparePartShape(existing, created) {
  const existingParts = Array.isArray(existing?.parts) ? existing.parts : [];
  const createdParts = Array.isArray(created?.parts) ? created.parts : [];
  if (existingParts.length !== createdParts.length) return true;
  for (let i = 0; i < existingParts.length; i += 1) {
    if (existingParts[i]?.id !== createdParts[i]?.id) return true;
  }
  return false;
}

export function sortGangCodes(codes = []) {
  return [...codes].sort((left, right) => {
    const leftNum = left === "switch" ? 0 : Number(left.split("_")[1] || 999);
    const rightNum =
      right === "switch" ? 0 : Number(right.split("_")[1] || 999);
    return leftNum - rightNum;
  });
}

export function getGangCodes(device, prefix = "switch") {
  const codes = new Set();
  for (const entry of extractStatusEntries(device)) {
    if (
      (typeof entry?.code === "string" && entry.code === prefix) ||
      new RegExp(`^${prefix}_[0-9]+$`).test(entry?.code || "")
    ) {
      codes.add(entry.code);
    }
  }
  for (const entry of listFunctions(device)) {
    if (
      typeof entry?.code === "string" &&
      (entry.code === prefix ||
        new RegExp(`^${prefix}_[0-9]+$`).test(entry.code))
    ) {
      codes.add(entry.code);
    }
  }
  return sortGangCodes(Array.from(codes));
}

export function getCountdownCodes(device) {
  const codes = new Set();
  for (const entry of extractStatusEntries(device)) {
    if (
      typeof entry?.code === "string" &&
      (entry.code === "countdown" || /^countdown_[0-9]+$/.test(entry.code))
    ) {
      codes.add(entry.code);
    }
  }
  for (const entry of listFunctions(device)) {
    if (
      typeof entry?.code === "string" &&
      (entry.code === "countdown" || /^countdown_[0-9]+$/.test(entry.code))
    ) {
      codes.add(entry.code);
    }
  }
  return sortGangCodes(Array.from(codes));
}

export function toPartId(code, prefix) {
  return `${prefix}:${code}`;
}

export function partLabel(base, index) {
  return index === 0 ? base : `${base} ${index + 1}`;
}

export function readWindowOpenPercent(device, context = {}) {
  const fullyOpenDefault = context?.fullyOpenDefault === true;
  const value = Number(
    getStatusValue(
      device,
      context?.positionCode || ["percent_state", "percent_control", "position"],
    ),
  );
  if (!Number.isFinite(value)) return 0;
  return fullyOpenDefault ? value : 100 - value;
}

export function windowOpenPercentToMatterClosedPercent100ths(openPercent) {
  return Math.round(
    (100 - Math.max(0, Math.min(100, Number(openPercent) || 0))) * 100,
  );
}

export function matterClosedPercent100thsToOpenPercent(value) {
  const closed = Math.max(0, Math.min(10000, Number(value) || 0)) / 100;
  return Math.round(100 - closed);
}
