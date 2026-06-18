const { apiConfig, cloudbaseConfig } = require("../config/api");

let cloudClientPromise = null;

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
// Existing helpers (preserved for recognition API)
// ---------------------------------------------------------------------------

function buildApiError(response, fallback) {
  const data = response && response.data ? response.data : {};
  const error = new Error(data.error || fallback || "接口返回异常");
  error.statusCode = response && response.statusCode;
  error.code = data.code || "";
  return error;
}

function validateOkResponse(response) {
  if (response.statusCode >= 200 && response.statusCode < 300 && response.data && response.data.ok) {
    return response.data;
  }

  throw buildApiError(response);
}

function buildCloudHeaders(extraHeaders) {
  return {
    "X-WX-SERVICE": cloudbaseConfig.serviceName,
    ...(extraHeaders || {})
  };
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
  return new Promise((resolve, reject) => {
    wx.request({
      url: options.url,
      method: options.method || "POST",
      timeout: options.timeout,
      data: options.data,
      header: {
        "content-type": "application/json"
      },
      success: (res) => {
        try {
          resolve(validateOkResponse(res));
        } catch (error) {
          reject(error);
        }
      },
      fail: reject
    });
  });
}

function getCloudClient() {
  if (!cloudbaseConfig.envId) {
    throw new Error("请先在 config/api.js 填写 cloudbaseConfig.envId");
  }
  if (!cloudbaseConfig.serviceName) {
    throw new Error("请先在 config/api.js 填写 cloudbaseConfig.serviceName");
  }
  if (!wx.cloud || !wx.cloud.Cloud) {
    throw new Error("当前基础库不支持 wx.cloud.Cloud，请升级微信开发者工具基础库");
  }

  if (!cloudClientPromise) {
    const client = new wx.cloud.Cloud({
      resourceEnv: cloudbaseConfig.envId
    });
    cloudClientPromise = client.init().then(() => client);
  }

  return cloudClientPromise;
}

async function requestWithCloudBase(options) {
  const client = await getCloudClient();
  const response = await client.callContainer({
    path: options.path,
    method: options.method || "POST",
    data: options.data,
    header: {
      ...buildCloudHeaders(options.header),
      "content-type": "application/json"
    },
    dataType: "json"
  });

  return validateOkResponse(response);
}

function requestApi(options) {
  if (cloudbaseConfig.enabled) {
    return requestWithCloudBase(options);
  }

  return requestWithWxRequest(options);
}

function requestParkingRecognition(payload) {
  return requestApi({
    url: apiConfig.recognitionApiUrl,
    path: cloudbaseConfig.recognitionPath,
    method: "POST",
    timeout: apiConfig.requestTimeoutMs,
    data: payload
  });
}

// ---------------------------------------------------------------------------
// Backend REST API request wrapper
// ---------------------------------------------------------------------------

function request(method, path, data, options) {
  const opts = options || {};
  const header = buildAuthHeaders(opts.header);

  if (cloudbaseConfig.enabled) {
    return getCloudClient().then((client) => client.callContainer({
      path,
      method,
      data,
      header: buildCloudHeaders(header),
      dataType: "json",
      timeout: opts.timeout || apiConfig.requestTimeoutMs
    })).then((res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        return res.data;
      }
      throw buildApiError(res, "请求失败");
    });
  }

  const baseUrl = apiConfig.baseUrl || "http://127.0.0.1:8787";
  const url = baseUrl + path;

  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method,
      data,
      header,
      timeout: opts.timeout || apiConfig.requestTimeoutMs,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          reject(buildApiError(res, "请求失败"));
        }
      },
      fail(err) {
        reject(new Error(err.errMsg || "网络请求失败"));
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

function readFileAsBase64(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: "base64",
      success(res) {
        resolve(res.data);
      },
      fail(err) {
        reject(new Error(err.errMsg || "图片读取失败"));
      }
    });
  });
}

async function uploadImage(filePath) {
  const path = "/api/upload";

  if (cloudbaseConfig.enabled) {
    const base64 = await readFileAsBase64(filePath);
    const res = await request("POST", path, {
      filename: getFilename(filePath),
      mediaType: inferMediaType(filePath),
      base64
    });
    return res.url || "";
  }

  const baseUrl = apiConfig.baseUrl || "http://127.0.0.1:8787";
  const url = baseUrl + path;
  const token = getToken();
  const header = {};
  if (token) {
    header.Authorization = "Bearer " + token;
  }

  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url,
      filePath,
      name: "file",
      header,
      timeout: apiConfig.requestTimeoutMs,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const data = JSON.parse(res.data);
            resolve(data.url || "");
          } catch (e) {
            reject(new Error("上传响应解析失败"));
          }
        } else {
          reject(new Error("图片上传失败"));
        }
      },
      fail(err) {
        reject(new Error(err.errMsg || "图片上传失败"));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Existing exports
  requestApi,
  requestParkingRecognition,
  // Token management
  getToken,
  setToken,
  clearToken,
  // Generic request
  request,
  // Auth
  login,
  // Parking lots
  getParkingLots,
  getParkingLotDetail,
  createParkingLot,
  updateParkingLot,
  voteParkingLot,
  // Vehicles
  getVehicles,
  addVehicle,
  deleteVehicle,
  // Upload
  uploadImage
};
