const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const path = require("path");

// ---------------------------------------------------------------------------
// Supabase client singleton
// ---------------------------------------------------------------------------

let _supabase = null;
let _storageBucketReady = null;

const DEFAULT_STORAGE_BUCKET = "parking-evidence";

function getSupabase() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;

    if (!url || !key) {
      throw new Error(
        "SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables are required"
      );
    }

    _supabase = createClient(url, key, {
      auth: { persistSession: false }
    });
  }
  return _supabase;
}

function getStorageBucketName() {
  return process.env.SUPABASE_STORAGE_BUCKET || DEFAULT_STORAGE_BUCKET;
}

function resetSupabaseForTests(client) {
  _supabase = client || null;
  _storageBucketReady = null;
}

async function ensureStorageBucket() {
  if (_storageBucketReady) return _storageBucketReady;

  _storageBucketReady = (async () => {
    const supabase = getSupabase();
    const bucketName = getStorageBucketName();
    const { data: buckets, error: listError } = await supabase.storage.listBuckets();
    if (listError) {
      throw new Error(`list storage buckets failed: ${listError.message}`);
    }

    const existing = (buckets || []).find((bucket) => bucket.name === bucketName);
    const bucketOptions = {
      public: true,
      fileSizeLimit: "10MB",
      allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"]
    };
    if (!existing) {
      const { error: createError } = await supabase.storage.createBucket(bucketName, {
        ...bucketOptions
      });
      if (createError) {
        throw new Error(`create storage bucket failed: ${createError.message}`);
      }
    } else if (!existing.public) {
      const { error: updateError } = await supabase.storage.updateBucket(bucketName, {
        ...bucketOptions
      });
      if (updateError) {
        throw new Error(`update storage bucket failed: ${updateError.message}`);
      }
    }

    return bucketName;
  })();

  try {
    return await _storageBucketReady;
  } catch (error) {
    _storageBucketReady = null;
    throw error;
  }
}

function safeStorageExtension(filename, mediaType) {
  const fromName = path.extname(String(filename || "")).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(fromName)) {
    return fromName === ".jpeg" ? ".jpg" : fromName;
  }

  const type = String(mediaType || "").toLowerCase();
  if (type === "image/png") return ".png";
  if (type === "image/webp") return ".webp";
  if (type === "image/gif") return ".gif";
  return ".jpg";
}

function buildEvidenceObjectPath(filename, mediaType) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = `${now.getUTCMonth() + 1}`.padStart(2, "0");
  const random = crypto.randomBytes(8).toString("hex");
  const ext = safeStorageExtension(filename, mediaType);
  return `evidence/${year}/${month}/${Date.now()}-${random}${ext}`;
}

async function uploadEvidencePhoto({ buffer, filename, mediaType }) {
  const bucketName = await ensureStorageBucket();
  const objectPath = buildEvidenceObjectPath(filename, mediaType);
  const contentType = mediaType || "image/jpeg";
  const supabase = getSupabase();
  const { error } = await supabase.storage
    .from(bucketName)
    .upload(objectPath, buffer, {
      contentType,
      upsert: false
    });

  if (error) {
    throw new Error(`upload evidence photo failed: ${error.message}`);
  }

  const { data } = supabase.storage.from(bucketName).getPublicUrl(objectPath);
  return {
    url: data.publicUrl,
    uploadedUrl: data.publicUrl,
    storageBucket: bucketName,
    storagePath: objectPath
  };
}

