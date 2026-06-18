function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampConfidence(value) {
  const number = toNumber(value, 0);
  return Math.max(0, Math.min(100, Math.round(number)));
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

  return {
    name: String(source.name || "").trim(),
    address: String(source.address || "").trim(),
    entrance: String(access.entrance || source.entrance || "").trim(),
    location: {
      latitude: Number.isFinite(Number(location.latitude)) ? Number(location.latitude) : null,
      longitude: Number.isFinite(Number(location.longitude)) ? Number(location.longitude) : null,
      amapPoiId: String(location.amapPoiId || location.poiId || "").trim()
    },
    pricing: {
      freeMinutes: Math.max(0, toNumber(pricing.freeMinutes, 0)),
      billingUnitMinutes: Math.max(1, toNumber(pricing.billingUnitMinutes, 60)),
      unitPrice: Math.max(0, toNumber(pricing.unitPrice, 0)),
      maxDailyPrice: Math.max(0, toNumber(pricing.maxDailyPrice, 0)),
      notes: String(pricing.notes || source.notes || "").trim()
    },
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
  const freeHour = extractFirstNumber(/(\d+(?:\.\d+)?)\s*(?:小时|h|H)\s*(?:免费|内免费)/, source, null);
  const freeMinutes = freeHour == null
    ? extractFirstNumber(/(\d+)\s*(?:分钟|分)\s*(?:免费|内免费)/, source, 0)
    : Math.round(freeHour * 60);
  const halfHourPrice = extractFirstNumber(/每\s*(?:半小时|30\s*(?:分钟|分))\s*(\d+(?:\.\d+)?)\s*元/, source, null);
  const hourPrice = extractFirstNumber(/每\s*(?:小时|60\s*(?:分钟|分))\s*(\d+(?:\.\d+)?)\s*元/, source, null);
  const maxDailyPrice = extractFirstNumber(/(?:封顶|最高|上限)\s*(\d+(?:\.\d+)?)\s*元/, source, 0);

  return {
    freeMinutes,
    billingUnitMinutes: halfHourPrice == null ? 60 : 30,
    unitPrice: halfHourPrice == null ? (hourPrice || 0) : halfHourPrice,
    maxDailyPrice,
    notes: source
  };
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
