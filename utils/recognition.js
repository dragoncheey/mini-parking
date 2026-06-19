function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampConfidence(value) {
  const number = toNumber(value, 0);
  return Math.max(0, Math.min(100, Math.round(number)));
}

function pickValue(source, keys) {
  const obj = source || {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
      return obj[key];
    }
  }
  return undefined;
}

function hasValue(source, keys) {
  return pickValue(source, keys) !== undefined;
}

function numberField(source, keys, fallback) {
  return toNumber(pickValue(source, keys), fallback);
}

function textField(source, keys) {
  const value = pickValue(source, keys);
  return value == null ? "" : String(value).trim();
}

function normalizeBoolean(value, fallback) {
  if (value === true || value === "true" || value === "yes" || value === "是") return true;
  if (value === false || value === "false" || value === "no" || value === "否") return false;
  return fallback;
}

function normalizeChargeType(value, source) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "flat" || text === "per_entry" || text === "once" || text.indexOf("按次") >= 0 || text.indexOf("包") >= 0) {
    return "flat";
  }
  if (text === "ladder" || text.indexOf("阶梯") >= 0) {
    return "ladder";
  }
  if (text === "hourly" || text === "time" || text.indexOf("计时") >= 0 || text.indexOf("临时") >= 0) {
    return "hourly";
  }

  const pricing = source || {};
  if (hasValue(pricing, ["flatPrice", "packagePrice", "perEntryPrice"])) {
    return "flat";
  }
  if (Array.isArray(pricing.ladder) && pricing.ladder.length > 0) {
    return "ladder";
  }
  return "hourly";
}

function normalizeLadder(ladder) {
  if (!Array.isArray(ladder)) return [];
  return ladder.map((step) => ({
    untilMinutes: step && step.untilMinutes == null ? null : Math.max(0, toNumber(step && step.untilMinutes, 0)),
    billingUnitMinutes: Math.max(1, toNumber(step && step.billingUnitMinutes, 60)),
    unitPrice: Math.max(0, toNumber(step && step.unitPrice, 0))
  }));
}

function normalizePricingRule(raw, options) {
  const source = raw || {};
  const opts = options || {};
  const sparse = Boolean(opts.sparse);
  const chargeType = normalizeChargeType(pickValue(source, ["chargeType", "type", "billingType"]), source);
  const rule = {};

  if (!sparse || hasValue(source, ["chargeType", "type", "billingType"])) {
    rule.chargeType = chargeType;
  }

  if (!sparse || hasValue(source, ["freeMinutes", "free_minutes", "freeTimeMinutes"])) {
    rule.freeMinutes = Math.max(0, numberField(source, ["freeMinutes", "free_minutes", "freeTimeMinutes"], 0));
  }

  if (chargeType === "flat") {
    if (!sparse || hasValue(source, ["flatDurationMinutes", "packageMinutes", "durationMinutes"])) {
      rule.flatDurationMinutes = Math.max(1, numberField(source, ["flatDurationMinutes", "packageMinutes", "durationMinutes"], 1440));
    }
    if (!sparse || hasValue(source, ["flatPrice", "packagePrice", "perEntryPrice", "unitPrice"])) {
      rule.flatPrice = Math.max(0, numberField(source, ["flatPrice", "packagePrice", "perEntryPrice", "unitPrice"], 0));
    }
    if (!sparse || hasValue(source, ["flatRepeat", "repeat"])) {
      rule.flatRepeat = normalizeBoolean(pickValue(source, ["flatRepeat", "repeat"]), true);
    }
  } else {
    if (!sparse || hasValue(source, ["billingUnitMinutes", "unitMinutes", "billing_unit_minutes"])) {
      rule.billingUnitMinutes = Math.max(1, numberField(source, ["billingUnitMinutes", "unitMinutes", "billing_unit_minutes"], 60));
    }
    if (!sparse || hasValue(source, ["unitPrice", "pricePerUnit", "unit_price"])) {
      rule.unitPrice = Math.max(0, numberField(source, ["unitPrice", "pricePerUnit", "unit_price"], 0));
    }
  }

  if (!sparse || hasValue(source, ["maxDailyPrice", "dailyCap", "dailyMaxPrice"])) {
    rule.maxDailyPrice = Math.max(0, numberField(source, ["maxDailyPrice", "dailyCap", "dailyMaxPrice"], 0));
  }
  if (!sparse || hasValue(source, ["minCharge", "minimumPrice"])) {
    rule.minCharge = Math.max(0, numberField(source, ["minCharge", "minimumPrice"], 0));
  }

  const ladder = normalizeLadder(source.ladder || source.tiers);
  if (ladder.length) {
    rule.chargeType = "ladder";
    rule.ladder = ladder;
  }

  const notes = textField(source, ["notes", "description"]);
  if (notes || !sparse) {
    rule.notes = notes;
  }

  return rule;
}

