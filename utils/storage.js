const api = require("./api");

const CURRENT_USER_KEY = "parkingCurrentUser";
const LOGIN_KEY = "parkingLoginState";
const CURRENT_VEHICLE_KEY = "parkingCurrentVehicleId";

const VEHICLE_TYPE_LABELS = {
  new_energy: "新能源小型车",
  fuel: "燃油小型车"
};

const APP_AVAILABILITY_MAP = {
  plenty: "high",
  few: "medium",
  full: "low",
  high: "high",
  medium: "medium",
  low: "low",
  unknown: "unknown"
};

// ---------------------------------------------------------------------------
// User profile helpers (lightweight local state for session UI only)
// ---------------------------------------------------------------------------

function avatarTextFromNickname(nickname) {
  const value = String(nickname || "").trim();
  return value ? value.slice(0, 1) : "我";
}

function getCurrentUser() {
  try {
    const user = wx.getStorageSync(CURRENT_USER_KEY);
    return user && user.id ? user : null;
  } catch (error) {
    return null;
  }
}

function updateCurrentUserProfile(userInfo) {
  const current = getCurrentUser() || {};
  const nickname = (userInfo && userInfo.nickName) || current.nickname || "本机用户";
  const nextUser = {
    ...current,
    id: current.id || "",
    nickname,
    avatarUrl: (userInfo && userInfo.avatarUrl) || current.avatarUrl || "",
    avatarText: avatarTextFromNickname(nickname),
    avatarColor: current.avatarColor || "#166a5b",
    updatedAt: Date.now()
  };
  wx.setStorageSync(CURRENT_USER_KEY, nextUser);
  return nextUser;
}

