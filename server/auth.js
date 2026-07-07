const crypto = require("crypto");

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function getAuthTokenSecret(options) {
  const env = (options && options.env) || process.env;
  const secret = env.AUTH_TOKEN_SECRET || "";
  if (!secret && env.NODE_ENV === "production") {
    throw new Error("AUTH_TOKEN_SECRET is required in production");
  }
  return secret || "mini-parking-dev-auth-secret";
}

function getTokenTtlSeconds(options) {
  const env = (options && options.env) || process.env;
  const explicit = options && options.ttlSeconds;
  const raw = explicit != null ? explicit : env.AUTH_TOKEN_TTL_SECONDS;
  const ttl = Number(raw || DEFAULT_TTL_SECONDS);
  return Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : DEFAULT_TTL_SECONDS;
}

function signPayload(encodedPayload, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""), "base64url");
  const right = Buffer.from(String(b || ""), "base64url");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function generateToken(openid, options) {
  if (!openid) {
    throw new Error("openid is required");
  }
  const nowMs = (options && options.nowMs) || Date.now();
  const issuedAt = Math.floor(nowMs / 1000);
  const ttlSeconds = getTokenTtlSeconds(options);
  const payload = {
    openid,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = signPayload(encodedPayload, getAuthTokenSecret(options));
  return `${encodedPayload}.${signature}`;
}

function decodeToken(token, options) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const [encodedPayload, signature] = parts;
    const expected = signPayload(encodedPayload, getAuthTokenSecret(options));
    if (!safeEqual(signature, expected)) return null;

    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (!payload || !payload.openid || !payload.exp) return null;

    const nowMs = (options && options.nowMs) || Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);
    if (Number(payload.exp) <= nowSeconds) return null;

    return payload;
  } catch {
    return null;
  }
}

function extractOpenid(req, options) {
  const auth = (req.headers && req.headers.authorization) || "";
  if (!auth.startsWith("Bearer ")) return null;
  const payload = decodeToken(auth.slice(7), options);
  return payload ? payload.openid : null;
}

module.exports = {
  decodeToken,
  extractOpenid,
  generateToken,
  getAuthTokenSecret
};