async function downloadEvidencePhoto(bucketName, objectPath) {
  const supabase = getSupabase();
  const bucket = bucketName || getStorageBucketName();
  const { data, error } = await supabase.storage.from(bucket).download(objectPath);
  if (error) {
    throw new Error(`download evidence photo failed: ${error.message}`);
  }
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ---------------------------------------------------------------------------
// Credibility calculation
// ---------------------------------------------------------------------------

function computeCredibility(upvotes, downvotes) {
  const raw = 60 + (upvotes * 3) - (downvotes * 5);
  return Math.max(0, Math.min(100, raw));
}

// ---------------------------------------------------------------------------
// Availability mapping (seed -> DB convention)
// ---------------------------------------------------------------------------

const AVAILABILITY_MAP = {
  high: "plenty",
  medium: "few",
  low: "full",
  plenty: "plenty",
  few: "few",
  full: "full",
  unknown: "unknown"
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
// Row normalisation: Supabase returns snake_case columns; keep them as-is
// but ensure JSONB columns are already parsed objects.
// ---------------------------------------------------------------------------

function normalizeEvidencePhotos(value) {
  const photos = Array.isArray(value) ? value : [];
  return photos.map((photo) => {
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

function normalizeLotRow(row) {
  if (!row) return null;
  const evidencePhotos = normalizeEvidencePhotos(row.evidence_photos);
  const confidence = Number.isFinite(Number(row.credibility)) ? Math.round(Number(row.credibility)) : 60;
  const upvotes = Number(row.upvotes) || 0;
  const downvotes = Number(row.downvotes) || 0;
  const ownerId = row.owner_openid || "";
  const ownerNickname = row.owner_nickname || (row.source === "user" ? "用户分享" : "官方示例");
  const ownerAvatar = row.owner_avatar || "";

  return {
    id: row.id,
    name: row.name,
    address: row.address || "",
    source: row.source || "user",
    updatedAt: row.updated_at || row.created_at || "",
    createdAt: row.created_at || "",
    confidence,
    rawConfidence: confidence,
    availability: APP_AVAILABILITY_MAP[row.availability] || "unknown",
    distanceHintMeters: Number.isFinite(Number(row.distance)) ? Math.round(Number(row.distance)) : undefined,
    location: {
      latitude: row.latitude,
      longitude: row.longitude
    },
    access: {
      entrance: row.entrance_tip || "入口待补充",
      walkingPenaltyMinutes: row.walk_extra_minutes || 0,
      tags: []
    },
    pricing: row.pricing || {},
    evidence: {
      photos: evidencePhotos,
      recognitionStatus: evidencePhotos.length ? "已上传现场图片" : "无照片证据",
      recognitionWarnings: []
    },
    ownerId,
    owner: {
      id: ownerId,
      nickname: ownerNickname,
      avatarUrl: ownerAvatar,
      avatarText: ownerNickname ? ownerNickname.slice(0, 1) : "用",
      avatarColor: row.source === "user" ? "#166a5b" : "#5d6f7d"
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

function getLotOwnerOpenid(row) {
  return row ? row.owner_openid || row.ownerId || "" : "";
}

// ---------------------------------------------------------------------------
// initDB – no-op for Supabase (tables created via migration.sql)
// ---------------------------------------------------------------------------

function initDB() {
  // Kept for API compatibility; Supabase tables are created via migration.sql
  return getSupabase();
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

async function findOrCreateUser(openid) {
  const supabase = getSupabase();

  // Try to find existing user
  const { data: existing, error: selectError } = await supabase
    .from("users")
    .select("*")
    .eq("openid", openid)
    .maybeSingle();

  if (selectError) {
    throw new Error(`findOrCreateUser select failed: ${selectError.message}`);
  }
  if (existing) return existing;

  // Insert new user
  const { data: created, error: insertError } = await supabase
    .from("users")
    .insert({ openid, nickname: "", avatar_url: "" })
    .select()
    .single();

  if (insertError) {
    // Race condition: another request may have inserted the same openid
    if (insertError.code === "23505") {
      const { data: retry, error: retryError } = await supabase
        .from("users")
        .select("*")
        .eq("openid", openid)
        .single();
      if (retryError) throw new Error(`findOrCreateUser retry failed: ${retryError.message}`);
      return retry;
    }
    throw new Error(`findOrCreateUser insert failed: ${insertError.message}`);
  }

  return created;
}

async function updateUserProfile(openid, { nickname, avatarUrl }) {
  const supabase = getSupabase();

  const updates = {};
  if (nickname !== undefined) updates.nickname = nickname;
  if (avatarUrl !== undefined) updates.avatar_url = avatarUrl;

  if (Object.keys(updates).length === 0) {
    const { data, error } = await supabase
      .from("users")
      .select("*")
      .eq("openid", openid)
      .single();
    if (error) throw new Error(`updateUserProfile select failed: ${error.message}`);
    return data;
  }

  const { data, error } = await supabase
    .from("users")
    .update(updates)
    .eq("openid", openid)
    .select()
    .single();

  if (error) throw new Error(`updateUserProfile failed: ${error.message}`);
  return data;
}

// ---------------------------------------------------------------------------
// Parking Lots
// ---------------------------------------------------------------------------

async function getAllParkingLots({ latitude, longitude, radiusMeters } = {}) {
  const supabase = getSupabase();

  let rows;

  if (latitude != null && longitude != null && radiusMeters != null) {
    // Use the PostGIS-style RPC function for geo filtering
    const { data, error } = await supabase.rpc("nearby_parking_lots", {
      lat: latitude,
      lng: longitude,
      radius_meters: radiusMeters
    });
    if (error) throw new Error(`getAllParkingLots rpc failed: ${error.message}`);
    rows = (data || []).map(normalizeLotRow);
  } else {
    // No geo filter – return all, ordered by credibility
    const { data, error } = await supabase
      .from("parking_lots")
      .select("*")
      .order("credibility", { ascending: false });
    if (error) throw new Error(`getAllParkingLots select failed: ${error.message}`);
    rows = (data || []).map(normalizeLotRow);

    // If lat/lng provided without radius, calculate approximate distance
    if (latitude != null && longitude != null) {
      rows.forEach((lot) => {
        const dLat = lot.location.latitude - latitude;
        const dLng = lot.location.longitude - longitude;
        lot.distanceHintMeters = Math.sqrt(
          Math.pow(dLat * 111320, 2) +
          Math.pow(dLng * 111320 * Math.cos(latitude * Math.PI / 180), 2)
        );
      });
    }
  }

  return rows;
}

async function createParkingLot(lotData) {
  const supabase = getSupabase();

  // Ensure owner user exists
  await findOrCreateUser(lotData.owner_openid);

  const pricing = typeof lotData.pricing === "string"
    ? JSON.parse(lotData.pricing)
    : (lotData.pricing || {});

  const evidencePhotos = typeof lotData.evidence_photos === "string"
    ? JSON.parse(lotData.evidence_photos)
    : (lotData.evidence_photos || []);

  const row = {
    id: lotData.id,
    name: lotData.name,
    address: lotData.address || "",
    latitude: lotData.latitude,
    longitude: lotData.longitude,
    entrance_tip: lotData.entrance_tip || "",
    availability: AVAILABILITY_MAP[lotData.availability] || lotData.availability || "unknown",
    walk_extra_minutes: lotData.walk_extra_minutes || 0,
    pricing,
    evidence_photos: evidencePhotos,
    owner_openid: lotData.owner_openid,
    owner_nickname: lotData.owner_nickname || "",
    owner_avatar: lotData.owner_avatar || "",
    source: lotData.source || "user"
  };

  const { data, error } = await supabase
    .from("parking_lots")
    .insert(row)
    .select()
    .single();

  if (error) throw new Error(`createParkingLot failed: ${error.message}`);
  return normalizeLotRow(data);
}

async function updateParkingLot(id, ownerOpenid, lotData) {
  const supabase = getSupabase();

  // Verify ownership
  const { data: existing, error: selectError } = await supabase
    .from("parking_lots")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (selectError) throw new Error(`updateParkingLot select failed: ${selectError.message}`);
  if (!existing) return null;
  if (getLotOwnerOpenid(existing) !== ownerOpenid) {
    throw new Error("not authorized: only the owner can update this parking lot");
  }

  const updates = {};

  const allowedFields = [
    "name", "address", "latitude", "longitude", "entrance_tip",
    "availability", "walk_extra_minutes", "source"
  ];

  for (const key of allowedFields) {
    if (key === "availability" && lotData[key] !== undefined) {
      updates[key] = AVAILABILITY_MAP[lotData[key]] || lotData[key];
    } else if (lotData[key] !== undefined) {
      updates[key] = lotData[key];
    }
  }

  if (lotData.pricing !== undefined) {
    updates.pricing = typeof lotData.pricing === "string"
      ? JSON.parse(lotData.pricing)
      : lotData.pricing;
  }

  if (lotData.evidence_photos !== undefined) {
    updates.evidence_photos = typeof lotData.evidence_photos === "string"
      ? JSON.parse(lotData.evidence_photos)
      : lotData.evidence_photos;
  }

  if (Object.keys(updates).length === 0) {
    return normalizeLotRow(existing);
  }

  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("parking_lots")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) throw new Error(`updateParkingLot failed: ${error.message}`);
  return normalizeLotRow(data);
}

async function getParkingLotById(id) {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("parking_lots")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`getParkingLotById failed: ${error.message}`);
  return normalizeLotRow(data);
}

// ---------------------------------------------------------------------------
// Votes
// ---------------------------------------------------------------------------

async function voteParkingLot(userOpenid, lotId, type) {
  const supabase = getSupabase();

  // Ensure user exists
  await findOrCreateUser(userOpenid);

  // Delete existing vote for this user+lot, then insert new one
  const { error: deleteError } = await supabase
    .from("votes")
    .delete()
    .eq("user_openid", userOpenid)
    .eq("lot_id", lotId);

  if (deleteError) throw new Error(`voteParkingLot delete failed: ${deleteError.message}`);

  const { error: insertError } = await supabase
    .from("votes")
    .insert({ user_openid: userOpenid, lot_id: lotId, type });

  if (insertError) throw new Error(`voteParkingLot insert failed: ${insertError.message}`);

  // Recount votes
  const { data: upvoteRows, error: upError } = await supabase
    .from("votes")
    .select("id", { count: "exact", head: false })
    .eq("lot_id", lotId)
    .eq("type", "up");

  const { data: downvoteRows, error: downError } = await supabase
    .from("votes")
    .select("id", { count: "exact", head: false })
    .eq("lot_id", lotId)
    .eq("type", "down");

  if (upError) throw new Error(`voteParkingLot count upvotes failed: ${upError.message}`);
  if (downError) throw new Error(`voteParkingLot count downvotes failed: ${downError.message}`);

  const upvotes = upvoteRows ? upvoteRows.length : 0;
  const downvotes = downvoteRows ? downvoteRows.length : 0;
  const credibility = computeCredibility(upvotes, downvotes);

  // Update parking lot with new counts
  const { error: updateError } = await supabase
    .from("parking_lots")
    .update({
      upvotes,
      downvotes,
      credibility,
      updated_at: new Date().toISOString()
    })
    .eq("id", lotId);

  if (updateError) throw new Error(`voteParkingLot update lot failed: ${updateError.message}`);

  return { upvotes, downvotes, credibility };
}

async function getUserVote(userOpenid, lotId) {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("votes")
    .select("*")
    .eq("user_openid", userOpenid)
    .eq("lot_id", lotId)
    .maybeSingle();

  if (error) throw new Error(`getUserVote failed: ${error.message}`);
  return data;
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

async function getUserVehicles(userOpenid) {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("vehicles")
    .select("*")
    .eq("user_openid", userOpenid)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`getUserVehicles failed: ${error.message}`);
  return data || [];
}

async function addVehicle(userOpenid, plate, type) {
  const supabase = getSupabase();

  // Ensure user exists
  await findOrCreateUser(userOpenid);

  const { data, error } = await supabase
    .from("vehicles")
    .insert({ user_openid: userOpenid, plate, type })
    .select()
    .single();

  if (error) {
    // Unique violation – vehicle already exists for this user
    if (error.code === "23505") {
      const { data: existing, error: retryError } = await supabase
        .from("vehicles")
        .select("*")
        .eq("user_openid", userOpenid)
        .eq("plate", plate)
        .single();
      if (retryError) throw new Error(`addVehicle retry failed: ${retryError.message}`);
      return existing;
    }
    throw new Error(`addVehicle failed: ${error.message}`);
  }

  return data;
}

async function updateVehicle(userOpenid, vehicleId, plate, type) {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("vehicles")
    .update({ plate, type })
    .eq("id", vehicleId)
    .eq("user_openid", userOpenid)
    .select()
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      throw new Error("PLATE_DUPLICATED");
    }
    throw new Error(`updateVehicle failed: ${error.message}`);
  }
  return data || null;
}

async function deleteVehicle(userOpenid, vehicleId) {
  const supabase = getSupabase();

  const { count, error } = await supabase
    .from("vehicles")
    .delete({ count: "exact" })
    .eq("id", vehicleId)
    .eq("user_openid", userOpenid);

  if (error) throw new Error(`deleteVehicle failed: ${error.message}`);
  return count > 0;
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  initDB,
  findOrCreateUser,
  updateUserProfile,
  getAllParkingLots,
  createParkingLot,
  updateParkingLot,
  getParkingLotById,
  voteParkingLot,
  getUserVote,
  getUserVehicles,
  addVehicle,
  updateVehicle,
  deleteVehicle,
  uploadEvidencePhoto,
  downloadEvidencePhoto,
  getStorageBucketName,
  resetSupabaseForTests,
  // Exposed for seed script and direct access if needed
  getSupabase,
  computeCredibility,
  AVAILABILITY_MAP
};
