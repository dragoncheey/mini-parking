const { seedParkingLots } = require("../data/seedParking");
const api = require("./api");

const USER_LOTS_KEY = "userParkingLots";
const CURRENT_USER_KEY = "parkingCurrentUser";
const LOT_VOTES_KEY = "parkingLotVotes";
const LOGIN_KEY = "parkingLoginState";
const USER_VEHICLES_KEY = "parkingUserVehicles";
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

function createLocalUserId() {
  return `local_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function createUserProfile() {
  const id = createLocalUserId();
  return {
    id,
    nickname: "本机用户",
    avatarUrl: "",
    avatarText: "我",
    avatarColor: "#166a5b",
    createdAt: Date.now()
  };
}

function buildOwnerFromUser(user) {
  const profile = user || {};
  return {
    id: profile.id || "",
    nickname: profile.nickname || "本机用户",
    avatarUrl: profile.avatarUrl || "",
    avatarText: profile.avatarText || "我",
    avatarColor: profile.avatarColor || "#166a5b"
  };
}

function avatarTextFromNickname(nickname) {
  const value = String(nickname || "").trim();
  return value ? value.slice(0, 1) : "我";
}

function getCurrentUser() {
  try {
    const user = wx.getStorageSync(CURRENT_USER_KEY);
    if (user && user.id) {
      return user;
    }

    const nextUser = createUserProfile();
    wx.setStorageSync(CURRENT_USER_KEY, nextUser);
    return nextUser;
  } catch (error) {
    return {
      id: "anonymous",
      nickname: "本机用户",
      createdAt: Date.now()
    };
  }
}

function updateCurrentUserProfile(userInfo) {
  const current = getCurrentUser();
  const nickname = userInfo && userInfo.nickName ? userInfo.nickName : current.nickname;
  const nextUser = {
    ...current,
    nickname,
    avatarUrl: userInfo && userInfo.avatarUrl ? userInfo.avatarUrl : current.avatarUrl || "",
    avatarText: avatarTextFromNickname(nickname),
    updatedAt: Date.now()
  };

  wx.setStorageSync(CURRENT_USER_KEY, nextUser);
  return nextUser;
}

function getLoggedInUser() {
  try {
    const state = wx.getStorageSync(LOGIN_KEY);
    if (!state || !state.loggedAt) {
      return null;
    }
    return getCurrentUser();
  } catch (error) {
    return null;
  }
}

function normalizePlateNumber(plateNumber) {
  return String(plateNumber || "").trim().toUpperCase();
}

function createVehicle(input) {
  const vehicleType = input && input.vehicleType === "new_energy" ? "new_energy" : "fuel";
  return {
    id: `vehicle_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    plateNumber: normalizePlateNumber(input && input.plateNumber),
    vehicleType,
    vehicleTypeLabel: VEHICLE_TYPE_LABELS[vehicleType],
    sizeType: "small",
    sizeTypeLabel: "小型车",
    createdAt: Date.now()
  };
}

function getUserVehicles() {
  try {
    const vehicles = wx.getStorageSync(USER_VEHICLES_KEY);
    return Array.isArray(vehicles)
      ? vehicles.map((vehicle) => ({
        ...vehicle,
        vehicleTypeLabel: VEHICLE_TYPE_LABELS[vehicle.vehicleType] || VEHICLE_TYPE_LABELS.fuel,
        sizeType: "small",
        sizeTypeLabel: "小型车"
      }))
      : [];
  } catch (error) {
    return [];
  }
}

function saveUserVehicle(input) {
  const vehicle = createVehicle(input);
  if (!vehicle.plateNumber) {
    throw new Error("PLATE_REQUIRED");
  }

  const current = getUserVehicles();
  const exists = current.some((item) => item.plateNumber === vehicle.plateNumber);
  if (exists) {
    throw new Error("PLATE_DUPLICATED");
  }

  const nextVehicles = [vehicle].concat(current);
  wx.setStorageSync(USER_VEHICLES_KEY, nextVehicles);
  if (!wx.getStorageSync(CURRENT_VEHICLE_KEY)) {
    wx.setStorageSync(CURRENT_VEHICLE_KEY, vehicle.id);
  }
  return vehicle;
}

function setCurrentVehicle(vehicleId) {
  const vehicles = getUserVehicles();
  const vehicle = vehicles.find((item) => item.id === vehicleId);
  if (!vehicle) {
    return null;
  }

  wx.setStorageSync(CURRENT_VEHICLE_KEY, vehicle.id);
  return vehicle;
}

