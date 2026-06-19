const seedParkingLots = [
  {
    id: "mall-free-60",
    name: "星河广场地下停车场",
    address: "示例市中心路 88 号 B2 停车场",
    source: "manual",
    updatedAt: "2026-06-01",
    confidence: 88,
    availability: "medium",
    distanceHintMeters: 420,
    location: {
      latitude: 31.23041,
      longitude: 121.4737,
      amap: {
        poiId: "B0FFEXAMPLE01",
        cityCode: "021",
        name: "星河广场地下停车场"
      }
    },
    access: {
      entrance: "商场东门旁下坡入口",
      walkingPenaltyMinutes: 1,
      tags: ["商场", "室内", "入口好找"]
    },
    pricing: {
      chargeType: "hourly",
      freeMinutes: 60,
      billingUnitMinutes: 60,
      unitPrice: 5,
      maxDailyPrice: 45,
      minCharge: 0,
      notes: "入场后 1 小时免费，之后按小时计费。"
    }
  },
  {
    id: "office-half-hour",
    name: "宏运大厦停车场",
    address: "示例市金融街 18 号",
    source: "manual",
    updatedAt: "2026-05-28",
    confidence: 76,
    availability: "high",
    distanceHintMeters: 260,
    location: {
      latitude: 31.23208,
      longitude: 121.47665,
      amap: {
        poiId: "B0FFEXAMPLE02",
        cityCode: "021",
        name: "宏运大厦停车场"
      }
    },
    access: {
      entrance: "写字楼南侧入口，晚高峰排队较少",
      walkingPenaltyMinutes: 0,
      tags: ["近", "车位较稳"]
    },
    pricing: {
      chargeType: "hourly",
      freeMinutes: 30,
      billingUnitMinutes: 30,
      unitPrice: 3,
      maxDailyPrice: 50,
      minCharge: 0,
      notes: "半小时免费，之后每半小时 3 元。",
      pricingByVehicle: {
        new_energy: {
          freeMinutes: 120,
          notes: "新能源小型车 2 小时免费，之后按停车场默认规则计费。"
        }
      }
    }
  },
  {
    id: "street-low-fee",
    name: "滨河路公共停车点",
    address: "示例市滨河路与桂花巷交叉口",
    source: "user",
    updatedAt: "2026-05-19",
    confidence: 62,
    availability: "low",
    distanceHintMeters: 180,
    location: {
      latitude: 31.22882,
      longitude: 121.47091,
      amap: {
        poiId: "B0FFEXAMPLE03",
        cityCode: "021",
        name: "滨河路公共停车点"
      }
    },
    access: {
      entrance: "路侧泊位，入口无闸机",
      walkingPenaltyMinutes: 2,
      tags: ["露天", "可能满位"]
    },
    pricing: {
      chargeType: "hourly",
      freeMinutes: 0,
      billingUnitMinutes: 60,
      unitPrice: 4,
      maxDailyPrice: 32,
      minCharge: 4,
      notes: "路侧泊位按小时计费，车位波动较大。"
    }
  },
  {
    id: "hospital-ladder",
    name: "安和医院停车楼",
    address: "示例市康宁路 9 号",
    source: "manual",
    updatedAt: "2026-05-10",
    confidence: 81,
    availability: "medium",
    distanceHintMeters: 620,
    location: {
      latitude: 31.22696,
      longitude: 121.47822,
      amap: {
        poiId: "B0FFEXAMPLE04",
        cityCode: "021",
        name: "安和医院停车楼"
      }
    },
    access: {
      entrance: "急诊楼西侧入口，白天车流较密",
      walkingPenaltyMinutes: 3,
      tags: ["室内", "高峰拥堵"]
    },
    pricing: {
      chargeType: "ladder",
      freeMinutes: 15,
      maxDailyPrice: 60,
      ladder: [
        {
          untilMinutes: 120,
          billingUnitMinutes: 30,
          unitPrice: 4
        },
        {
          untilMinutes: null,
          billingUnitMinutes: 60,
          unitPrice: 6
        }
      ],
      notes: "15 分钟内免费，前 2 小时每半小时 4 元，之后每小时 6 元。"
    }
  },
  {
    id: "park-flat-24h",
    name: "会展中心临时停车场",
    address: "示例市会展路 2 号",
    source: "manual",
    updatedAt: "2026-06-10",
    confidence: 72,
    availability: "medium",
    distanceHintMeters: 540,
    location: {
      latitude: 31.23148,
      longitude: 121.4688,
      amap: {
        poiId: "B0FFEXAMPLE05",
        cityCode: "021",
        name: "会展中心临时停车场"
      }
    },
    access: {
      entrance: "北侧临时入口，活动日排队",
      walkingPenaltyMinutes: 1,
      tags: ["露天", "按次"]
    },
    pricing: {
      chargeType: "flat",
      freeMinutes: 0,
      flatDurationMinutes: 1440,
      flatPrice: 20,
      flatRepeat: true,
      maxDailyPrice: 20,
      minCharge: 0,
      notes: "24 小时 20 元，超过 24 小时重复计费。"
    }
  }
];

module.exports = {
  seedParkingLots
};
