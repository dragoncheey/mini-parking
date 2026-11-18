const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { seedParkingLots } = require("../data/seedParking");
const { calculateParkingFee, calculateParkingFeeForVehicle } = require("../utils/pricing");
const {
  buildRecommendationSummary,
  paginateRecommendations,
  recommendParkingLots,
  sortRecommendationsByMode
} = require("../utils/recommendation");
const { buildMockRecognition, normalizeRecognition, parseJsonFromText } = require("../utils/recognition");
const { recognizeWithSenseNovaApi } = require("../server/modelClient");
const { decodeToken, extractOpenid, generateToken } = require("../server/auth");
const { apiConfig } = require("../config/api");
const db = require("../server/db");
const api = require("../utils/api");
const {
  asyncAddVehicle,
  asyncUpdateVehicle,
  asyncDeleteVehicle,
  asyncGetAllParkingLots,
  asyncGetCurrentVehicle,
  asyncGetParkingLotDetail,
  asyncGetUserVehicles,
  asyncSaveUserParkingLot,
  asyncUpdateUserParkingLot,
  asyncVoteParkingLot,
  getLoggedInUser,
  getCurrentVehicleId,
  setCurrentVehicleId,
  updateCurrentUserProfile,
  normalizeVehicles
} = require("../utils/storage");

const LEGACY_POI_KEY = "amap" + "PoiId";

function readProjectFile(filePath) {
  return fs.readFileSync(path.join(__dirname, "..", filePath), "utf8");
}

function testPricing() {
  assert.strictEqual(calculateParkingFee(60, seedParkingLots[0].pricing), 0);
  assert.strictEqual(calculateParkingFee(180, seedParkingLots[0].pricing), 10);
  assert.strictEqual(calculateParkingFee(180, seedParkingLots[1].pricing), 15);
  assert.strictEqual(calculateParkingFeeForVehicle(180, seedParkingLots[1].pricing, "new_energy"), 6);
  assert.strictEqual(calculateParkingFeeForVehicle(60, seedParkingLots[1].pricing, "new_energy"), 0);
  assert.strictEqual(calculateParkingFeeForVehicle(60, seedParkingLots[1].pricing, "fuel"), 3);
  assert.strictEqual(calculateParkingFee(180, seedParkingLots[3].pricing), 22);
  assert.strictEqual(calculateParkingFee(180, seedParkingLots[4].pricing), 20);
  assert.strictEqual(calculateParkingFee(1500, seedParkingLots[4].pricing), 40);
  assert.strictEqual(calculateParkingFee(180, {
    chargeType: "flat",
    flatDurationMinutes: 1440,
    flatPrice: 10,
    flatRepeat: false
  }), 10);
}

function testRecommendation() {
  const destination = {
    latitude: 31.23041,
    longitude: 121.4737
  };
  const oneHour = recommendParkingLots({
    lots: seedParkingLots,
    durationMinutes: 60,
    destination,
    searchRadiusMeters: 3000
  });
  const threeHours = recommendParkingLots({
    lots: seedParkingLots,
    durationMinutes: 180,
    destination,
    searchRadiusMeters: 3000
  });
  const farAway = recommendParkingLots({
    lots: seedParkingLots,
    durationMinutes: 180,
    destination: {
      latitude: 40,
      longitude: 116
    },
    searchRadiusMeters: 3000
  });
  const newEnergyThreeHours = recommendParkingLots({
    lots: seedParkingLots,
    durationMinutes: 180,
    destination,
    searchRadiusMeters: 3000,
    vehicleType: "new_energy"
  });

  assert.strictEqual(oneHour[0].id, "mall-free-60");
  assert.strictEqual(oneHour[0].fee, 0);
  assert.strictEqual(threeHours[0].id, "mall-free-60");
  assert.strictEqual(threeHours[0].fee, 10);
  assert.strictEqual(newEnergyThreeHours.find((item) => item.id === "office-half-hour").fee, 6);
  assert.strictEqual(farAway.length, 0);
  assert.ok(oneHour.every((item) => item.tags.every((tag) => !/车位|余位|满位/.test(tag))));
  assert.doesNotMatch(buildRecommendationSummary(threeHours), /车位|余位/);
}

