const assert = require("assert");
const { seedParkingLots } = require("../data/seedParking");
const { calculateParkingFee, calculateParkingFeeForVehicle } = require("../utils/pricing");
const { recommendParkingLots } = require("../utils/recommendation");
const { buildMockRecognition, normalizeRecognition, parseJsonFromText } = require("../utils/recognition");
const { recognizeWithSenseNovaApi } = require("../server/modelClient");
const {
  findParkingLot,
  getAllParkingLots,
  getCurrentVehicle,
  saveUserParkingLot,
  saveUserVehicle,
  setCurrentVehicle,
  updateCurrentUserProfile,
  updateUserParkingLot,
  voteParkingLot
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

function installWxStorageMock() {
  const store = {};
  global.wx = {
    getStorageSync(key) {
      return store[key];
    },
    setStorageSync(key, value) {
      store[key] = value;
    }
  };
  return store;
}

function testUserOwnershipAndVotes() {
  const store = installWxStorageMock();
  const owner = {
    id: "owner_1",
    nickname: "车主 A",
    avatarText: "A",
    avatarColor: "#166a5b"
  };
  const reviewer = {
    id: "reviewer_1",
    nickname: "车主 B",
    avatarText: "B",
    avatarColor: "#435268"
  };

  store.parkingLoginState = { loggedAt: Date.now() };
  store.parkingCurrentUser = owner;
  saveUserParkingLot({
    id: "user_test_lot",
    name: "用户测试停车场",
    address: "测试路 2 号",
    source: "user",
    ownerId: owner.id,
    owner,
    updatedAt: "2026-06-14",
    confidence: 68,
    availability: "medium",
    location: {
      latitude: 31.1,
      longitude: 121.1,
      amap: {}
    },
    access: {
      entrance: "入口",
      walkingPenaltyMinutes: 0,
      tags: []
    },
    pricing: {
      freeMinutes: 0,
      billingUnitMinutes: 60,
      unitPrice: 5,
      maxDailyPrice: 0,
      minCharge: 0,
      notes: ""
    },
    evidence: {
      photos: []
    }
  });

  assert.throws(() => voteParkingLot("user_test_lot", "up"), /OWNER_VOTE_FORBIDDEN/);
  assert.strictEqual(findParkingLot("user_test_lot").canEdit, true);

  store.parkingCurrentUser = reviewer;
  voteParkingLot("user_test_lot", "up");
  assert.strictEqual(findParkingLot("user_test_lot").voteStats.up, 1);
  assert.strictEqual(findParkingLot("user_test_lot").confidence, 72);
  assert.strictEqual(findParkingLot("user_test_lot").canEdit, false);

  assert.strictEqual(updateUserParkingLot("user_test_lot", { name: "非本人修改" }), false);
  assert.strictEqual(findParkingLot("user_test_lot").name, "用户测试停车场");

  store.parkingCurrentUser = owner;
  assert.strictEqual(updateUserParkingLot("user_test_lot", { name: "已维护停车场" }), true);
  const updated = findParkingLot("user_test_lot");
  assert.strictEqual(updated.name, "已维护停车场");
  assert.strictEqual(updated.rawConfidence, 50);
  assert.strictEqual(updated.voteStats.total, 0);
  assert.strictEqual(getAllParkingLots().some((lot) => lot.id === "user_test_lot"), true);

  const nextUser = updateCurrentUserProfile({
    nickName: "张三",
    avatarUrl: "https://example.com/avatar.png"
  });
  assert.strictEqual(nextUser.nickname, "张三");
  assert.strictEqual(nextUser.avatarText, "张");
  assert.strictEqual(nextUser.avatarUrl, "https://example.com/avatar.png");
}

function testVehicleStorage() {
  const store = installWxStorageMock();
  store.parkingLoginState = { loggedAt: Date.now() };
  store.parkingCurrentUser = {
    id: "owner_2",
    nickname: "车主 C",
    avatarText: "C"
  };

  const fuel = saveUserVehicle({
    plateNumber: "苏D12345",
    vehicleType: "fuel"
  });
  const newEnergy = saveUserVehicle({
    plateNumber: "苏D12345D",
    vehicleType: "new_energy"
  });

  assert.strictEqual(getCurrentVehicle().id, fuel.id);
  assert.strictEqual(setCurrentVehicle(newEnergy.id).vehicleType, "new_energy");
  assert.strictEqual(getCurrentVehicle().plateNumber, "苏D12345D");
  assert.throws(() => saveUserVehicle({ plateNumber: "苏D12345D", vehicleType: "new_energy" }), /PLATE_DUPLICATED/);
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
  testUserOwnershipAndVotes();
  testVehicleStorage();
  await testSenseNovaClient();
  console.log("all tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