function deleteUserVehicle(vehicleId) {
  const vehicles = getUserVehicles();
  const nextVehicles = vehicles.filter((vehicle) => vehicle.id !== vehicleId);
  const currentId = wx.getStorageSync(CURRENT_VEHICLE_KEY);
  wx.setStorageSync(USER_VEHICLES_KEY, nextVehicles);
  if (currentId === vehicleId) {
    wx.setStorageSync(CURRENT_VEHICLE_KEY, nextVehicles[0] ? nextVehicles[0].id : "");
  }
  return nextVehicles;
}

function getCurrentVehicle() {
  const vehicles = getUserVehicles();
  const currentId = wx.getStorageSync(CURRENT_VEHICLE_KEY);
  return vehicles.find((vehicle) => vehicle.id === currentId) || vehicles[0] || null;
}

function getUserParkingLots() {
  try {
    const lots = wx.getStorageSync(USER_LOTS_KEY);
    return Array.isArray(lots) ? lots : [];
  } catch (error) {
    return [];
  }
}

function getRawParkingLot(id) {
  return seedParkingLots.concat(getUserParkingLots()).find((lot) => lot.id === id);
}

function getVotes() {
  try {
    const votes = wx.getStorageSync(LOT_VOTES_KEY);
    return votes && typeof votes === "object" ? votes : {};
  } catch (error) {
    return {};
  }
}

function getLotVoteStats(lotId) {
  const votes = getVotes();
  const lotVotes = votes[lotId] || {};
  const values = Object.keys(lotVotes).map((userId) => lotVotes[userId]);
  const up = values.filter((value) => value === "up").length;
  const down = values.filter((value) => value === "down").length;
  const total = up + down;
  const user = getLoggedInUser();

  return {
    up,
    down,
    total,
    score: up - down,
    currentUserVote: user ? lotVotes[user.id] || "" : ""
  };
}

function calculateTrustedConfidence(lot) {
  const base = Number.isFinite(Number(lot && lot.confidence)) ? Number(lot.confidence) : 50;
  const stats = getLotVoteStats(lot.id);
  const adjusted = base + stats.up * 4 - stats.down * 6;
  return Math.max(0, Math.min(100, Math.round(adjusted)));
}

function normalizeEvidencePhotos(photos) {
  const list = Array.isArray(photos) ? photos : [];
  return list.map((photo) => {
    if (typeof photo === "string") {
      return {
        path: photo,
        uploadedUrl: photo,
        uploaded: true
      };
    }
    return photo;
  });
}

function normalizeParkingLot(lot) {
  const source = lot || {};
  const confidence = Number.isFinite(Number(source.confidence))
    ? Number(source.confidence)
    : (Number.isFinite(Number(source.credibility)) ? Number(source.credibility) : 50);
  const latitude = source.location && source.location.latitude != null
    ? source.location.latitude
    : source.latitude;
  const longitude = source.location && source.location.longitude != null
    ? source.location.longitude
    : source.longitude;
  const access = source.access || {};
  const evidence = source.evidence || {};
  const evidencePhotos = normalizeEvidencePhotos(evidence.photos || source.evidence_photos);
  const upvotes = Number(source.upvotes != null ? source.upvotes : source.voteStats && source.voteStats.up) || 0;
  const downvotes = Number(source.downvotes != null ? source.downvotes : source.voteStats && source.voteStats.down) || 0;
  const hasServerVoteStats = source.voteStats || source.upvotes != null || source.downvotes != null;
  const ownerId = source.ownerId || source.owner_openid || (source.owner && source.owner.id) || "";
  const ownerName = source.owner_nickname || (source.owner && source.owner.nickname) || (source.source === "user" ? "用户分享" : "官方示例");

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
    voteStats: hasServerVoteStats ? (source.voteStats || {
      up: upvotes,
      down: downvotes,
      total: upvotes + downvotes,
      score: upvotes - downvotes,
      currentUserVote: ""
    }) : undefined
  };
}

