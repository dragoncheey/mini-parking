function normalizeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function applyMaxDailyCap(baseFee, durationMinutes, rule) {
  const maxDailyPrice = normalizeNumber(rule.maxDailyPrice, 0);
  if (maxDailyPrice <= 0) {
    return baseFee;
  }

  const capPeriodMinutes = rule.chargeType === "flat"
    ? Math.max(1, normalizeNumber(rule.flatDurationMinutes || rule.packageMinutes, 1440))
    : 1440;
  const capPeriods = Math.max(1, Math.ceil(Math.max(1, durationMinutes) / capPeriodMinutes));
  return Math.min(baseFee, maxDailyPrice * capPeriods);
}

function calculateSimpleFee(durationMinutes, pricing) {
  const freeMinutes = normalizeNumber(pricing.freeMinutes, 0);
  const billingUnitMinutes = Math.max(1, normalizeNumber(pricing.billingUnitMinutes, 60));
  const unitPrice = Math.max(0, normalizeNumber(pricing.unitPrice, 0));
  const billableMinutes = Math.max(0, durationMinutes - freeMinutes);

  if (billableMinutes <= 0) {
    return 0;
  }

  const units = Math.ceil(billableMinutes / billingUnitMinutes);
  const rawFee = units * unitPrice;
  return Math.max(rawFee, normalizeNumber(pricing.minCharge, 0));
}

function calculateFlatFee(durationMinutes, pricing) {
  const freeMinutes = normalizeNumber(pricing.freeMinutes, 0);
  const flatDurationMinutes = Math.max(1, normalizeNumber(
    pricing.flatDurationMinutes || pricing.packageMinutes,
    1440
  ));
  const flatPrice = Math.max(0, normalizeNumber(
    pricing.flatPrice != null ? pricing.flatPrice : pricing.packagePrice,
    0
  ));
  const billableMinutes = Math.max(0, durationMinutes - freeMinutes);
  const repeats = pricing.flatRepeat === false ? 1 : Math.max(1, Math.ceil(billableMinutes / flatDurationMinutes));

  if (billableMinutes <= 0) {
    return 0;
  }

  return Math.max(repeats * flatPrice, normalizeNumber(pricing.minCharge, 0));
}

function calculateLadderFee(durationMinutes, pricing) {
  const freeMinutes = normalizeNumber(pricing.freeMinutes, 0);
  let remainingMinutes = Math.max(0, durationMinutes - freeMinutes);
  let fee = 0;
  let elapsedAfterFree = 0;

  if (remainingMinutes <= 0) {
    return 0;
  }

  const ladder = Array.isArray(pricing.ladder) ? pricing.ladder : [];
  for (let index = 0; index < ladder.length && remainingMinutes > 0; index += 1) {
    const step = ladder[index];
    const stepEnd = step.untilMinutes == null ? Infinity : normalizeNumber(step.untilMinutes, Infinity);
    const stepCapacity = Math.max(0, stepEnd - elapsedAfterFree);
    const minutesInStep = Math.min(remainingMinutes, stepCapacity);
    const billingUnitMinutes = Math.max(1, normalizeNumber(step.billingUnitMinutes, 60));
    const unitPrice = Math.max(0, normalizeNumber(step.unitPrice, 0));

    if (minutesInStep > 0) {
      fee += Math.ceil(minutesInStep / billingUnitMinutes) * unitPrice;
      remainingMinutes -= minutesInStep;
      elapsedAfterFree += minutesInStep;
    }
  }

  if (remainingMinutes > 0) {
    const fallbackStep = ladder[ladder.length - 1] || {};
    const billingUnitMinutes = Math.max(1, normalizeNumber(fallbackStep.billingUnitMinutes, 60));
    const unitPrice = Math.max(0, normalizeNumber(fallbackStep.unitPrice, 0));
    fee += Math.ceil(remainingMinutes / billingUnitMinutes) * unitPrice;
  }

  return Math.max(fee, normalizeNumber(pricing.minCharge, 0));
}

