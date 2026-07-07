const { apiConfig } = require("../config/api");

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

function getToken() {
  try {
    return wx.getStorageSync("auth_token") || "";
  } catch (e) {
    return "";
  }
}

function setToken(token) {
  try {
    wx.setStorageSync("auth_token", token);
  } catch (e) {
    // ignore
  }
}

function clearToken() {
  try {
    wx.removeStorageSync("auth_token");
  } catch (e) {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function buildApiError(response, fallback) {
  const data = response && response.data ? response.data : {};
  const error = new Error(data.error || fallback || "接口返回异常");
  error.statusCode = response && response.statusCode;
  error.code = data.code || "";
  error.requestId = data.requestId || "";
  return error;
}

function validateOkResponse(response) {
  if (response.statusCode >= 200 && response.statusCode < 300 && response.data && response.data.ok) {
    return response.data;
  }

  throw buildApiError(response);
}

function createRequestId(prefix) {
  return `${prefix || "req"}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function estimateBase64Bytes(base64) {
  const value = String(base64 || "");
  if (!value) return 0;
  const padding = value.endsWith("==") ? 2 : (value.endsWith("=") ? 1 : 0);
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function summarizeRequestData(path, data) {
  if (path === "/api/recognize-parking") {
    const photos = Array.isArray(data && data.photos) ? data.photos : [];
    const photoRefs = Array.isArray(data && data.photoRefs) ? data.photoRefs : [];
    return {
      photoCount: photos.length,
      photoRefCount: photoRefs.length,
      photos: photos.map((photo, index) => ({
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
      textHintLength: data && data.textHint ? String(data.textHint).length : 0
    };
  }
  if (path === "/api/upload") {
    return {
      filename: data && data.filename,
      mediaType: data && data.mediaType,
      base64Chars: data && data.base64 ? data.base64.length : 0,
      estimatedBytes: estimateBase64Bytes(data && data.base64)
    };
  }
  return null;
}

function logApiDebug(message, details) {
  console.info(`[mini-parking api] ${message}`, details || {});
}

function buildAuthHeaders(extraHeaders) {
  const token = getToken();
  const header = {
    "content-type": "application/json",
    ...(extraHeaders || {})
  };

  if (token) {
    header.Authorization = "Bearer " + token;
  }

  return header;
}

function requestWithWxRequest(options) {
  const requestId = options.requestId || createRequestId("wxreq");
  const startedAt = Date.now();
  const header = {
    "content-type": "application/json",
    "X-Request-Id": requestId,
    ...(options.header || {})
  };
  logApiDebug("wx.request:start", {
    requestId,
    url: options.url,
    method: options.method || "POST",
    timeout: options.timeout,
    summary: summarizeRequestData(options.path, options.data)
  });
  return new Promise((resolve, reject) => {
    wx.request({
      url: options.url,
      method: options.method || "POST",
      timeout: options.timeout,
      data: options.data,
      header,
      success: (res) => {
        try {
          const data = validateOkResponse(res);
          logApiDebug("wx.request:success", {
            requestId,
            statusCode: res.statusCode,
            durationMs: Date.now() - startedAt
          });
          resolve(data);
        } catch (error) {
          error.requestId = error.requestId || requestId;
          console.error("[mini-parking api] wx.request:bad-response", {
            requestId,
            statusCode: res.statusCode,
            code: error.code,
            message: error.message,
            durationMs: Date.now() - startedAt
          });
          reject(error);
        }
      },
      fail: (error) => {
        error.requestId = error.requestId || requestId;
        console.error("[mini-parking api] wx.request:fail", {
          requestId,
          errMsg: error.errMsg,
          message: error.message,
          durationMs: Date.now() - startedAt
        });
        reject(error);
      }
    });
  });
}

function requestApi(options) {
  return requestWithWxRequest(options);
}

function requestParkingRecognition(payload, options) {
  const opts = options || {};
  const requestId = opts.requestId || createRequestId("recognition");
  return request("POST", "/api/recognize-parking", {
    ...(payload || {}),
    requestId
  }, {
    requestId,
    timeout: apiConfig.recognitionTimeoutMs || apiConfig.requestTimeoutMs
  });
}

// ---------------------------------------------------------------------------
// Backend REST API request wrapper
// ---------------------------------------------------------------------------

function request(method, path, data, options) {
  const opts = options || {};
  const requestId = opts.requestId || createRequestId(path === "/api/upload" ? "upload" : "api");
  const startedAt = Date.now();
  const header = buildAuthHeaders({
    "X-Request-Id": requestId,
    ...(opts.header || {})
  });
  const baseUrl = apiConfig.baseUrl || "http://127.0.0.1:8787";
  const url = baseUrl + path;
  logApiDebug("wx.request:api-start", {
    requestId,
    url,
    method,
    timeout: opts.timeout || apiConfig.requestTimeoutMs,
    summary: summarizeRequestData(path, data)
  });

  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method,
      data,
      header,
      timeout: opts.timeout || apiConfig.requestTimeoutMs,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          logApiDebug("wx.request:api-success", {
            requestId,
            path,
            statusCode: res.statusCode,
            durationMs: Date.now() - startedAt
          });
          resolve(res.data);
        } else {
          const error = buildApiError(res, "请求失败");
          error.requestId = error.requestId || requestId;
          console.error("[mini-parking api] wx.request:api-bad-response", {
            requestId,
            path,
            statusCode: res.statusCode,
            code: error.code,
            message: error.message,
            durationMs: Date.now() - startedAt
          });
          reject(error);
        }
      },
      fail(err) {
        const error = new Error(err.errMsg || "网络请求失败");
        error.requestId = requestId;
        console.error("[mini-parking api] wx.request:api-fail", {
          requestId,
          path,
          errMsg: err.errMsg,
          durationMs: Date.now() - startedAt
        });
        reject(error);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function login(code, userInfo) {
  const payload = {
    code,
    nickname: (userInfo && userInfo.nickname) || "",
    avatarUrl: (userInfo && userInfo.avatarUrl) || ""
  };
  const res = await request("POST", "/api/login", payload);
  if (res.token) {
    setToken(res.token);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Parking lots
// ---------------------------------------------------------------------------

async function getParkingLots(latitude, longitude, radius) {
  const params = [];
  if (latitude != null) params.push("latitude=" + encodeURIComponent(latitude));
  if (longitude != null) params.push("longitude=" + encodeURIComponent(longitude));
  if (radius != null) params.push("radius=" + encodeURIComponent(radius));
  const path = "/api/parking-lots" + (params.length ? "?" + params.join("&") : "");
  const res = await request("GET", path);
  return res.data || [];
}

async function getParkingLotDetail(id) {
  const path = "/api/parking-lots/" + encodeURIComponent(id);
  const res = await request("GET", path);
  return {
    lot: res.data || null,
    userVote: res.userVote || null
  };
}

async function createParkingLot(lotData) {
  const res = await request("POST", "/api/parking-lots", lotData);
  return res.data || null;
}

async function updateParkingLot(id, lotData) {
  const path = "/api/parking-lots/" + encodeURIComponent(id);
  const res = await request("PUT", path, lotData);
  return res.data || null;
}

async function voteParkingLot(lotId, type) {
  const path = "/api/parking-lots/" + encodeURIComponent(lotId) + "/vote";
  const res = await request("POST", path, { type });
  return res.data || {};
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

async function getVehicles() {
  const res = await request("GET", "/api/vehicles");
  return res.data || [];
}

async function addVehicle(plate, type) {
  const res = await request("POST", "/api/vehicles", { plate, type });
  return res.data || null;
}

async function updateVehicle(id, plate, type) {
  const path = "/api/vehicles/" + encodeURIComponent(id);
  const res = await request("PUT", path, { plate, type });
  return res.data || null;
}

async function deleteVehicle(id) {
  const res = await request("DELETE", "/api/vehicles/" + encodeURIComponent(id));
  return res.success === true;
}

// ---------------------------------------------------------------------------
// Image upload
// ---------------------------------------------------------------------------

function getFilename(filePath) {
  const value = String(filePath || "");
  const parts = value.split("/");
  return parts[parts.length - 1] || `upload-${Date.now()}.jpg`;
}

function inferMediaType(filePath) {
  const value = String(filePath || "").toLowerCase();
  if (value.indexOf(".png") >= 0) return "image/png";
  if (value.indexOf(".webp") >= 0) return "image/webp";
  if (value.indexOf(".gif") >= 0) return "image/gif";
  return "image/jpeg";
}

async function uploadImage(filePath, options) {
  const opts = options || {};
  const requestId = opts.requestId || createRequestId("upload");
  const path = "/api/upload";
  const baseUrl = apiConfig.baseUrl || "http://127.0.0.1:8787";
  const url = baseUrl + path;
  const token = getToken();
  const header = {
    "X-Request-Id": requestId
  };
  if (token) {
    header.Authorization = "Bearer " + token;
  }
  logApiDebug("upload:file-start", {
    requestId,
    url,
    filename: getFilename(filePath),
    mediaType: inferMediaType(filePath)
  });

  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url,
      filePath,
      name: "file",
      header,
      timeout: opts.timeout || apiConfig.requestTimeoutMs,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const data = JSON.parse(res.data);
            logApiDebug("upload:file-success", {
              requestId,
              statusCode: res.statusCode,
              uploadedUrl: data && (data.uploadedUrl || data.url),
              storageBucket: data && data.storageBucket,
              storagePath: data && data.storagePath
            });
            resolve(data);
          } catch (e) {
            const error = new Error("上传响应解析失败");
            error.requestId = requestId;
            reject(error);
          }
        } else {
          let data = {};
          try {
            data = JSON.parse(res.data || "{}");
          } catch (e) {
            data = {};
          }
          const error = new Error(data.error || "图片上传失败");
          error.statusCode = res.statusCode;
          error.code = data.code || "";
          error.requestId = data.requestId || requestId;
          console.error("[mini-parking api] upload:file-bad-response", {
            requestId,
            statusCode: res.statusCode,
            code: error.code,
            message: error.message
          });
          reject(error);
        }
      },
      fail(err) {
        const error = new Error(err.errMsg || "图片上传失败");
        error.requestId = requestId;
        console.error("[mini-parking api] upload:file-fail", {
          requestId,
          errMsg: err.errMsg
        });
        reject(error);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  requestApi,
  requestParkingRecognition,
  getToken,
  setToken,
  clearToken,
  request,
  login,
  getParkingLots,
  getParkingLotDetail,
  createParkingLot,
  updateParkingLot,
  voteParkingLot,
  getVehicles,
  addVehicle,
  updateVehicle,
  deleteVehicle,
  uploadImage
};
