function generateToken(openid) {
  const payload = JSON.stringify({ openid, ts: Date.now() });
  return Buffer.from(payload).toString("base64");
}

function decodeToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
    return payload.openid || null;
  } catch {
    return null;
  }
}

function firstHeaderValue(headers, names) {
  for (const name of names) {
    const value = headers[name];
    if (Array.isArray(value) && value.length) {
      return value[0];
    }
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function extractOpenid(req) {
  const auth = req.headers["authorization"] || "";
  if (!auth.startsWith("Bearer ")) return null;
  return decodeToken(auth.slice(7));
}

function extractCloudOpenid(req) {
  return firstHeaderValue(req.headers || {}, [
    "x-wx-openid",
    "x-wx-from-openid",
    "x-wx-cloudbase-openid",
    "x-wx-open-id"
  ]) || null;
}

module.exports = {
  decodeToken,
  extractCloudOpenid,
  extractOpenid,
  generateToken
};