function decorateLot(lot) {
  const normalized = normalizeParkingLot(lot);
  const ownerId = normalized.ownerId || (normalized.owner && normalized.owner.id) || "";
  const owner = normalized.owner || {
    id: ownerId,
    nickname: normalized.source === "user" ? "用户分享" : "官方示例",
    avatarUrl: "",
    avatarText: normalized.source === "user" ? "用" : "官",
    avatarColor: normalized.source === "user" ? "#166a5b" : "#5d6f7d"
  };
  const user = getLoggedInUser();
  return {
    ...normalized,
    ownerId,
    owner,
    voteStats: normalized.voteStats
      ? normalized.voteStats
      : getLotVoteStats(normalized.id),
    rawConfidence: Number.isFinite(Number(normalized.rawConfidence)) ? Number(normalized.rawConfidence) : 50,
    confidence: calculateTrustedConfidence(normalized),
    canEdit: Boolean(user && ownerId && ownerId === user.id)
  };
}

function getAllParkingLots() {
  return seedParkingLots.concat(getUserParkingLots()).map(decorateLot);
}

function findParkingLot(id) {
  return getAllParkingLots().find((lot) => lot.id === id);
}

function saveUserParkingLot(lot) {
  const current = getUserParkingLots();
  const nextLot = normalizeParkingLot(lot);
  const next = [nextLot].concat(current.filter((item) => item.id !== nextLot.id));
  wx.setStorageSync(USER_LOTS_KEY, next);
}

function updateUserParkingLot(lotId, patch) {
  const current = getUserParkingLots();
  const user = getLoggedInUser();
  const votes = getVotes();
  let changed = false;
  const nextLots = current.map((lot) => {
    if (lot.id !== lotId) {
      return lot;
    }
    if (!user || lot.ownerId !== user.id) {
      return lot;
    }

    changed = true;
    return {
      ...lot,
      ...patch,
      id: lot.id,
      ownerId: lot.ownerId,
      source: lot.source,
      updatedAt: patch.updatedAt || lot.updatedAt,
      confidence: 50,
      rawConfidence: 50,
      confidenceResetAt: Date.now()
    };
  });

  if (!changed) {
    return false;
  }

  delete votes[lotId];
  wx.setStorageSync(USER_LOTS_KEY, nextLots);
  wx.setStorageSync(LOT_VOTES_KEY, votes);
  return true;
}

function voteParkingLot(lotId, voteValue) {
  if (voteValue !== "up" && voteValue !== "down") {
    throw new Error("INVALID_VOTE");
  }

  const user = getLoggedInUser();
  if (!user) {
    throw new Error("LOGIN_REQUIRED");
  }

  const lot = getRawParkingLot(lotId);
  if (lot && lot.ownerId && lot.ownerId === user.id) {
    throw new Error("OWNER_VOTE_FORBIDDEN");
  }

  const votes = getVotes();
  const lotVotes = votes[lotId] || {};

  if (lotVotes[user.id] === voteValue) {
    delete lotVotes[user.id];
  } else {
    lotVotes[user.id] = voteValue;
  }

  votes[lotId] = lotVotes;
  wx.setStorageSync(LOT_VOTES_KEY, votes);
  return getLotVoteStats(lotId);
}

// ---------------------------------------------------------------------------
// Async methods: backend-first + local fallback
// ---------------------------------------------------------------------------

async function asyncGetAllParkingLots(latitude, longitude, radius) {
  try {
    const lots = await api.getParkingLots(latitude, longitude, radius);
    if (Array.isArray(lots) && lots.length >= 0) {
      return lots.map(decorateLot);
    }
  } catch (e) {
    console.warn("asyncGetAllParkingLots fallback to local:", e.message);
  }
  return getAllParkingLots();
}

async function asyncSaveUserParkingLot(lot) {
  // Always save locally as cache
  saveUserParkingLot(lot);

  try {
    const apiLot = await api.createParkingLot(lot);
    if (apiLot) {
      return apiLot;
    }
  } catch (e) {
    console.warn("asyncSaveUserParkingLot fallback to local:", e.message);
  }
  return lot;
}

async function asyncUpdateUserParkingLot(lotId, patch) {
  // Always update locally
  updateUserParkingLot(lotId, patch);

  try {
    const apiLot = await api.updateParkingLot(lotId, patch);
    if (apiLot) {
      return apiLot;
    }
  } catch (e) {
    console.warn("asyncUpdateUserParkingLot fallback to local:", e.message);
  }
  return true;
}

