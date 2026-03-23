"use strict";

class DataUtil {
  constructor() {}

  getSubService(status) {
    if (!Array.isArray(status)) return { subType: [] };

    const subTypeArr = [];

    for (const map of status) {
      if (map.code.toLowerCase().includes("switch")) {
        if (typeof map.value === "boolean") {
          subTypeArr.push(map.code);
        }
      }
    }

    subTypeArr.sort((a, b) => {
      const numA = parseInt(a.replace(/\D/g, "")) || 0;
      const numB = parseInt(b.replace(/\D/g, "")) || 0;
      return numA - numB;
    });

    return {
      subType: subTypeArr,
    };
  }

  getFriendlyName(code) {
    const num = code.match(/\d+$/);
    return num ? `Switch ${num[0]}` : "Switch";
  }
}

export default DataUtil;
