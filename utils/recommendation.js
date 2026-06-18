const {
  calculateParkingFee,
  calculateParkingFeeForVehicle,
  describePricing,
  describePricingForVehicle,
  formatDuration,
  formatMoney
} = require("./pricing");
const { calculateDistanceMeters, estimateWalkingMinutes, formatDistance } = require("./location");

const AVAILABILITY_LABELS = {
  high: "车位较稳",
  medium: "车位一般",
  low: "可能满位",
  unknown: "车位待确认"
};

const AVAILABILITY_PENALTY = {
  high: 0,
  medium: 4,
  low: 12,
  unknown: 7
};

function daysSince(dateText) {
  const timestamp = Date.parse(dateText);
  if (!Number.isFinite(timestamp)) {
    return 999;
  }

  const now = Date.now();
  return Math.max(0, Math.floor((now - timestamp) / 86400000));
}

function freshnessPenalty(updatedAt) {
  const days = daysSince(updatedAt);
  if (days <= 14) {
    return 0;
  }
  if (days <= 45) {
    return 2;
  }
  return 6;
}

function confidencePenalty(confidence) {
  const value = Number.isFinite(Number(confidence)) ? Number(confidence) : 50;
  return Math.max(0, (85 - value) / 8);
}

function collectTags(lot, fee, cheapestFee, walkingMinutes) {
  const tags = [];
  const availability = lot.availability || "unknown";

  if (fee === 0) {
    tags.push("当前时长免费");
  } else if (fee === cheapestFee) {
    tags.push("费用最低");
  }

  if (walkingMinutes <= 5) {
    tags.push("步行近");
  }

  tags.push(AVAILABILITY_LABELS[availability] || AVAILABILITY_LABELS.unknown);

  if ((lot.confidence || 0) < 65) {
    tags.push("建议复核");
  }

  return tags;
}

function buildReason(item, cheapestFee) {
  const parts = [];

  if (item.fee === 0) {
    parts.push(`${item.durationText}内预计免费`);
  } else {
    parts.push(`${item.durationText}预计${item.feeText}`);
  }

  parts.push(`步行约${item.walkingMinutes}分钟`);

  if (item.fee > cheapestFee) {
    parts.push("但距离、车位或可信度更均衡");
  }

  if (item.availability === "low") {
    parts.push("车位紧张时建议准备备选");
  }

  return parts.join("，");
}

function isWithinSearchRadius(distanceMeters, radiusMeters) {
  const radius = Number(radiusMeters);
  if (!Number.isFinite(radius) || radius <= 0) {
    return true;
  }

  const distance = Number(distanceMeters);
  return Number.isFinite(distance) && distance <= radius;
}

function recommendParkingLots(options) {
  const lots = Array.isArray(options.lots) ? options.lots : [];
  const durationMinutes = Math.max(1, Number(options.durationMinutes) || 60);
  const destination = options.destination || options.userLocation || null;
  const searchRadiusMeters = Number(options.searchRadiusMeters) || 0;
  const preferences = options.preferences || {};
  const vehicleType = options.vehicleType || "";
  const walkMinuteValue = Number.isFinite(Number(preferences.walkMinuteValue))
    ? Number(preferences.walkMinuteValue)
    : 0.8;

  const priced = lots.map((lot) => {
    const targetLocation = lot.location || {};
    const measuredDistance = calculateDistanceMeters(destination, targetLocation);
    const distanceMeters = measuredDistance == null ? lot.distanceHintMeters : measuredDistance;
    const walkingMinutes = estimateWalkingMinutes(distanceMeters, lot.access && lot.access.walkingPenaltyMinutes);
    const fee = vehicleType
      ? calculateParkingFeeForVehicle(durationMinutes, lot.pricing, vehicleType)
      : calculateParkingFee(durationMinutes, lot.pricing);
    const availability = lot.availability || "unknown";
    const score = fee
      + walkingMinutes * walkMinuteValue
      + (AVAILABILITY_PENALTY[availability] || AVAILABILITY_PENALTY.unknown)
      + confidencePenalty(lot.confidence)
      + freshnessPenalty(lot.updatedAt);

    return {
      ...lot,
      fee,
      feeText: formatMoney(fee),
      durationText: formatDuration(durationMinutes),
      distanceMeters,
      distanceText: formatDistance(distanceMeters),
      walkingMinutes,
      pricingText: vehicleType
        ? describePricingForVehicle(lot.pricing, vehicleType)
        : describePricing(lot.pricing),
      measuredDistance: measuredDistance != null,
      score: Math.round(score * 10) / 10
    };
  }).filter((item) => isWithinSearchRadius(item.distanceMeters, searchRadiusMeters));

  const cheapestFee = priced.reduce((min, item) => Math.min(min, item.fee), Infinity);
  const sorted = priced
    .map((item) => ({
      ...item,
      tags: collectTags(item, item.fee, cheapestFee, item.walkingMinutes)
    }))
    .sort((a, b) => a.score - b.score || a.fee - b.fee || a.walkingMinutes - b.walkingMinutes)
    .map((item, index) => ({
      ...item,
      rank: index + 1,
      isBest: index === 0,
      bestClass: index === 0 ? "is-best" : "",
      reason: buildReason(item, cheapestFee)
    }));

  return sorted;
}

function buildRecommendationSummary(recommendations) {
  if (!recommendations.length) {
    return "目的地 3 公里内还没有匹配的停车场，可以换个目的地、清空搜索词，或先录入停车场。";
  }

  const best = recommendations[0];
  const cheapest = recommendations.reduce((current, item) => (item.fee < current.fee ? item : current), best);

  if (best.id === cheapest.id) {
    return `综合推荐 ${best.name}：${best.reason}。`;
  }

  return `费用最低是 ${cheapest.name}（${cheapest.feeText}），但综合距离、车位和可信度，更推荐 ${best.name}。`;
}

module.exports = {
  AVAILABILITY_LABELS,
  buildRecommendationSummary,
  recommendParkingLots
};