function testRecommendationSortingAndPaging() {
  const recommendations = [
    { id: "balanced", score: 1, fee: 12, distanceMeters: 300, walkingMinutes: 4 },
    { id: "cheap-far", score: 6, fee: 4, distanceMeters: 900, walkingMinutes: 12 },
    { id: "close-expensive", score: 5, fee: 16, distanceMeters: 120, walkingMinutes: 2 },
    { id: "cheap-close", score: 7, fee: 4, distanceMeters: 240, walkingMinutes: 3 }
  ];

  assert.deepStrictEqual(
    sortRecommendationsByMode(recommendations, "comprehensive").map((item) => item.id),
    ["balanced", "close-expensive", "cheap-far", "cheap-close"]
  );
  assert.deepStrictEqual(
    sortRecommendationsByMode(recommendations, "distance").map((item) => item.id),
    ["close-expensive", "cheap-close", "balanced", "cheap-far"]
  );
  assert.deepStrictEqual(
    sortRecommendationsByMode(recommendations, "price").map((item) => item.id),
    ["cheap-close", "cheap-far", "balanced", "close-expensive"]
  );

  const manyRecommendations = Array.from({ length: 23 }, (_, index) => ({ id: `lot-${index + 1}` }));
  const firstPage = paginateRecommendations(manyRecommendations, 10, 10);
  const thirdPage = paginateRecommendations(manyRecommendations, 30, 10);

  assert.strictEqual(firstPage.items.length, 10);
  assert.strictEqual(firstPage.hasMore, true);
  assert.strictEqual(thirdPage.items.length, 23);
  assert.strictEqual(thirdPage.hasMore, false);
}

