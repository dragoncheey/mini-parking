const { normalizeRecognition, parseJsonFromText } = require("../utils/recognition");

const DEFAULT_MODEL = "sensenova-6.7-flash-lite";

function buildUserPrompt(payload) {
  const form = payload.form || {};
  const photos = Array.isArray(payload.photos) ? payload.photos : [];
  return [
    "请从停车场收费牌/入口照片和补充信息中识别停车场数据。",
    "只返回 JSON，不要解释。",
    "JSON 字段：name, address, entrance, location{latitude,longitude,amapPoiId}, pricing{freeMinutes,billingUnitMinutes,unitPrice,maxDailyPrice,notes}, availability, walkingPenaltyMinutes, confidence, evidenceSummary, warnings。",
    "availability 只能是 high, medium, low, unknown。",
    "如果照片内容无法直接读取，请根据当前表单和补充文字生成低可信度草稿，并在 warnings 中提示人工复核。",
    `照片数量：${photos.length}`,
    `当前表单：${JSON.stringify(form)}`,
    `补充文字：${payload.textHint || ""}`
  ].join("\n");
}

function buildUserContent(payload) {
  const content = [{
    type: "text",
    text: buildUserPrompt(payload)
  }];
  const photos = Array.isArray(payload.photos) ? payload.photos : [];

  photos.slice(0, 3).forEach((photo) => {
    if (!photo || !photo.base64) {
      return;
    }

    const mediaType = photo.mediaType || "image/jpeg";
    content.push({
      type: "image_url",
      image_url: {
        url: `data:${mediaType};base64,${photo.base64}`
      }
    });
  });

  return content;
}

function extractTextFromChatCompletion(data) {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const message = choices[0] && choices[0].message ? choices[0].message : {};
  return String(message.content || "").trim();
}

async function recognizeWithSenseNovaApi(payload, env) {
  const baseUrl = (env.SENSENOVA_BASE_URL || env.ANTHROPIC_BASE_URL || "https://token.sensenova.cn").replace(/\/$/, "");
  const apiBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
  const token = env.SENSENOVA_API_KEY || env.ANTHROPIC_AUTH_TOKEN || "";
  const model = env.SENSENOVA_MODEL || env.ANTHROPIC_MODEL || env.MODEL_API_MODEL || DEFAULT_MODEL;

  if (!baseUrl || !token) {
    throw new Error("SENSENOVA_BASE_URL and SENSENOVA_API_KEY are required");
  }

  const response = await fetch(`${apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${token}`
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      stream: false,
      max_tokens: 1200,
      reasoning_effort: "none",
      response_format: {
        type: "json_object"
      },
      messages: [
        {
          role: "system",
          content: "你是停车场数据结构化助手，必须输出合法 JSON。"
        },
        {
          role: "user",
          content: buildUserContent(payload)
        }
      ]
    })
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`model api ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = JSON.parse(body);
  const text = extractTextFromChatCompletion(data);
  if (!text) {
    throw new Error("model api returned no text content");
  }

  return normalizeRecognition(parseJsonFromText(text));
}

module.exports = {
  recognizeWithSenseNovaApi
};
