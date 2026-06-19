const assert = require("assert");
const { seedParkingLots } = require("../data/seedParking");
const { calculateParkingFee, calculateParkingFeeForVehicle } = require("../utils/pricing");
const { recommendParkingLots } = require("../utils/recommendation");
const { buildMockRecognition, normalizeRecognition, parseJsonFromText } = require("../utils/recognition");
const { recognizeWithSenseNovaApi } = require("../server/modelClient");
const { extractCloudOpenid, extractOpenid, generateToken } = require("../server/auth");
const { cloudbaseConfig } = require("../config/api");
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

function testPricing() {
  assert.strictEqual(calculateParkingFee(60, seedParkingLots[0].pricing), 0);
  assert.strictEqual(calculateParkingFee(180, seedParkingLots[0].pricing), 10);
  assert.strictEqual(calculateParkingFee(180, seedParkingLots[1].pricing), 15);
  assert.strictEqual(calculateParkingFeeForVehicle(180, seedParkingLots[1].pricing, "new_energy"), 6);
  assert.strictEqual(calculateParkingFeeForVehicle(60, seedParkingLots[1].pricing, "new_energy"), 0);
  assert.strictEqual(calculateParkingFeeForVehicle(60, seedParkingLots[1].pricing, "fuel"), 3);
  assert.strictEqual(calculateParkingFee(180, seedParkingLots[3].pricing), 22);
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
  assert.strictEqual(mock.pricing.freeMinutes, 60);
  assert.strictEqual(mock.pricing.billingUnitMinutes, 60);
  assert.strictEqual(mock.pricing.unitPrice, 5);
  assert.strictEqual(mock.pricing.maxDailyPrice, 40);
}

function testServerAuthHelpers() {
  const token = generateToken("openid_1");
  assert.strictEqual(extractOpenid({ headers: { authorization: `Bearer ${token}` } }), "openid_1");
  assert.strictEqual(extractOpenid({ headers: {} }), null);
  assert.strictEqual(extractCloudOpenid({ headers: { "x-wx-openid": "cloud_openid" } }), "cloud_openid");
  assert.strictEqual(extractCloudOpenid({ headers: { "x-wx-from-openid": "from_openid" } }), "from_openid");
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

async function testApiErrorMetadata() {
  installWxStorageMock();
  const originalCloudbaseEnabled = cloudbaseConfig.enabled;
  cloudbaseConfig.enabled = false;
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
    cloudbaseConfig.enabled = originalCloudbaseEnabled;
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
    assert.strictEqual(calls[0].body.messages[1].content[1].type, "image_url");
    assert.strictEqual(calls[0].body.messages[1].content[1].image_url.url, "data:image/jpeg;base64,abc123");
  } finally {
    global.fetch = originalFetch;
  }
}

async function run() {
  testPricing();
  testRecommendation();
  testRecognitionParsing();
  testServerAuthHelpers();
  testTokenRequiredLoginState();
  await testOnlineParkingStorage();
  await testOnlineVehicleStorage();
  testVehicleNormalization();
  await testApiErrorMetadata();
  await testSenseNovaClient();
  console.log("all tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