function getVehicleRule(source, aliases) {
  const pricingByVehicle = source.pricingByVehicle || source.vehiclePricing || source.vehicleRules || {};
  for (const alias of aliases) {
    if (pricingByVehicle[alias]) return pricingByVehicle[alias];
    if (source[alias]) return source[alias];
  }
  return null;
}

function normalizePricingByVehicle(pricing) {
  const rules = {};
  const newEnergyRule = getVehicleRule(pricing, ["new_energy", "newEnergy", "newEnergySmallCar", "新能源", "新能源小型车"]);
  const fuelRule = getVehicleRule(pricing, ["fuel", "gasoline", "petrol", "燃油", "燃油车", "燃油小型车"]);

  if (newEnergyRule) {
    rules.new_energy = normalizePricingRule(newEnergyRule, { sparse: true });
  }
  if (fuelRule) {
    rules.fuel = normalizePricingRule(fuelRule, { sparse: true });
  }

  return rules;
}

function stripJsonFence(text) {
  const value = String(text || "").trim();
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : value;
}

function parseJsonFromText(text) {
  const raw = stripJsonFence(text);
  try {
    return JSON.parse(raw);
  } catch (error) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw error;
  }
}

function normalizeRecognition(raw) {
  const source = raw || {};
  const pricing = source.pricing || {};
  const access = source.access || {};
  const location = source.location || {};
  const normalizedPricing = normalizePricingRule(pricing);
  const pricingByVehicle = normalizePricingByVehicle(pricing);

  if (Object.keys(pricingByVehicle).length) {
    normalizedPricing.pricingByVehicle = pricingByVehicle;
  }

  return {
    name: String(source.name || "").trim(),
    address: String(source.address || "").trim(),
    entrance: String(access.entrance || source.entrance || "").trim(),
    location: {
      latitude: Number.isFinite(Number(location.latitude)) ? Number(location.latitude) : null,
      longitude: Number.isFinite(Number(location.longitude)) ? Number(location.longitude) : null,
      amapPoiId: String(location.amapPoiId || location.poiId || "").trim()
    },
    pricing: normalizedPricing,
    availability: ["high", "medium", "low", "unknown"].indexOf(source.availability) >= 0
      ? source.availability
      : "unknown",
    walkingPenaltyMinutes: Math.max(0, toNumber(source.walkingPenaltyMinutes, 0)),
    confidence: clampConfidence(source.confidence),
    evidenceSummary: String(source.evidenceSummary || "").trim(),
    warnings: Array.isArray(source.warnings) ? source.warnings.map(String) : []
  };
}

function extractFirstNumber(pattern, text, fallback) {
  const match = String(text || "").match(pattern);
  if (!match) {
    return fallback;
  }

  return toNumber(match[1], fallback);
}