function testUiLayoutStructure() {
  const indexWxml = readProjectFile("pages/index/index.wxml");
  const indexWxss = readProjectFile("pages/index/index.wxss");
  const detailWxml = readProjectFile("pages/detail/detail.wxml");
  const vehiclesWxml = readProjectFile("pages/vehicles/vehicles.wxml");
  const addWxml = readProjectFile("pages/add/add.wxml");
  const profileWxml = readProjectFile("pages/profile/profile.wxml");
  const appJson = JSON.parse(readProjectFile("app.json"));

  const indexJson = JSON.parse(readProjectFile("pages/index/index.json"));
  assert.match(indexWxml, /class="destination-box[^\n]+bindtap="chooseDestination"/);
  assert.match(indexWxml, /class="avatar-button[^\n]+bindtap="goProfile"/);
  assert.match(indexWxml, /bindtap="selectDurationPreset"/);
  assert.match(indexWxml, /mode="multiSelector"/);
  assert.match(indexWxml, /bindmarkertap="onMarkerTap"/);
  assert.match(indexWxml, /class="map-share"[^\n]+bindtap="goAdd"/);
  assert.doesNotMatch(indexWxml, /<button[\s\S]*class="map-share/);
  assert.match(indexWxml, /class="sort-tab /);
  assert.match(indexWxml, /bindtap="chooseParkingScope"/);
  assert.match(indexWxml, /scroll-into-view="\{\{scrollIntoId\}\}"/);
  assert.match(indexWxml, /bindscrolltolower="loadMoreRecommendations"/);
  assert.match(indexWxml, /bindrefresherrefresh="onListRefresh"/);
  assert.match(indexWxml, /wx:for="\{\{visibleRecommendations\}\}"/);
  assert.match(indexWxml, /id="lot-\{\{item.id\}\}"/);
  assert.match(indexWxml, /catchtap="openNavigation"/);
  assert.match(indexWxml, /已经看完全部推荐/);
  assert.doesNotMatch(indexWxml, /bottom-sheet|sheet-drag-zone|enterMapMode/);
  assert.doesNotMatch(indexWxml, /availabilityText/);
  assert.match(indexWxss, /\.home\s*\{[\s\S]*height: 100vh;/);
  assert.strictEqual(indexJson.disableScroll, true);
  assert.notStrictEqual(indexJson.enablePullDownRefresh, true);

  assert.match(detailWxml, /class="detail-hero/);
  assert.match(detailWxml, /class="detail-primary-panel/);
  assert.match(detailWxml, /class="bottom-actions[\s\S]*bindtap="openNavigation"/);

  assert.match(vehiclesWxml, /class="vehicles-header/);
  assert.match(vehiclesWxml, /class="vehicle-card-main/);
  assert.match(vehiclesWxml, /前往“我的”登录/);
  assert.doesNotMatch(vehiclesWxml, /bindtap="login"/);
  assert.match(vehiclesWxml, /class="vehicle-card[^"]*"[\s\S]*?bindtap="useVehicle"/);
  assert.match(vehiclesWxml, /catchtap="openVehicleMenu"/);
  assert.doesNotMatch(vehiclesWxml, /catchtap="removeVehicle"/);

  assert.match(addWxml, /class="form-step/);
  assert.match(addWxml, /class="step-number/);
  assert.match(addWxml, /class="submit-dock/);
  assert.match(addWxml, /前往“我的”登录/);
  assert.doesNotMatch(addWxml, /bindtap="loginAndContinue"/);
  assert.match(addWxml, /bindtap="selectChargeType"/);
  assert.match(addWxml, /wx:for="\{\{pricePreview\}\}"/);
  assert.match(addWxml, /bindtap="toggleMore"/);

  assert.ok(appJson.pages.includes("pages/profile/profile"));
  assert.match(profileWxml, /class="profile-hero/);
  assert.match(profileWxml, /class="account-overview/);
  assert.match(profileWxml, /bindtap="logout"/);
}

function testRecognitionParsing() {
  const parsed = parseJsonFromText("```json\n{\"name\":\"测试停车场\",\"pricing\":{\"freeMinutes\":30}}\n```");
  const normalized = normalizeRecognition(parsed);
  const mock = buildMockRecognition({
    form: {
      name: "测试停车场",
      address: "测试路 1 号",
      latitude: "31.1",
      longitude: "121.1"
    },
    textHint: "1 小时免费，之后每小时 5 元，封顶 40 元"
  });

  assert.strictEqual(normalized.name, "测试停车场");
  assert.strictEqual(normalized.pricing.freeMinutes, 30);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(normalized.location, LEGACY_POI_KEY), false);
  assert.strictEqual(mock.pricing.freeMinutes, 60);
  assert.strictEqual(mock.pricing.chargeType, "hourly");
  assert.strictEqual(mock.pricing.billingUnitMinutes, 60);
  assert.strictEqual(mock.pricing.unitPrice, 5);
  assert.strictEqual(mock.pricing.maxDailyPrice, 40);

  const tariffBoardText = normalizeRecognition({
    name: "Xx小区停车场",
    pricing: {
      chargeType: "hourly",
      freeMinutes: 30,
      billingUnitMinutes: 30,
      unitPrice: 5,
      maxDailyPrice: 15,
      collectionMode: "进场取卡，离场读卡",
      tariffBoard: {
        pricingMethod: "政府指导价",
        operatorName: "深圳市某物业管理有限公司",
        complaintPhone: "12358",
        vehicleRows: [
          {
            label: "小车",
            temporaryText: "30分钟5元",
            overnightPrice: 15,
            monthlyPrice: 180
          }
        ]
      },
      pricingByVehicle: {
        new_energy: {
          freeMinutes: 120
        }
      }
    },
    confidence: 88
  });
  assert.strictEqual(tariffBoardText.pricing.chargeType, "hourly");
  assert.strictEqual(tariffBoardText.pricing.freeMinutes, 30);
  assert.strictEqual(tariffBoardText.pricing.maxDailyPrice, 15);
  assert.strictEqual(tariffBoardText.pricing.collectionMode, undefined);
  assert.strictEqual(tariffBoardText.pricing.tariffBoard, undefined);
  assert.strictEqual(tariffBoardText.pricing.pricingByVehicle.new_energy.freeMinutes, 120);

  const flatMock = buildMockRecognition({
    form: {
      name: "一次性停车场",
      address: "测试路 3 号"
    },
    textHint: "自动闸机收费，24小时10元，超过24小时重复计费，投诉电话 12358"
  });
  assert.strictEqual(flatMock.pricing.chargeType, "flat");
  assert.strictEqual(flatMock.pricing.flatDurationMinutes, 1440);
  assert.strictEqual(flatMock.pricing.flatPrice, 10);
  assert.strictEqual(flatMock.pricing.flatRepeat, true);
  assert.strictEqual(flatMock.pricing.collectionMode, undefined);
}

function withAuthEnv(values, fn) {
  const previous = {};
  Object.keys(values).forEach((key) => {
    previous[key] = process.env[key];
    if (values[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = values[key];
    }
  });

  const restore = () => {
    Object.keys(values).forEach((key) => {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    });
  };

  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function testServerAuthHelpers() {
  withAuthEnv({
    AUTH_TOKEN_SECRET: "test-secret-for-hmac",
    AUTH_TOKEN_TTL_SECONDS: "60"
  }, () => {
    const token = generateToken("openid_1", { nowMs: 1_700_000_000_000 });
    assert.strictEqual(
      extractOpenid({ headers: { authorization: `Bearer ${token}` } }, { nowMs: 1_700_000_001_000 }),
      "openid_1"
    );
    assert.strictEqual(decodeToken(token, { nowMs: 1_700_000_001_000 }).openid, "openid_1");
    assert.strictEqual(extractOpenid({ headers: {} }), null);

    const tampered = token.replace(/.$/, token.endsWith("a") ? "b" : "a");
    assert.strictEqual(extractOpenid({ headers: { authorization: `Bearer ${tampered}` } }), null);

    const expired = generateToken("openid_2", {
      nowMs: 1_700_000_000_000,
      ttlSeconds: 1
    });
    assert.strictEqual(
      extractOpenid({ headers: { authorization: `Bearer ${expired}` } }, { nowMs: 1_700_000_002_000 }),
      null
    );
  });

  withAuthEnv({
    NODE_ENV: "production",
    AUTH_TOKEN_SECRET: undefined
  }, () => {
    assert.throws(
      () => generateToken("openid_3"),
      /AUTH_TOKEN_SECRET is required/
    );
  });
}

function installWxStorageMock() {
  const store = {};
  global.wx = {
    getStorageSync(key) {
      return store[key];
    },
    setStorageSync(key, value) {
      store[key] = value;
    },
    removeStorageSync(key) {
      delete store[key];
    }
  };
  return store;
}

function testTokenRequiredLoginState() {
  const store = installWxStorageMock();
  store.parkingLoginState = { loggedAt: Date.now() };
  store.parkingCurrentUser = { id: "owner_1", nickname: "车主 A" };

  assert.strictEqual(getLoggedInUser(), null);

  store.auth_token = "token";
  assert.strictEqual(getLoggedInUser().id, "owner_1");
}

async function testOnlineParkingStorage() {
  const store = installWxStorageMock();
  const owner = {
    id: "owner_1",
    nickname: "车主 A",
    avatarText: "A",
    avatarColor: "#166a5b"
  };
  store.parkingLoginState = { loggedAt: Date.now() };
  store.parkingCurrentUser = owner;
  store.auth_token = "token";

  const calls = [];
  const originalApi = {
    getParkingLots: api.getParkingLots,
    getParkingLotDetail: api.getParkingLotDetail,
    createParkingLot: api.createParkingLot,
    updateParkingLot: api.updateParkingLot,
    voteParkingLot: api.voteParkingLot
  };

  api.getParkingLots = async (latitude, longitude, radius) => {
    calls.push(["getParkingLots", latitude, longitude, radius]);
    return [{
      id: "user_test_lot",
      name: "用户测试停车场",
      address: "测试路 2 号",
      latitude: 31.1,
      longitude: 121.1,
      owner_openid: owner.id,
      owner_nickname: owner.nickname,
      availability: "few",
      entrance_tip: "入口",
      pricing: { freeMinutes: 0, billingUnitMinutes: 60, unitPrice: 5 },
      evidence_photos: ["https://example.com/photo.jpg"],
      upvotes: 2,
      downvotes: 1,
      credibility: 67
    }];
  };
  api.getParkingLotDetail = async (id) => {
    calls.push(["getParkingLotDetail", id]);
    return {
      lot: {
        id,
        name: "详情停车场",
        address: "详情路",
        latitude: 31.2,
        longitude: 121.2,
        owner_openid: "other_user",
        availability: "plenty",
        pricing: { freeMinutes: 30, billingUnitMinutes: 60, unitPrice: 6 },
        upvotes: 1,
        downvotes: 0,
        credibility: 63
      },
      userVote: "up"
    };
  };
  api.createParkingLot = async (payload) => {
    calls.push(["createParkingLot", payload.name]);
    return { id: "created_lot", ...payload };
  };
  api.updateParkingLot = async (id, payload) => {
    calls.push(["updateParkingLot", id, payload.name]);
    return { id, ...payload };
  };
  api.voteParkingLot = async (id, type) => {
    calls.push(["voteParkingLot", id, type]);
    return { upvotes: 3, downvotes: 1, credibility: 69 };
  };

  try {
    const lots = await asyncGetAllParkingLots(31.1, 121.1, 3000);
    assert.strictEqual(lots.length, 1);
    assert.strictEqual(lots[0].canEdit, true);
    assert.strictEqual(lots[0].availability, "medium");
    assert.strictEqual(lots[0].location.latitude, 31.1);
    assert.strictEqual(lots[0].evidence.photos[0].uploadedUrl, "https://example.com/photo.jpg");
    assert.deepStrictEqual(calls[0], ["getParkingLots", 31.1, 121.1, 3000]);

    const detail = await asyncGetParkingLotDetail("detail_lot");
    assert.strictEqual(detail.lot.name, "详情停车场");
    assert.strictEqual(detail.lot.canEdit, false);
    assert.strictEqual(detail.userVote, "up");

    await asyncSaveUserParkingLot({ name: "新停车场" });
    await asyncUpdateUserParkingLot("detail_lot", { name: "已更新" });
    await asyncVoteParkingLot("detail_lot", "down");
    assert.deepStrictEqual(calls.slice(-3), [
      ["createParkingLot", "新停车场"],
      ["updateParkingLot", "detail_lot", "已更新"],
      ["voteParkingLot", "detail_lot", "down"]
    ]);
  } finally {
    Object.assign(api, originalApi);
  }

  const nextUser = updateCurrentUserProfile({
    nickName: "张三",
    avatarUrl: "https://example.com/avatar.png"
  });
  assert.strictEqual(nextUser.nickname, "张三");
  assert.strictEqual(nextUser.avatarText, "张");
  assert.strictEqual(nextUser.avatarUrl, "https://example.com/avatar.png");
}

async function testOnlineVehicleStorage() {
  const store = installWxStorageMock();
  store.parkingLoginState = { loggedAt: Date.now() };
  store.auth_token = "token";
  store.parkingCurrentUser = {
    id: "owner_2",
    nickname: "车主 C",
    avatarText: "C"
  };

  const originalApi = {
    getVehicles: api.getVehicles,
    addVehicle: api.addVehicle,
    updateVehicle: api.updateVehicle,
    deleteVehicle: api.deleteVehicle
  };
  const calls = [];

  api.getVehicles = async () => {
    calls.push(["getVehicles"]);
    return [
      { id: 1, plate: "苏D12345", type: "fuel" },
      { id: 2, plate: "苏D12345D", type: "new_energy" }
    ];
  };
  api.addVehicle = async (plate, type) => {
    calls.push(["addVehicle", plate, type]);
    return { id: 3, plate, type };
  };
  api.updateVehicle = async (id, plate, type) => {
    calls.push(["updateVehicle", id, plate, type]);
    return { id, plate, type };
  };
  api.deleteVehicle = async (id) => {
    calls.push(["deleteVehicle", id]);
    return true;
  };

  try {
    const vehicles = await asyncGetUserVehicles();
    assert.strictEqual(vehicles[0].plateNumber, "苏D12345");
    assert.strictEqual(vehicles[1].vehicleTypeLabel, "新能源小型车");
    assert.strictEqual(getCurrentVehicleId(), 1);

    setCurrentVehicleId(2);
    const current = await asyncGetCurrentVehicle();
    assert.strictEqual(current.plateNumber, "苏D12345D");

    const added = await asyncAddVehicle("苏D99999D", "new_energy");
    assert.strictEqual(added.vehicleType, "new_energy");

    const updated = await asyncUpdateVehicle(2, "苏D88888D", "new_energy");
    assert.strictEqual(updated.plateNumber, "苏D88888D");

    await asyncDeleteVehicle(2);
    assert.strictEqual(getCurrentVehicleId(), "");
    assert.deepStrictEqual(calls, [
      ["getVehicles"],
      ["getVehicles"],
      ["addVehicle", "苏D99999D", "new_energy"],
      ["updateVehicle", 2, "苏D88888D", "new_energy"],
      ["deleteVehicle", 2]
    ]);
  } finally {
    Object.assign(api, originalApi);
  }
}

function testVehicleNormalization() {
  const vehicles = normalizeVehicles([{ plate: "苏D1", type: "new_energy" }]);
  assert.strictEqual(vehicles[0].plateNumber, "苏D1");
  assert.strictEqual(vehicles[0].vehicleTypeLabel, "新能源小型车");
}

function testSelfHostedApiConfiguration() {
  const appJs = readProjectFile("app.js");
  const configJs = readProjectFile("config/api.js");
  const utilsApiJs = readProjectFile("utils/api.js");

  assert.strictEqual(apiConfig.baseUrl, "https://parking.kuaidianfanfan.com");
  assert.strictEqual(apiConfig.recognitionApiUrl, "https://parking.kuaidianfanfan.com/api/recognize-parking");
  assert.doesNotMatch(appJs, /wx\.cloud/);
  assert.doesNotMatch(configJs, /cloudbaseConfig|prod-d0g1zp7w0322a5d42|mini-parking-api/);
  assert.doesNotMatch(utilsApiJs, /callContainer|X-WX-SERVICE|wx\.cloud|upload-token/);
}

async function testApiErrorMetadata() {
  installWxStorageMock();
  global.wx.request = (options) => {
    options.success({
      statusCode: 401,
      data: {
        error: "unauthorized: missing or invalid token",
        code: "UNAUTHORIZED"
      }
    });
  };

  try {
    await assert.rejects(
      () => api.request("POST", "/api/parking-lots", {}),
      (error) => {
        assert.strictEqual(error.statusCode, 401);
        assert.strictEqual(error.code, "UNAUTHORIZED");
        assert.match(error.message, /unauthorized/);
        return true;
      }
    );
  } finally {
    delete global.wx.request;
  }
}

async function testRecognitionUsesSelfHostedRequest() {
  installWxStorageMock();
  wx.setStorageSync("auth_token", "signed-token");
  const calls = [];
  global.wx.request = (options) => {
    calls.push(options);
    options.success({
      statusCode: 200,
      data: { ok: true, recognition: { name: "自有服务器识别" } }
    });
  };

  try {
    const result = await api.requestParkingRecognition({
      photoRefs: [{
        uploadedUrl: "https://example.supabase.co/storage/v1/object/public/parking-evidence/evidence/photo.jpg",
        storageBucket: "parking-evidence",
        storagePath: "evidence/photo.jpg",
        mediaType: "image/jpeg"
      }]
    });

    assert.strictEqual(result.recognition.name, "自有服务器识别");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, "https://parking.kuaidianfanfan.com/api/recognize-parking");
    assert.strictEqual(calls[0].method, "POST");
    assert.strictEqual(calls[0].timeout, 60000);
    assert.strictEqual(calls[0].header.Authorization, "Bearer signed-token");
    assert.deepStrictEqual(calls[0].data.photoRefs[0].storagePath, "evidence/photo.jpg");
    assert.ok(calls[0].data.requestId);
  } finally {
    delete global.wx.request;
  }
}

async function testUploadUsesSelfHostedMultipartEndpoint() {
  installWxStorageMock();
  wx.setStorageSync("auth_token", "signed-token");
  const uploadCalls = [];
  global.wx.uploadFile = (options) => {
    uploadCalls.push(options);
    options.success({
      statusCode: 201,
      data: JSON.stringify({
        uploadedUrl: "https://example.supabase.co/storage/v1/object/public/parking-evidence/evidence/photo.jpg",
        storageBucket: "parking-evidence",
        storagePath: "evidence/photo.jpg"
      })
    });
  };

  try {
    const result = await api.uploadImage("/tmp/local-photo.jpg");
    assert.strictEqual(uploadCalls.length, 1);
    assert.strictEqual(uploadCalls[0].url, "https://parking.kuaidianfanfan.com/api/upload");
    assert.strictEqual(uploadCalls[0].filePath, "/tmp/local-photo.jpg");
    assert.strictEqual(uploadCalls[0].name, "file");
    assert.strictEqual(uploadCalls[0].header.Authorization, "Bearer signed-token");
    assert.strictEqual(uploadCalls[0].header["X-Request-Id"].startsWith("upload-"), true);
    assert.strictEqual(result.storagePath, "evidence/photo.jpg");
  } finally {
    delete global.wx.uploadFile;
  }
}

function requestNodeServer(server, options, body) {
  return new Promise((resolve, reject) => {
    const { Readable } = require("stream");
    const headers = {};
    Object.entries(options.headers || {}).forEach(([key, value]) => {
      headers[key.toLowerCase()] = value;
    });
    const payload = body
      ? [Buffer.isBuffer(body) ? body : Buffer.from(String(body))]
      : [];
    const req = Readable.from(payload);
    req.method = options.method || "GET";
    req.url = options.path;
    req.headers = headers;

    const chunks = [];
    const res = {
      statusCode: 200,
      headers: {},
      writeHead(statusCode, responseHeaders) {
        this.statusCode = statusCode;
        this.headers = responseHeaders || {};
      },
      write(chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      },
      end(chunk) {
        if (chunk) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({
            statusCode: this.statusCode,
            data: text ? JSON.parse(text) : {}
          });
        } catch (error) {
          reject(error);
        }
      }
    };

    server.emit("request", req, res);
  });
}

async function testServerRoutesRequireAuthAndLimitMultipart() {
  const { createAppServer } = require("../server/index");
  await withAuthEnv({
    AUTH_TOKEN_SECRET: "test-secret-for-hmac",
    AUTH_TOKEN_TTL_SECONDS: "60"
  }, async () => {
    const recognition = await requestNodeServer(
      createAppServer(),
      {
        path: "/api/recognize-parking",
        method: "POST",
        headers: { "content-type": "application/json" }
      },
      JSON.stringify({ photos: [] })
    );
    assert.strictEqual(recognition.statusCode, 401);
    assert.strictEqual(recognition.data.code, "UNAUTHORIZED");

    const token = generateToken("openid_1");
    const boundary = "----mini-parking-test-boundary";
    const largeBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      Buffer.alloc(8 * 1024 * 1024 + 1, "x"),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const upload = await requestNodeServer(
      createAppServer(),
      {
        path: "/api/upload",
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": largeBody.length
        }
      },
      largeBody
    );
    assert.strictEqual(upload.statusCode, 413);
    assert.strictEqual(upload.data.code, "BODY_TOO_LARGE");
  });
}

async function testAddPageRetriesPhotoUploadBeforeRecognition() {
  installWxStorageMock();
  const pagePath = require.resolve("../pages/add/add.js");
  const originalPage = global.Page;
  const originalUploadImage = api.uploadImage;
  const originalRequestParkingRecognition = api.requestParkingRecognition;
  let pageConfig = null;
  const uploadCalls = [];
  const recognitionCalls = [];

  global.Page = (config) => {
    pageConfig = config;
  };
  api.uploadImage = async (filePath) => {
    uploadCalls.push(filePath);
    return {
      uploadedUrl: "https://example.supabase.co/storage/v1/object/public/test-evidence/evidence/photo.jpg",
      storageBucket: "test-evidence",
      storagePath: "evidence/photo.jpg"
    };
  };
  api.requestParkingRecognition = async (payload, options) => {
    recognitionCalls.push({ payload, options });
    return {
      mode: "mock",
      recognition: {
        confidence: 80,
        pricing: {},
        location: {},
        warnings: []
      }
    };
  };
  global.wx.showToast = () => {};

  try {
    delete require.cache[pagePath];
    require(pagePath);

    const page = {
      data: {
        evidencePhotos: [{
          path: "/tmp/local-photo.jpg",
          localPath: "/tmp/local-photo.jpg"
        }],
        photoCount: 1,
        form: { name: "", address: "", notes: "" },
        isRecognizing: false,
        recognizeDisabled: false
      },
      setData(updates) {
        this.data = { ...this.data, ...updates };
      }
    };
    Object.keys(pageConfig).forEach((key) => {
      if (typeof pageConfig[key] === "function") {
        page[key] = pageConfig[key];
      }
    });

    await page.recognizeEvidence();

    assert.deepStrictEqual(uploadCalls, ["/tmp/local-photo.jpg"]);
    assert.strictEqual(page.data.evidencePhotos[0].uploaded, true);
    assert.strictEqual(page.data.evidencePhotos[0].storagePath, "evidence/photo.jpg");
    assert.strictEqual(recognitionCalls.length, 1);
    assert.strictEqual(recognitionCalls[0].payload.photoRefs.length, 1);
    assert.strictEqual(recognitionCalls[0].payload.photoRefs[0].storagePath, "evidence/photo.jpg");
  } finally {
    api.uploadImage = originalUploadImage;
    api.requestParkingRecognition = originalRequestParkingRecognition;
    if (originalPage) {
      global.Page = originalPage;
    } else {
      delete global.Page;
    }
    delete require.cache[pagePath];
  }
}

async function testSupabaseStorageUpload() {
  const originalBucket = process.env.SUPABASE_STORAGE_BUCKET;
  process.env.SUPABASE_STORAGE_BUCKET = "test-evidence";
  const calls = [];
  const mockSupabase = {
    storage: {
      async listBuckets() {
        calls.push(["listBuckets"]);
        return { data: [], error: null };
      },
      async createBucket(name, options) {
        calls.push(["createBucket", name, options.public, options.fileSizeLimit]);
        return { data: {}, error: null };
      },
      from(bucket) {
        return {
          async upload(objectPath, buffer, options) {
            calls.push(["upload", bucket, objectPath, buffer.toString("utf8"), options.contentType]);
            return { data: { path: objectPath }, error: null };
          },
          getPublicUrl(objectPath) {
            calls.push(["getPublicUrl", bucket, objectPath]);
            return {
              data: {
                publicUrl: `https://example.supabase.co/storage/v1/object/public/${bucket}/${objectPath}`
              }
            };
          }
        };
      }
    }
  };

  db.resetSupabaseForTests(mockSupabase);
  try {
    const result = await db.uploadEvidencePhoto({
      buffer: Buffer.from("jpg"),
      filename: "photo.jpeg",
      mediaType: "image/jpeg"
    });

    assert.strictEqual(result.storageBucket, "test-evidence");
    assert.match(result.storagePath, /^evidence\/\d{4}\/\d{2}\/\d+-[a-f0-9]+\.jpg$/);
    assert.strictEqual(result.url, result.uploadedUrl);
    assert.match(result.url, /^https:\/\/example\.supabase\.co\/storage\/v1\/object\/public\/test-evidence\/evidence\//);
    assert.deepStrictEqual(calls[0], ["listBuckets"]);
    assert.deepStrictEqual(calls[1], ["createBucket", "test-evidence", true, "10MB"]);
    assert.strictEqual(calls[2][0], "upload");
    assert.strictEqual(calls[2][1], "test-evidence");
    assert.strictEqual(calls[2][3], "jpg");
    assert.strictEqual(calls[2][4], "image/jpeg");
  } finally {
    db.resetSupabaseForTests();
    if (originalBucket === undefined) {
      delete process.env.SUPABASE_STORAGE_BUCKET;
    } else {
      process.env.SUPABASE_STORAGE_BUCKET = originalBucket;
    }
  }
}

async function testSenseNovaClient() {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({
      url,
      options,
      body: JSON.parse(options.body)
    });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [{
            message: {
              content: "{\"name\":\"模型停车场\",\"pricing\":{\"freeMinutes\":60,\"billingUnitMinutes\":60,\"unitPrice\":5}}"
            }
          }]
        });
      }
    };
  };

  try {
    const result = await recognizeWithSenseNovaApi({
      form: {
        name: "模型停车场"
      },
      photos: [{
        base64: "abc123",
        mediaType: "image/jpeg"
      }],
      textHint: "1 小时免费，之后每小时 5 元"
    }, {
      SENSENOVA_BASE_URL: "https://token.sensenova.cn",
      SENSENOVA_API_KEY: "sk-test",
      SENSENOVA_MODEL: "sensenova-6.7-flash-lite"
    });

    assert.strictEqual(result.name, "模型停车场");
    assert.strictEqual(result.pricing.freeMinutes, 60);
    assert.strictEqual(calls[0].url, "https://token.sensenova.cn/v1/chat/completions");
    assert.strictEqual(calls[0].options.headers.authorization, "Bearer sk-test");
    assert.strictEqual(calls[0].body.model, "sensenova-6.7-flash-lite");
    assert.deepStrictEqual(calls[0].body.response_format, { type: "json_object" });
    assert.strictEqual(calls[0].body.reasoning_effort, "none");
    assert.strictEqual(calls[0].body.messages[1].content[0].type, "text");
    assert.ok(!calls[0].body.messages[1].content[0].text.includes(LEGACY_POI_KEY));
    assert.strictEqual(calls[0].body.messages[1].content[1].type, "image_url");
    assert.strictEqual(calls[0].body.messages[1].content[1].image_url.url, "data:image/jpeg;base64,abc123");
  } finally {
    global.fetch = originalFetch;
  }
}

async function run() {
  testPricing();
  testRecommendation();
  testRecommendationSortingAndPaging();
  testUiLayoutStructure();
  testRecognitionParsing();
  testServerAuthHelpers();
  testTokenRequiredLoginState();
  await testOnlineParkingStorage();
  await testOnlineVehicleStorage();
  testVehicleNormalization();
  testSelfHostedApiConfiguration();
  await testApiErrorMetadata();
  await testRecognitionUsesSelfHostedRequest();
  await testUploadUsesSelfHostedMultipartEndpoint();
  await testServerRoutesRequireAuthAndLimitMultipart();
  await testAddPageRetriesPhotoUploadBeforeRecognition();
  await testSupabaseStorageUpload();
  await testSenseNovaClient();
  console.log("all tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
