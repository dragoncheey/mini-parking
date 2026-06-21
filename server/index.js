const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { loadLocalEnv } = require("./env");
const { extractCloudOpenid, extractOpenid, generateToken } = require("./auth");
const { buildMockRecognition } = require("../utils/recognition");
const { recognizeWithSenseNovaApi } = require("./modelClient");
const db = require("./db");

loadLocalEnv();

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization"
  });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message, code, requestId) {
  sendJson(res, statusCode, { error: message, code: code || "ERROR", requestId });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        Object.defineProperty(parsed, "__bodyBytes", {
          value: Buffer.byteLength(body),
          enumerable: false
        });
        resolve(parsed);
      } catch (error) {
        reject(new Error("invalid json body"));
      }
    });
    req.on("error", reject);
  });
}

function parseUrl(req) {
  return new URL(req.url, "http://localhost");
}

function getRequestId(req, body) {
  return req.headers["x-request-id"] || (body && body.requestId) || crypto.randomUUID();
}

function estimateBase64Bytes(base64) {
  const value = String(base64 || "");
  if (!value) return 0;
  const padding = value.endsWith("==") ? 2 : (value.endsWith("=") ? 1 : 0);
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function inferMediaTypeFromPath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return MIME_TYPES[ext] || "image/jpeg";
}

function logServerDebug(event, details) {
  console.info(`[mini-parking server] ${event}`, details || {});
}

function parsePathParams(pattern, actual) {
  const patternParts = pattern.split("/");
  const actualParts = actual.split("/");
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = decodeURIComponent(actualParts[i] || "");
    }
  }
  return params;
}

function matchRoute(pattern, method, reqMethod, pathname) {
  if (reqMethod !== method) return null;
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) return null;
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) continue;
    if (patternParts[i] !== pathParts[i]) return null;
  }
  return parsePathParams(pattern, pathname);
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

// Routes that don't require authentication
const PUBLIC_ROUTES = [
  { method: "POST", prefix: "/api/login" },
  { method: "GET", prefix: "/health" },
  { method: "GET", prefix: "/" },
  { method: "POST", prefix: "/api/recognize-parking" },
  { method: "GET", prefix: "/api/parking-lots" }, // list endpoint (no auth)
];

function isPublicRoute(method, pathname) {
  // Exact match for / and /health
  if ((method === "GET") && (pathname === "/" || pathname === "/health")) return true;
  // Exact match for /api/login
  if (method === "POST" && pathname === "/api/login") return true;
  // Exact match for /api/recognize-parking
  if (method === "POST" && pathname === "/api/recognize-parking") return true;
  // GET /api/parking-lots (list) and GET /api/parking-lots/:id (detail, optional auth)
  if (method === "GET" && pathname === "/api/parking-lots") return true;
  if (method === "GET" && pathname.startsWith("/api/parking-lots/") && !pathname.endsWith("/vote")) return true;
  // GET /uploads/*
  if (method === "GET" && pathname.startsWith("/uploads/")) return true;
  // OPTIONS
  if (method === "OPTIONS") return true;
  return false;
}

// ---------------------------------------------------------------------------
// WeChat login
// ---------------------------------------------------------------------------