function inferPricingFromText(text) {
  const source = String(text || "");
  const compact = source.replace(/\s+/g, "");
  const freeHour = extractFirstNumber(/(\d+(?:\.\d+)?)\s*(?:小时|h|H)\s*(?:免费|内免费)/, source, null);
  const thresholdMinutes = extractFirstNumber(/超过\s*(\d+)\s*(?:分钟|分)\s*收费/, source, null);
  const freeMinutes = freeHour == null
    ? extractFirstNumber(/(\d+)\s*(?:分钟|分)\s*(?:免费|内免费)/, source, thresholdMinutes || 0)
    : Math.round(freeHour * 60);
  const halfHourPrice = extractFirstNumber(/每\s*(?:半小时|30\s*(?:分钟|分))\s*(\d+(?:\.\d+)?)\s*元/, source, null);
  const hourPrice = extractFirstNumber(/每\s*(?:小时|60\s*(?:分钟|分))\s*(\d+(?:\.\d+)?)\s*元/, source, null);
  const tempCard = compact.match(/(?:临时卡|临停|临时停车)[:：]?(\d+)(?:分钟|分)(\d+(?:\.\d+)?)元/);
  const flat24 = compact.match(/(?:24小时|24h|一天|一日|每日|每天)[:：]?(\d+(?:\.\d+)?)元/);
  const perEntry = compact.match(/(?:每次|一次|按次|\/次|次收费)[:：]?(\d+(?:\.\d+)?)元|(\d+(?:\.\d+)?)元(?:\/次|每次)/);
  const overnightPrice = extractFirstNumber(/(?:过夜|过夜费)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*元/, source, null);
  const maxDailyPrice = extractFirstNumber(/(?:封顶|最高|上限)\s*(\d+(?:\.\d+)?)\s*元/, source, overnightPrice || 0);
  const newEnergyFreeHour = extractFirstNumber(/新能源[\s\S]{0,12}?(\d+(?:\.\d+)?)\s*(?:小时|h|H)[\s\S]{0,8}?(?:免费|内免费)/, source, null);
  const newEnergyFreeMinutes = newEnergyFreeHour == null
    ? extractFirstNumber(/新能源[\s\S]{0,12}?(\d+)\s*(?:分钟|分)[\s\S]{0,8}?(?:免费|内免费)/, source, null)
    : Math.round(newEnergyFreeHour * 60);

  if (perEntry || flat24) {
    const flatPrice = perEntry
      ? toNumber(perEntry[1] || perEntry[2], 0)
      : toNumber(flat24[1], 0);
    return {
      chargeType: "flat",
      freeMinutes,
      flatDurationMinutes: flat24 ? 1440 : 1440,
      flatPrice,
      flatRepeat: !perEntry,
      maxDailyPrice,
      notes: source
    };
  }

  const tempUnitMinutes = tempCard ? toNumber(tempCard[1], null) : null;
  const tempUnitPrice = tempCard ? toNumber(tempCard[2], null) : null;
  const pricing = {
    chargeType: "hourly",
    freeMinutes,
    billingUnitMinutes: tempUnitMinutes || (halfHourPrice == null ? 60 : 30),
    unitPrice: tempUnitPrice == null ? (halfHourPrice == null ? (hourPrice || 0) : halfHourPrice) : tempUnitPrice,
    maxDailyPrice,
    notes: source
  };

  if (newEnergyFreeMinutes != null) {
    pricing.pricingByVehicle = {
      new_energy: {
        freeMinutes: newEnergyFreeMinutes,
        notes: `新能源${newEnergyFreeMinutes}分钟免费，之后按默认规则计费`
      }
    };
  }

  return pricing;
}

function buildMockRecognition(payload) {
  const form = payload.form || {};
  const textHint = payload.textHint || form.notes || "";
  const pricing = inferPricingFromText(textHint);

  return normalizeRecognition({
    name: form.name || "待复核停车场",
    address: form.address || "地址待复核",
    entrance: form.entrance || "入口待复核",
    location: {
      latitude: form.latitude,
      longitude: form.longitude,
      amapPoiId: form.amapPoiId
    },
    pricing,
    availability: "unknown",
    walkingPenaltyMinutes: form.walkingPenaltyMinutes || 0,
    confidence: textHint ? 62 : 35,
    evidenceSummary: textHint ? "已根据补充文字生成测试识别结果。" : "未提供可识别文字，仅生成待复核草稿。",
    warnings: [
      "当前为本地模拟识别结果，需要人工复核。",
      "接入模型 API 后会返回更完整的结构化字段。"
    ]
  });
}

module.exports = {
  buildMockRecognition,
  normalizeRecognition,
  parseJsonFromText
};
