-- =============================================================================
-- Mini Parking – Supabase (PostgreSQL) Migration
-- Execute this in the Supabase Dashboard → SQL Editor
-- =============================================================================

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  openid TEXT UNIQUE NOT NULL,
  nickname TEXT DEFAULT '',
  avatar_url TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 停车场表
CREATE TABLE IF NOT EXISTS parking_lots (
  id TEXT PRIMARY KEY,  -- UUID string
  name TEXT NOT NULL,
  address TEXT DEFAULT '',
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  entrance_tip TEXT DEFAULT '',
  availability TEXT DEFAULT 'unknown' CHECK (availability IN ('unknown','plenty','few','full')),
  walk_extra_minutes INTEGER DEFAULT 0,
  pricing JSONB NOT NULL,  -- {default: {free_minutes, unit_minutes, unit_price, daily_cap}, new_energy: {...}, tiers: [...]}
  evidence_photos JSONB DEFAULT '[]'::jsonb,
  owner_openid TEXT NOT NULL REFERENCES users(openid),
  owner_nickname TEXT DEFAULT '',
  owner_avatar TEXT DEFAULT '',
  source TEXT DEFAULT 'user',
  upvotes INTEGER DEFAULT 0,
  downvotes INTEGER DEFAULT 0,
  credibility DOUBLE PRECISION DEFAULT 60,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 投票表
CREATE TABLE IF NOT EXISTS votes (
  id BIGSERIAL PRIMARY KEY,
  user_openid TEXT NOT NULL REFERENCES users(openid),
  lot_id TEXT NOT NULL REFERENCES parking_lots(id),
  type TEXT NOT NULL CHECK (type IN ('up', 'down')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_openid, lot_id)
);

-- 车辆表
CREATE TABLE IF NOT EXISTS vehicles (
  id BIGSERIAL PRIMARY KEY,
  user_openid TEXT NOT NULL REFERENCES users(openid),
  plate TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('fuel', 'new_energy')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_openid, plate)
);

-- 地理位置查询函数（根据经纬度和半径筛选）
CREATE OR REPLACE FUNCTION nearby_parking_lots(lat DOUBLE PRECISION, lng DOUBLE PRECISION, radius_meters DOUBLE PRECISION)
RETURNS SETOF parking_lots AS $$
  SELECT *
  FROM parking_lots
  WHERE (
    6371000 * acos(
      cos(radians(lat)) * cos(radians(latitude)) *
      cos(radians(longitude) - radians(lng)) +
      sin(radians(lat)) * sin(radians(latitude))
    )
  ) <= radius_meters;
$$ LANGUAGE sql STABLE;

-- 索引
CREATE INDEX IF NOT EXISTS idx_parking_lots_location ON parking_lots(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_votes_lot ON votes(lot_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_user ON vehicles(user_openid);