function getLoggedInUser() {
  try {
    const state = wx.getStorageSync(LOGIN_KEY);
    if (!state || !state.loggedAt) return null;
    return getCurrentUser();
  } catch (error) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Current vehicle selection (ID only; vehicle data always comes from API)
// ---------------------------------------------------------------------------

function getCurrentVehicleId() {
  try {
    return wx.getStorageSync(CURRENT_VEHICLE_KEY) || "";
  } catch (error) {
    return "";
  }
}

function setCurrentVehicleId(id) {
  wx.setStorageSync(CURRENT_VEHICLE_KEY, id || "");
}

// ---------------------------------------------------------------------------
// Data normalization (server → UI format)
// ---------------------------------------------------------------------------

function normalizeEvidencePhotos(photos) {
  return (Array.isArray(photos) ? photos : []).map((photo) => {
    if (typeof photo === "string") {
      return { path: photo, uploadedUrl: photo, uploaded: true };
    }
    return photo;
  });
}

function normalizeParkingLot(lot) {
  const source = lot || {};
  const confidence = Number.isFinite(Number(source.confidence))
    ? Number(source.confidence)
    : (Number.isFinite(Number(source.credibility)) ? Number(source.credibility) : 50);
  const latitude = (source.location && source.location.latitude != null)
    ? source.location.latitude
    : source.latitude;
  const longitude = (source.location && source.location.longitude != null)
    ? source.location.longitude
    : source.longitude;
  const access = source.access || {};
  const evidence = source.evidence || {};
  const evidencePhotos = normalizeEvidencePhotos(evidence.photos || source.evidence_photos);
  const upvotes = Number(source.upvotes != null ? source.upvotes : source.voteStats && source.voteStats.up) || 0;
  const downvotes = Number(source.downvotes != null ? source.downvotes : source.voteStats && source.voteStats.down) || 0;
  const ownerId = source.ownerId || source.owner_openid || (source.owner && source.owner.id) || "";
  const ownerName = source.owner_nickname || (source.owner && source.owner.nickname) || (source.source === "user" ? "用户分享" : "官方数据");

  return {
    ...source,
    updatedAt: source.updatedAt || source.updated_at || source.created_at || "",
    confidence,
    rawConfidence: Number.isFinite(Number(source.rawConfidence)) ? Number(source.rawConfidence) : confidence,
    availability: APP_AVAILABILITY_MAP[source.availability] || "unknown",
    distanceHintMeters: source.distanceHintMeters || source.distance,
    location: {
      latitude,
      longitude,
      amap: (source.location && source.location.amap) || source.amap || {}
    },
    access: {
      entrance: access.entrance || source.entrance_tip || "入口待补充",
      walkingPenaltyMinutes: access.walkingPenaltyMinutes || source.walk_extra_minutes || 0,
      tags: Array.isArray(access.tags) ? access.tags : []
    },
    evidence: {
      ...evidence,
      photos: evidencePhotos,
      recognitionStatus: evidence.recognitionStatus || (evidencePhotos.length ? "已上传现场图片" : "无照片证据"),
      recognitionWarnings: Array.isArray(evidence.recognitionWarnings) ? evidence.recognitionWarnings : []
    },
    ownerId,
    owner: source.owner || {
      id: ownerId,
      nickname: ownerName,
      avatarUrl: source.owner_avatar || "",
      avatarText: ownerName ? ownerName.slice(0, 1) : "用",
      avatarColor: source.source === "user" ? "#166a5b" : "#5d6f7d"
    },
    voteStats: {
      up: upvotes,
      down: downvotes,
      total: upvotes + downvotes,
      score: upvotes - downvotes,
      currentUserVote: ""
    }
  };
}

function decorateLot(lot) {
  const normalized = normalizeParkingLot(lot);
  const user = getLoggedInUser();
  const ownerId = normalized.ownerId || (normalized.owner && normalized.owner.id) || "";
  return {
    ...normalized,
    ownerId,
    canEdit: Boolean(user && ownerId && ownerId === user.id)
  };
}

function normalizeVehicles(vehicles) {
  return (Array.isArray(vehicles) ? vehicles : []).map((v) => ({
    ...v,
    plateNumber: v.plate || v.plateNumber || "",
    vehicleType: v.type || v.vehicleType || "fuel",
    vehicleTypeLabel: VEHICLE_TYPE_LABELS[v.type || v.vehicleType] || VEHICLE_TYPE_LABELS.fuel,
    sizeType: "small",
    sizeTypeLabel: "小型车"
  }));
}

function selectCurrentVehicle(vehicles) {
  const normalized = normalizeVehicles(vehicles);
  const currentId = getCurrentVehicleId();
  const selected = normalized.find((vehicle) => `${vehicle.id}` === `${currentId}`) || normalized[0] || null;

  if (selected) {
    if (`${selected.id}` !== `${currentId}`) {
      setCurrentVehicleId(selected.id);
    }
    return selected;
  }

  if (currentId) {
    setCurrentVehicleId("");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pure API methods (online only — no offline fallback)
// ---------------------------------------------------------------------------

async function asyncGetAllParkingLots(latitude, longitude, radius) {
  const lots = await api.getParkingLots(latitude, longitude, radius);
  return (Array.isArray(lots) ? lots : []).map(decorateLot);
}

async function asyncGetParkingLotDetail(id) {
  const result = await api.getParkingLotDetail(id);
  if (!result.lot) {
    return { lot: null, userVote: null };
  }
  const decorated = decorateLot(result.lot);
  return {
    lot: decorated,
    userVote: result.userVote || null
  };
}

async function asyncSaveUserParkingLot(apiPayload) {
  return api.createParkingLot(apiPayload);
}

async function asyncUpdateUserParkingLot(lotId, apiPayload) {
  return api.updateParkingLot(lotId, apiPayload);
}

async function asyncVoteParkingLot(lotId, voteValue) {
  return api.voteParkingLot(lotId, voteValue);
}

async function asyncGetUserVehicles() {
  const vehicles = await api.getVehicles();
  const normalized = normalizeVehicles(vehicles);
  selectCurrentVehicle(normalized);
  return normalized;
}

async function asyncGetCurrentVehicle() {
  const vehicles = await asyncGetUserVehicles();
  return selectCurrentVehicle(vehicles);
}

async function asyncAddVehicle(plate, type) {
  const vehicle = await api.addVehicle(plate, type);
  if (!vehicle) throw new Error("添加车辆失败");
  const normalized = normalizeVehicles([vehicle])[0];
  if (!getCurrentVehicleId()) {
    wx.setStorageSync(CURRENT_VEHICLE_KEY, normalized.id);
  }
  return normalized;
}

async function asyncDeleteVehicle(id) {
  const success = await api.deleteVehicle(id);
  if (!success) throw new Error("删除车辆失败");
  if (`${getCurrentVehicleId()}` === `${id}`) {
    setCurrentVehicleId("");
  }
  return true;
}

module.exports = {
  getCurrentUser,
  getCurrentVehicleId,
  setCurrentVehicleId,
  getLoggedInUser,
  updateCurrentUserProfile,
  VEHICLE_TYPE_LABELS,
  decorateLot,
  normalizeVehicles,
  // Pure API methods
  asyncGetAllParkingLots,
  asyncGetParkingLotDetail,
  asyncSaveUserParkingLot,
  asyncUpdateUserParkingLot,
  asyncVoteParkingLot,
  asyncGetUserVehicles,
  asyncGetCurrentVehicle,
  asyncAddVehicle,
  asyncDeleteVehicle
};