function wxCode2Session(code) {
  const appid = process.env.WX_APPID;
  const secret = process.env.WX_APP_SECRET;

  if (!appid || !secret) {
    // Mock mode: use code as openid
    return Promise.resolve({ openid: code });
  }

  return new Promise((resolve, reject) => {
    const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${appid}&secret=${secret}&js_code=${code}&grant_type=authorization_code`;
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.errcode) {
              reject(new Error(parsed.errmsg || "wx login failed"));
            } else {
              resolve({ openid: parsed.openid, session_key: parsed.session_key });
            }
          } catch {
            reject(new Error("invalid wx response"));
          }
        });
      })
      .on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Multipart parser (simple boundary-based for image uploads)
// ---------------------------------------------------------------------------

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(.+)(;|$)/);
    if (!boundaryMatch) {
      return reject(new Error("missing boundary in content-type"));
    }
    const boundary = boundaryMatch[1].trim();
    const delimiter = Buffer.from(`--${boundary}`);
    const endDelimiter = Buffer.from(`--${boundary}--`);

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => {
      try {
        const buf = Buffer.concat(chunks);
        const files = [];
        let pos = 0;

        while (pos < buf.length) {
          const delimIdx = buf.indexOf(delimiter, pos);
          if (delimIdx === -1) break;

          const partStart = delimIdx + delimiter.length + 2; // skip \r\n
          const nextDelimIdx = buf.indexOf(delimiter, partStart);
          if (nextDelimIdx === -1) break;

          const partEnd = nextDelimIdx - 2; // trim \r\n before delimiter
          const part = buf.slice(partStart, partEnd);

          // Parse headers
          const headerEndIdx = part.indexOf("\r\n\r\n");
          if (headerEndIdx === -1) {
            pos = nextDelimIdx;
            continue;
          }

          const headerStr = part.slice(0, headerEndIdx).toString("utf8");
          const bodyBuf = part.slice(headerEndIdx + 4);

          // Extract filename from Content-Disposition
          const nameMatch = headerStr.match(/name="([^"]+)"/);
          const filenameMatch = headerStr.match(/filename="([^"]+)"/);
          if (filenameMatch && nameMatch) {
            const ext = path.extname(filenameMatch[1]) || ".jpg";
            files.push({ name: nameMatch[1], filename: filenameMatch[1], ext, data: bodyBuf });
          }

          pos = nextDelimIdx;
        }

        resolve(files);
      } catch (err) {
        reject(err);
      }
    });
  });
}

function localUploadPathFromUrl(uploadedUrl) {
  const value = String(uploadedUrl || "");
  const pathname = value.startsWith("http")
    ? new URL(value).pathname
    : value;
  if (!pathname.startsWith("/uploads/")) {
    throw new Error("unsupported uploaded image url");
  }
  const safeName = path.basename(pathname.slice("/uploads/".length));
  return path.join(UPLOADS_DIR, safeName);
}

function parseStoragePhotoRef(uploadedUrl) {
  const value = String(uploadedUrl || "");
  if (!value) {
    return { pathname: "" };
  }
  if (!value.startsWith("http")) {
    return { pathname: value };
  }

  const parsed = new URL(value);
  return {
    pathname: parsed.pathname,
    publicUrl: value
  };
}

function storagePathFromUploadedUrl(uploadedUrl, bucketName) {
  const { pathname } = parseStoragePhotoRef(uploadedUrl);
  const bucket = bucketName || db.getStorageBucketName();
  const marker = `/storage/v1/object/public/${bucket}/`;
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex >= 0) {
    return decodeURIComponent(pathname.slice(markerIndex + marker.length));
  }

  if (pathname.startsWith(`${bucket}/`)) {
    return pathname.slice(bucket.length + 1);
  }

  return "";
}

async function readUploadedPhotoRef(photoRef) {
  if (photoRef && photoRef.storagePath) {
    const buffer = await db.downloadEvidencePhoto(photoRef.storageBucket, photoRef.storagePath);
    return {
      base64: buffer.toString("base64"),
      mediaType: photoRef.mediaType || inferMediaTypeFromPath(photoRef.storagePath),
      uploadedUrl: photoRef.uploadedUrl,
      storageBucket: photoRef.storageBucket,
      storagePath: photoRef.storagePath
    };
  }

  const storagePath = storagePathFromUploadedUrl(photoRef && photoRef.uploadedUrl, photoRef && photoRef.storageBucket);
  if (storagePath) {
    const buffer = await db.downloadEvidencePhoto(photoRef && photoRef.storageBucket, storagePath);
    return {
      base64: buffer.toString("base64"),
      mediaType: (photoRef && photoRef.mediaType) || inferMediaTypeFromPath(storagePath),
      uploadedUrl: photoRef && photoRef.uploadedUrl,
      storageBucket: photoRef && photoRef.storageBucket,
      storagePath
    };
  }

  const filePath = localUploadPathFromUrl(photoRef && photoRef.uploadedUrl);
  const buffer = await fs.promises.readFile(filePath);
  return {
    base64: buffer.toString("base64"),
    mediaType: (photoRef && photoRef.mediaType) || inferMediaTypeFromPath(filePath),
    uploadedUrl: photoRef && photoRef.uploadedUrl
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleLogin(req, res) {
  const { code, nickname, avatarUrl } = await readJsonBody(req);
  const cloudOpenid = extractCloudOpenid(req);

  if (!code && !cloudOpenid) {
    return sendError(res, 400, "missing code", "MISSING_CODE");
  }

  const { openid } = cloudOpenid
    ? { openid: cloudOpenid }
    : await wxCode2Session(code);
  let user = await db.findOrCreateUser(openid);
  if (nickname || avatarUrl) {
    user = await db.updateUserProfile(openid, { nickname, avatarUrl });
  }

  const token = generateToken(openid);
  sendJson(res, 200, { token, user });
}

async function handleListParkingLots(req, res) {
  const url = parseUrl(req);
  const latitude = url.searchParams.get("latitude");
  const longitude = url.searchParams.get("longitude");
  const radius = url.searchParams.get("radius") || "3000";

  const opts = {};
  if (latitude != null && longitude != null) {
    opts.latitude = parseFloat(latitude);
    opts.longitude = parseFloat(longitude);
    opts.radiusMeters = parseInt(radius, 10);
  }

  const lots = await db.getAllParkingLots(opts);
  sendJson(res, 200, { data: lots });
}

async function handleGetParkingLot(req, res, params, openid) {
  const lot = await db.getParkingLotById(params.id);
  if (!lot) {
    return sendError(res, 404, "parking lot not found", "NOT_FOUND");
  }

  let userVote = null;
  if (openid) {
    const vote = await db.getUserVote(openid, params.id);
    if (vote) userVote = vote.type;
  }

  sendJson(res, 200, { data: lot, userVote });
}

async function handleCreateParkingLot(req, res, openid) {
  const body = await readJsonBody(req);
  const { name, address, latitude, longitude, entrance_tip, availability,
    walk_extra_minutes, pricing, evidence_photos } = body;

  if (!name || latitude == null || longitude == null) {
    return sendError(res, 400, "name, latitude, longitude are required", "MISSING_FIELDS");
  }

  // Get user profile for owner info
  const user = await db.findOrCreateUser(openid);

  const lotData = {
    id: crypto.randomUUID(),
    name,
    address: address || "",
    latitude,
    longitude,
    entrance_tip: entrance_tip || "",
    availability: availability || "unknown",
    walk_extra_minutes: walk_extra_minutes || 0,
    pricing: pricing || {},
    evidence_photos: evidence_photos || [],
    owner_openid: openid,
    owner_nickname: user.nickname || "",
    owner_avatar: user.avatar_url || "",
    source: "user"
  };

  const lot = await db.createParkingLot(lotData);
  sendJson(res, 201, { data: lot });
}

async function handleUpdateParkingLot(req, res, params, openid) {
  const body = await readJsonBody(req);
  const lot = await db.updateParkingLot(params.id, openid, body);
  if (!lot) {
    return sendError(res, 404, "parking lot not found", "NOT_FOUND");
  }
  sendJson(res, 200, { data: lot });
}

async function handleVote(req, res, params, openid) {
  const { type } = await readJsonBody(req);
  if (!type || (type !== "up" && type !== "down")) {
    return sendError(res, 400, "type must be 'up' or 'down'", "INVALID_VOTE_TYPE");
  }
  const result = await db.voteParkingLot(openid, params.id, type);
  sendJson(res, 200, { data: result });
}

async function handleListVehicles(req, res, openid) {
  const vehicles = await db.getUserVehicles(openid);
  sendJson(res, 200, { data: vehicles });
}

async function handleAddVehicle(req, res, openid) {
  const { plate, type } = await readJsonBody(req);
  if (!plate) {
    return sendError(res, 400, "plate is required", "MISSING_PLATE");
  }
  const vehicle = await db.addVehicle(openid, plate, type || "fuel");
  sendJson(res, 201, { data: vehicle });
}

async function handleUpdateVehicle(req, res, params, openid) {
  const { plate, type } = await readJsonBody(req);
  if (!plate) {
    return sendError(res, 400, "plate is required", "MISSING_PLATE");
  }
  const vehicle = await db.updateVehicle(openid, params.id, plate, type || "fuel");
  if (!vehicle) {
    return sendError(res, 404, "vehicle not found", "NOT_FOUND");
  }
  sendJson(res, 200, { data: vehicle });
}

async function handleDeleteVehicle(req, res, params, openid) {
  const deleted = await db.deleteVehicle(openid, params.id);
  if (!deleted) {
    return sendError(res, 404, "vehicle not found", "NOT_FOUND");
  }
  sendJson(res, 200, { success: true });
}

async function handleUpload(req, res) {
  const startedAt = Date.now();
  const contentType = req.headers["content-type"] || "";

  if (contentType.indexOf("application/json") >= 0) {
    const body = await readJsonBody(req);
    const requestId = getRequestId(req, body);
    const { filename, mediaType, base64 } = body;
    logServerDebug("upload:start", {
      requestId,
      mode: "json",
      bodyBytes: body.__bodyBytes || 0,
      filename,
      mediaType,
      base64Chars: base64 ? base64.length : 0,
      estimatedBytes: estimateBase64Bytes(base64)
    });
    if (!base64) {
      return sendError(res, 400, "missing base64 image", "NO_FILE", requestId);
    }

    const buffer = Buffer.from(base64, "base64");
    if (!buffer.length) {
      return sendError(res, 400, "invalid base64 image", "INVALID_FILE", requestId);
    }

    const upload = await db.uploadEvidencePhoto({
      buffer,
      filename,
      mediaType
    });
    logServerDebug("upload:success", {
      requestId,
      mode: "json",
      durationMs: Date.now() - startedAt,
      storageBucket: upload.storageBucket,
      storagePath: upload.storagePath,
      uploadedUrl: upload.uploadedUrl || upload.url
    });
    sendJson(res, 201, upload);
    return;
  }

  const requestId = getRequestId(req);
  logServerDebug("upload:start", {
    requestId,
    mode: "multipart",
    contentType
  });
  const files = await parseMultipart(req);
  if (!files.length) {
    return sendError(res, 400, "no file uploaded", "NO_FILE", requestId);
  }

  const file = files[0];
  const upload = await db.uploadEvidencePhoto({
    buffer: file.data,
    filename: file.filename,
    mediaType: inferMediaTypeFromPath(file.filename)
  });

  logServerDebug("upload:success", {
    requestId,
    mode: "multipart",
    durationMs: Date.now() - startedAt,
    filename: file.filename,
    bytes: file.data.length,
    storageBucket: upload.storageBucket,
    storagePath: upload.storagePath,
    uploadedUrl: upload.uploadedUrl || upload.url
  });
  sendJson(res, 201, upload);
}

async function handleRecognize(req, res) {
  const startedAt = Date.now();
  const payload = await readJsonBody(req);
  const requestId = getRequestId(req, payload);
  const directPhotos = Array.isArray(payload.photos) ? payload.photos : [];
  const photoRefs = Array.isArray(payload.photoRefs) ? payload.photoRefs : [];
  const useMock = process.env.MODEL_API_MOCK === "1"
    || (!process.env.SENSENOVA_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN);

  logServerDebug("recognize:start", {
    requestId,
    bodyBytes: payload.__bodyBytes || 0,
    photoCount: directPhotos.length,
    photoRefCount: photoRefs.length,
    photos: directPhotos.map((photo, index) => ({
      index,
      mediaType: photo && photo.mediaType,
      base64Chars: photo && photo.base64 ? photo.base64.length : 0,
      estimatedBytes: estimateBase64Bytes(photo && photo.base64)
    })),
    photoRefs: photoRefs.map((photo, index) => ({
      index,
      uploadedUrl: photo && photo.uploadedUrl,
      mediaType: photo && photo.mediaType
    })),
    mode: useMock ? "mock" : "model",
    model: useMock ? "mock" : (process.env.SENSENOVA_MODEL || process.env.ANTHROPIC_MODEL || process.env.MODEL_API_MODEL || "sensenova-6.7-flash-lite")
  });

  let recognition;
  try {
    let photos = directPhotos;
    if (photoRefs.length) {
      photos = await Promise.all(photoRefs.slice(0, 3).map(readUploadedPhotoRef));
      logServerDebug("recognize:photo-refs-loaded", {
        requestId,
        photoCount: photos.length,
        photos: photos.map((photo, index) => ({
          index,
          mediaType: photo.mediaType,
          base64Chars: photo.base64 ? photo.base64.length : 0,
          estimatedBytes: estimateBase64Bytes(photo.base64),
          uploadedUrl: photo.uploadedUrl
        }))
      });
    }
    const recognitionPayload = {
      ...payload,
      photos
    };
    recognition = useMock
      ? buildMockRecognition(recognitionPayload)
      : await recognizeWithSenseNovaApi(recognitionPayload, process.env, { requestId });
  } catch (error) {
    console.error("[mini-parking server] recognize:error", {
      requestId,
      message: error.message,
      code: error.code,
      durationMs: Date.now() - startedAt
    });
    return sendError(res, 500, error.message || "recognition failed", "RECOGNITION_FAILED", requestId);
  }

  logServerDebug("recognize:success", {
    requestId,
    mode: useMock ? "mock" : "model",
    durationMs: Date.now() - startedAt,
    confidence: recognition && recognition.confidence
  });

  sendJson(res, 200, {
    ok: true,
    requestId,
    mode: useMock ? "mock" : "model",
    recognition
  });
}

// ---------------------------------------------------------------------------
// Static file serving for uploads
// ---------------------------------------------------------------------------

const MIME_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp"
};

function serveStaticFile(res, filepath) {
  const ext = path.extname(filepath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  fs.readFile(filepath, (err, data) => {
    if (err) {
      sendError(res, 404, "file not found", "NOT_FOUND");
    } else {
      res.writeHead(200, {
        "content-type": contentType,
        "cache-control": "public, max-age=86400",
        "access-control-allow-origin": "*"
      });
      res.end(data);
    }
  });
}

// ---------------------------------------------------------------------------
// Main request handler
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  let pathname = "";
  let method = req.method;
  let requestId = req.headers["x-request-id"] || "";
  try {
    pathname = parseUrl(req).pathname;

    // CORS preflight
    if (method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }

    // Health check
    if (method === "GET" && (pathname === "/" || pathname === "/health")) {
      sendJson(res, 200, {
        ok: true,
        service: "mini-parking-api",
        routes: ["/health", "/api/recognize-parking", "/api/login",
          "/api/parking-lots", "/api/parking-lots/:id",
          "/api/parking-lots/:id/vote", "/api/vehicles",
          "/api/vehicles/:id", "/api/upload"]
      });
      return;
    }

    // Static uploads
    if (method === "GET" && pathname.startsWith("/uploads/")) {
      const filename = pathname.slice("/uploads/".length);
      // Prevent path traversal
      const safeName = path.basename(filename);
      serveStaticFile(res, path.join(UPLOADS_DIR, safeName));
      return;
    }

    // POST /api/recognize-parking (no auth)
    if (method === "POST" && pathname === "/api/recognize-parking") {
      await handleRecognize(req, res);
      return;
    }

    // POST /api/login (no auth)
    if (method === "POST" && pathname === "/api/login") {
      await handleLogin(req, res);
      return;
    }

    // GET /api/parking-lots (no auth)
    if (method === "GET" && pathname === "/api/parking-lots") {
      await handleListParkingLots(req, res);
      return;
    }

    // --- Routes below require authentication ---
    let openid = null;
    if (!isPublicRoute(method, pathname)) {
      openid = extractOpenid(req);
      if (!openid) {
        return sendError(res, 401, "unauthorized: missing or invalid token", "UNAUTHORIZED");
      }
    }

    // GET /api/parking-lots/:id (optional auth)
    let params;
    params = matchRoute("/api/parking-lots/:id", "GET", method, pathname);
    if (params) {
      // Optional auth - extract openid if token present but don't require it
      const optionalOpenid = extractOpenid(req);
      await handleGetParkingLot(req, res, params, optionalOpenid);
      return;
    }

    // POST /api/parking-lots (auth required)
    if (method === "POST" && pathname === "/api/parking-lots") {
      await handleCreateParkingLot(req, res, openid);
      return;
    }

    // PUT /api/parking-lots/:id (auth required)
    params = matchRoute("/api/parking-lots/:id", "PUT", method, pathname);
    if (params) {
      await handleUpdateParkingLot(req, res, params, openid);
      return;
    }

    // POST /api/parking-lots/:id/vote (auth required)
    params = matchRoute("/api/parking-lots/:id/vote", "POST", method, pathname);
    if (params) {
      await handleVote(req, res, params, openid);
      return;
    }

    // GET /api/vehicles (auth required)
    if (method === "GET" && pathname === "/api/vehicles") {
      await handleListVehicles(req, res, openid);
      return;
    }

    // POST /api/vehicles (auth required)
    if (method === "POST" && pathname === "/api/vehicles") {
      await handleAddVehicle(req, res, openid);
      return;
    }

    // PUT /api/vehicles/:id (auth required)
    params = matchRoute("/api/vehicles/:id", "PUT", method, pathname);
    if (params) {
      await handleUpdateVehicle(req, res, params, openid);
      return;
    }

    // DELETE /api/vehicles/:id (auth required)
    params = matchRoute("/api/vehicles/:id", "DELETE", method, pathname);
    if (params) {
      await handleDeleteVehicle(req, res, params, openid);
      return;
    }

    // POST /api/upload (auth required)
    if (method === "POST" && pathname === "/api/upload") {
      await handleUpload(req, res);
      return;
    }

    // 404
    sendError(res, 404, "not found", "NOT_FOUND");
  } catch (err) {
    console.error("[mini-parking server] request:error", {
      requestId,
      method,
      pathname,
      message: err.message,
      stack: err.stack
    });

    if (err.message === "request body too large") {
      return sendError(res, 413, err.message, "BODY_TOO_LARGE", requestId);
    }
    if (err.message === "invalid json body") {
      return sendError(res, 400, err.message, "INVALID_JSON", requestId);
    }
    if (err.message.includes("not authorized")) {
      return sendError(res, 403, err.message, "FORBIDDEN", requestId);
    }
    if (err.message.includes("PLATE_DUPLICATED")) {
      return sendError(res, 409, "PLATE_DUPLICATED", "PLATE_DUPLICATED", requestId);
    }
    if (err.message.includes("Could not find the table")
      || err.message.includes("schema cache")) {
      return sendError(
        res,
        503,
        "database schema is missing; run server/migration.sql in Supabase SQL Editor",
        "DB_SCHEMA_MISSING",
        requestId
      );
    }

    sendError(res, 500, err.message || "internal server error", "INTERNAL_ERROR", requestId);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`parking api listening on http://${HOST}:${PORT}`);
});