async function asyncVoteParkingLot(lotId, voteValue) {
  try {
    const result = await api.voteParkingLot(lotId, voteValue);
    // Also update local vote cache
    const user = getLoggedInUser();
    if (user) {
      const votes = getVotes();
      const lotVotes = votes[lotId] || {};
      lotVotes[user.id] = voteValue;
      votes[lotId] = lotVotes;
      wx.setStorageSync(LOT_VOTES_KEY, votes);
    }
    return result;
  } catch (e) {
    console.warn("asyncVoteParkingLot fallback to local:", e.message);
    return voteParkingLot(lotId, voteValue);
  }
}

async function asyncGetUserVehicles() {
  try {
    const vehicles = await api.getVehicles();
    if (Array.isArray(vehicles)) {
      // Normalize vehicle format from backend
      const normalized = vehicles.map((v) => ({
        ...v,
        plateNumber: v.plate || v.plateNumber || "",
        vehicleType: v.type || v.vehicleType || "fuel",
        vehicleTypeLabel: VEHICLE_TYPE_LABELS[v.type || v.vehicleType] || VEHICLE_TYPE_LABELS.fuel,
        sizeType: "small",
        sizeTypeLabel: "小型车"
      }));
      // Sync to local cache
      wx.setStorageSync(USER_VEHICLES_KEY, normalized);
      return normalized;
    }
  } catch (e) {
    console.warn("asyncGetUserVehicles fallback to local:", e.message);
  }
  return getUserVehicles();
}

async function asyncAddVehicle(plate, type) {
  try {
    const vehicle = await api.addVehicle(plate, type);
    if (vehicle) {
      // Also save to local cache
      const normalized = {
        ...vehicle,
        plateNumber: vehicle.plate || plate,
        vehicleType: vehicle.type || type || "fuel",
        vehicleTypeLabel: VEHICLE_TYPE_LABELS[vehicle.type || type] || VEHICLE_TYPE_LABELS.fuel,
        sizeType: "small",
        sizeTypeLabel: "小型车"
      };
      const current = getUserVehicles();
      const exists = current.some((item) => item.plateNumber === normalized.plateNumber);
      if (!exists) {
        wx.setStorageSync(USER_VEHICLES_KEY, [normalized].concat(current));
      }
      if (!wx.getStorageSync(CURRENT_VEHICLE_KEY)) {
        wx.setStorageSync(CURRENT_VEHICLE_KEY, normalized.id);
      }
      return normalized;
    }
  } catch (e) {
    console.warn("asyncAddVehicle fallback to local:", e.message);
  }
  // Fallback: save locally
  return saveUserVehicle({ plateNumber: plate, vehicleType: type });
}

async function asyncDeleteVehicle(id) {
  try {
    const success = await api.deleteVehicle(id);
    if (success) {
      // Also remove from local cache
      deleteUserVehicle(id);
      return true;
    }
  } catch (e) {
    console.warn("asyncDeleteVehicle fallback to local:", e.message);
  }
  // Fallback: delete locally
  deleteUserVehicle(id);
  return true;
}

async function asyncGetParkingLotDetail(id) {
  try {
    const result = await api.getParkingLotDetail(id);
    if (result.lot) {
      const decorated = decorateLot(result.lot);
      return {
        lot: decorated,
        userVote: result.userVote
      };
    }
  } catch (e) {
    console.warn("asyncGetParkingLotDetail fallback to local:", e.message);
  }
  // Fallback: use local data
  const lot = findParkingLot(id);
  return {
    lot: lot || null,
    userVote: lot && lot.voteStats ? lot.voteStats.currentUserVote || null : null
  };
}

module.exports = {
  buildOwnerFromUser,
  calculateTrustedConfidence,
  deleteUserVehicle,
  findParkingLot,
  getAllParkingLots,
  getCurrentUser,
  getCurrentVehicle,
  getLoggedInUser,
  getLotVoteStats,
  getUserParkingLots,
  getUserVehicles,
  saveUserParkingLot,
  saveUserVehicle,
  setCurrentVehicle,
  updateCurrentUserProfile,
  updateUserParkingLot,
  voteParkingLot,
  VEHICLE_TYPE_LABELS,
  // Async methods: backend-first + local fallback
  asyncGetAllParkingLots,
  asyncSaveUserParkingLot,
  asyncUpdateUserParkingLot,
  asyncVoteParkingLot,
  asyncGetUserVehicles,
  asyncAddVehicle,
  asyncDeleteVehicle,
  asyncGetParkingLotDetail
};