function calculateParkingFee(durationMinutes, pricing) {
  const safeDuration = Math.max(0, normalizeNumber(durationMinutes, 0));
  const rule = resolvePricingForVehicle(pricing, null);
  let baseFee;

  if (rule.chargeType === "flat") {
    baseFee = calculateFlatFee(safeDuration, rule);
  } else if (Array.isArray(rule.ladder) && rule.ladder.length > 0) {
    baseFee = calculateLadderFee(safeDuration, rule);
  } else {
    baseFee = calculateSimpleFee(safeDuration, rule);
  }

  const cappedFee = applyMaxDailyCap(baseFee, safeDuration, rule);

  return roundMoney(cappedFee);
}

function mergePricingRule(baseRule, overrideRule) {
  const base = baseRule || {};
  const override = overrideRule || {};
  return {
    ...base,
    ...override,
    ladder: override.ladder || base.ladder,
    pricingByVehicle: base.pricingByVehicle,
    flatRepeat: override.flatRepeat == null ? base.flatRepeat : override.flatRepeat
  };
}

function resolvePricingForVehicle(pricing, vehicleType) {
  const rule = pricing || {};
  const pricingByVehicle = rule.pricingByVehicle || {};
  const vehicleRule = vehicleType ? pricingByVehicle[vehicleType] : null;

  if (!vehicleRule) {
    return rule;
  }

  return mergePricingRule(rule, vehicleRule);
}

function calculateParkingFeeForVehicle(durationMinutes, pricing, vehicleType) {
  return calculateParkingFee(durationMinutes, resolvePricingForVehicle(pricing, vehicleType));
}

function formatMoney(value) {
  const fee = roundMoney(normalizeNumber(value, 0));
  if (fee === 0) {
    return "免费";
  }

  if (Number.isInteger(fee)) {
    return `${fee} 元`;
  }

  return `${fee.toFixed(2)} 元`;
}

function formatDuration(minutes) {
  const safeMinutes = Math.max(0, normalizeNumber(minutes, 0));
  const days = Math.floor(safeMinutes / 1440);
  const restAfterDays = safeMinutes % 1440;
  const hours = Math.floor(restAfterDays / 60);
  const restMinutes = restAfterDays % 60;
  const parts = [];

  if (days > 0) {
    parts.push(`${days}天`);
  }

  if (hours > 0) {
    parts.push(`${hours}小时`);
  }

  if (restMinutes > 0 || parts.length === 0) {
    parts.push(`${restMinutes}分钟`);
  }

  return parts.join("");
}

function describePricing(pricing) {
  const rule = resolvePricingForVehicle(pricing, null);
  return describePricingRule(rule);
}

function describePricingRule(rule) {
  if (rule.notes) {
    return rule.notes;
  }

  if (rule.chargeType === "flat") {
    const freeMinutes = normalizeNumber(rule.freeMinutes, 0);
    const flatDurationMinutes = normalizeNumber(rule.flatDurationMinutes || rule.packageMinutes, 1440);
    const flatPrice = normalizeNumber(rule.flatPrice != null ? rule.flatPrice : rule.packagePrice, 0);
    const freeText = freeMinutes > 0 ? `${formatDuration(freeMinutes)}免费，` : "";
    const repeatText = rule.flatRepeat === false ? "按次" : `每${formatDuration(flatDurationMinutes)}`;
    return `${freeText}${repeatText}${flatPrice}元`;
  }

  if (Array.isArray(rule.ladder) && rule.ladder.length > 0) {
    return "阶梯计费规则";
  }

  const freeMinutes = normalizeNumber(rule.freeMinutes, 0);
  const unitMinutes = normalizeNumber(rule.billingUnitMinutes, 60);
  const unitPrice = normalizeNumber(rule.unitPrice, 0);
  const freeText = freeMinutes > 0 ? `${formatDuration(freeMinutes)}免费，` : "";
  return `${freeText}之后每${formatDuration(unitMinutes)}${unitPrice}元`;
}

function describePricingForVehicle(pricing, vehicleType) {
  return describePricingRule(resolvePricingForVehicle(pricing, vehicleType));
}

module.exports = {
  calculateParkingFee,
  calculateParkingFeeForVehicle,
  describePricing,
  describePricingForVehicle,
  formatDuration,
  formatMoney,
  resolvePricingForVehicle
};
