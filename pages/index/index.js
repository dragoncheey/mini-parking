const {
  RECOMMENDATION_PAGE_SIZE,
  paginateRecommendations,
  recommendParkingLots,
  sortRecommendationsByMode
} = require("../../utils/recommendation");
const {
  getLoggedInUser,
  asyncGetAllParkingLots,
  asyncGetCurrentVehicle
} = require("../../utils/storage");
const { formatDuration } = require("../../utils/pricing");
const { openParkingLocation, requestCurrentLocation } = require("../../utils/location");

const app = getApp();
const DESTINATION_KEY = "parkingDestination";
const SEARCH_RADIUS_METERS = 3000;
const DEFAULT_DURATION_MINUTES = 30;
const MIN_DURATION_MINUTES = 1;
const MAX_DURATION_DAYS = 7;
const MAX_DURATION_MINUTES = (MAX_DURATION_DAYS * 24 * 60) + (23 * 60) + 59;

const recommendationSortOptions = [
  { value: "comprehensive", label: "综合推荐" },
  { value: "price", label: "价格最低" },
  { value: "distance", label: "离得最近" }
];

const parkingScopeOptions = [
  { value: "all", label: "全部类型" },
  { value: "offstreet", label: "停车场/车库" },
  { value: "street", label: "路边停车" }
];

const durationQuickOptions = [
  { value: 30, label: "30分钟" },
  { value: 60, label: "1小时" },
  { value: 120, label: "2小时" },
  { value: 240, label: "4小时" },
  { value: 480, label: "8小时" },
  { value: 1440, label: "1天" }
];

function buildDurationOptions(maxValue, unit, pad) {
  return Array.from({ length: maxValue + 1 }, (_, value) => ({
    value,
    label: pad ? `${value}`.padStart(2, "0") : `${value}`,
    unit
  }));
}

const durationDayOptions = buildDurationOptions(MAX_DURATION_DAYS, "天", false);
const durationHourOptions = buildDurationOptions(23, "时", true);
const durationMinuteOptions = buildDurationOptions(59, "分", true);

function normalizeDurationMinutes(durationMinutes) {
  const number = Number(durationMinutes);
  const rawMinutes = Number.isFinite(number) ? Math.round(number) : DEFAULT_DURATION_MINUTES;
  return Math.min(MAX_DURATION_MINUTES, Math.max(MIN_DURATION_MINUTES, rawMinutes));
}

function durationMinutesToPickerValue(durationMinutes) {
  const safeMinutes = normalizeDurationMinutes(durationMinutes);
  const days = Math.floor(safeMinutes / 1440);
  const restAfterDays = safeMinutes % 1440;
  const hours = Math.floor(restAfterDays / 60);
  const minutes = restAfterDays % 60;
  return [days, hours, minutes];
}

function pickerValueToDurationMinutes(value) {
  const pickerValue = Array.isArray(value) ? value : [];
  const days = Number(pickerValue[0]) || 0;
  const hours = Number(pickerValue[1]) || 0;
  const minutes = Number(pickerValue[2]) || 0;
  return normalizeDurationMinutes((days * 1440) + (hours * 60) + minutes);
}

function searchableText(parts) {
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function detectParkingType(lot) {
  const tags = lot && lot.access && Array.isArray(lot.access.tags)
    ? lot.access.tags.join(" ")
    : "";
  const text = searchableText([lot && lot.name, lot && lot.address, tags, lot && lot.access && lot.access.entrance]);

  if (text.indexOf("路侧") >= 0 || text.indexOf("路内") >= 0 || text.indexOf("路边") >= 0 || text.indexOf("公共停车点") >= 0) {
    return "street";
  }
  if (text.indexOf("室内") >= 0 || text.indexOf("地下") >= 0 || text.indexOf("停车楼") >= 0 || text.indexOf("停车场") >= 0) {
    return "offstreet";
  }
  return "unknown";
}

function decorateRecommendation(lot) {
  const parkingType = detectParkingType(lot);
  return {
    ...lot,
    parkingType,
    parkingTypeText: parkingType === "street" ? "路内" : "路外",
    parkingTypeClass: parkingType === "street" ? "is-street" : "is-offstreet"
  };
}

function filterLotsByScope(lots, scope) {
  if (scope === "all") return lots;
  return lots.filter((lot) => detectParkingType(lot) === scope);
}

function getRecommendationSortText(mode) {
  const option = recommendationSortOptions.find((item) => item.value === mode);
  return option ? option.label : recommendationSortOptions[0].label;
}

function sortAndDecorateRecommendations(recommendations, mode) {
  return sortRecommendationsByMode(recommendations, mode).map(decorateRecommendation);
}

function buildVisibleRecommendationState(recommendations, limit) {
  const page = paginateRecommendations(recommendations, limit, RECOMMENDATION_PAGE_SIZE);
  return {
    visibleRecommendations: page.items,
    visibleRecommendationLimit: page.items.length || RECOMMENDATION_PAGE_SIZE,
    hasMoreRecommendations: page.hasMore
  };
}


function getScopeText(scope) {
  const option = parkingScopeOptions.find((item) => item.value === scope);
  return option ? option.label : parkingScopeOptions[0].label;
}

function isQuickDuration(minutes) {
  return durationQuickOptions.some((item) => item.value === minutes);
}

function priceBubbleText(lot) {
  return lot.fee === 0 ? "免费" : `¥${lot.fee}`;
}

const MAX_MAP_LOTS = 12;
const DESTINATION_MARKER_ID = 1;

Page({
  data: {
    isLoggedIn: false,
    userAvatarUrl: "",
    userAvatarText: "我",
    recommendationSortOptions,
    durationQuickOptions,
    recommendationSortMode: "comprehensive",
    parkingScope: "all",
    parkingScopeText: getScopeText("all"),
    mapTall: false,
    durationPickerRanges: [durationDayOptions, durationHourOptions, durationMinuteOptions],
    durationPickerValue: durationMinutesToPickerValue(DEFAULT_DURATION_MINUTES),
    durationMinutes: DEFAULT_DURATION_MINUTES,
    durationText: "30分钟",
    isCustomDuration: false,
    locating: false,
    hasLocation: false,
    hasDestination: false,
    destinationName: "正在定位",
    currentVehicle: null,
    currentVehicleText: "",
    mapLatitude: 31.23041,
    mapLongitude: 121.4737,
    mapScale: 14,
    mapMarkers: [],
    mapPoints: [],
    recommendations: [],
    visibleRecommendations: [],
    visibleRecommendationLimit: RECOMMENDATION_PAGE_SIZE,
    hasRecommendations: false,
    hasMoreRecommendations: false,
    cheapestFeeText: "",
    selectedLotId: "",
    scrollIntoId: "",
    emptyTitle: "正在定位",
    emptyText: "定位成功后会自动推荐附近停车场。",
    loading: false,
    refreshing: false
  },

  onLoad(query) {
    this.markerLotIds = {};
    this._lots = null;
    this._bootstrapping = true;
    this.restoreLogin();
    this.syncDuration(Number(query.duration) || app.globalData.durationMinutes || DEFAULT_DURATION_MINUTES);
    this.refreshVehicle()
      .then(() => this.locateCurrentDestination({ showToast: false }))
      .finally(() => {
        this._bootstrapping = false;
      });
  },

  onShow() {
    this.restoreLogin();
    if (this._bootstrapping) return;
    const previousVehicleType = this.data.currentVehicle ? this.data.currentVehicle.vehicleType : "";
    this.refreshVehicle().then(() => {
      const vehicleType = this.data.currentVehicle ? this.data.currentVehicle.vehicleType : "";
      // 从录入页返回时需要重新拉取；仅切换车辆时用已加载数据重算即可
      if (app.globalData.parkingLotsDirty) {
        app.globalData.parkingLotsDirty = false;
        return this.refreshRecommendations();
      }
      if (vehicleType !== previousVehicleType) {
        return this.rebuildRecommendationsFromLoadedLots();
      }
      return null;
    });
  },

  onListRefresh() {
    this.setData({ refreshing: true });
    this.refreshRecommendations().finally(() => {
      this.setData({ refreshing: false });
    });
  },

  restoreLogin() {
    const user = getLoggedInUser();
    this.setData({
      isLoggedIn: Boolean(user),
      userAvatarUrl: user ? (user.avatarUrl || "") : "",
      userAvatarText: user ? (user.avatarText || (user.nickname || "我").slice(0, 1)) : "我"
    });
  },

  async refreshVehicle() {
    if (!getLoggedInUser()) {
      app.globalData.currentVehicle = null;
      this.setData({ currentVehicle: null, currentVehicleText: "" });
      return;
    }

    try {
      const vehicle = await asyncGetCurrentVehicle();
      app.globalData.currentVehicle = vehicle;
      this.setData({
        currentVehicle: vehicle,
        currentVehicleText: vehicle ? `${vehicle.plateNumber}（${vehicle.vehicleTypeLabel}）` : ""
      });
    } catch (error) {
      console.error("refreshVehicle error:", error.message);
      app.globalData.currentVehicle = null;
      this.setData({ currentVehicle: null, currentVehicleText: "" });
    }
  },

  syncDuration(durationMinutes) {
    const safeMinutes = normalizeDurationMinutes(durationMinutes);
    app.globalData.durationMinutes = safeMinutes;
    this.setData({
      durationMinutes: safeMinutes,
      durationText: formatDuration(safeMinutes),
      durationPickerValue: durationMinutesToPickerValue(safeMinutes),
      isCustomDuration: !isQuickDuration(safeMinutes)
    });
  },

  clearRecommendations(extra) {
    this.markerLotIds = {};
    this._lots = [];
    this.setData({
      recommendations: [],
      visibleRecommendations: [],
      visibleRecommendationLimit: RECOMMENDATION_PAGE_SIZE,
      hasRecommendations: false,
      hasMoreRecommendations: false,
      cheapestFeeText: "",
      selectedLotId: "",
      mapMarkers: [],
      mapPoints: [],
      ...extra
    });
  },

  async refreshRecommendations() {
    const destination = app.globalData.destination;
    if (!destination) {
      this.clearRecommendations({
        hasDestination: false,
        emptyTitle: this.data.locating ? "正在定位" : "先选一个目的地",
        emptyText: this.data.locating
          ? "定位成功后会自动推荐附近停车场。"
          : "告诉我们你要去哪儿，会在目的地 3 公里内找最划算的停车场。"
      });
      return;
    }

    this.setData({ loading: true });
    let lots;
    try {
      lots = await asyncGetAllParkingLots(destination.latitude, destination.longitude, SEARCH_RADIUS_METERS);
    } catch (e) {
      console.error("refreshRecommendations error:", e.message);
      this.clearRecommendations({
        emptyTitle: "加载失败",
        emptyText: "网络或服务暂时不可用，下拉列表可重试。"
      });
      wx.showToast({ title: "加载失败，请检查网络", icon: "none" });
      return;
    } finally {
      this.setData({ loading: false });
    }

    this._lots = lots;
    this.applyRecommendationLots(lots, destination);
  },

  applyRecommendationLots(lots, destination) {
    const scopedLots = filterLotsByScope(lots, this.data.parkingScope);
    const baseRecommendations = recommendParkingLots({
      lots: scopedLots,
      durationMinutes: this.data.durationMinutes,
      destination,
      searchRadiusMeters: SEARCH_RADIUS_METERS,
      vehicleType: this.data.currentVehicle ? this.data.currentVehicle.vehicleType : "",
      preferences: { walkMinuteValue: 0.8 }
    });
    this.applyRecommendations(sortAndDecorateRecommendations(baseRecommendations, this.data.recommendationSortMode), destination);
  },

  applyRecommendations(recommendations, destination) {
    const cheapest = recommendations.reduce(
      (min, item) => (min === null || item.fee < min.fee ? item : min),
      null
    );
    const filtered = this.data.parkingScope !== "all";
    this.setData({
      hasLocation: Boolean(app.globalData.userLocation),
      hasDestination: true,
      recommendations,
      ...buildVisibleRecommendationState(recommendations, RECOMMENDATION_PAGE_SIZE),
      hasRecommendations: recommendations.length > 0,
      cheapestFeeText: cheapest ? cheapest.feeText : "",
      selectedLotId: "",
      scrollIntoId: "",
      emptyTitle: "附近还没有停车场数据",
      emptyText: filtered
        ? `目的地 3 公里内没有「${this.data.parkingScopeText}」，换个类型看看。`
        : "目的地 3 公里内暂无收录。去过附近的话，欢迎分享一个停车场。",
      ...this.buildMapState(destination, recommendations, "")
    });
  },

  rebuildRecommendationsFromLoadedLots() {
    const destination = app.globalData.destination;
    if (!destination || !Array.isArray(this._lots)) {
      return this.refreshRecommendations();
    }
    this.applyRecommendationLots(this._lots, destination);
    return Promise.resolve();
  },

  buildMarkers(destination, recommendations, selectedLotId) {
    const markers = [{
      id: DESTINATION_MARKER_ID,
      latitude: Number(destination.latitude),
      longitude: Number(destination.longitude),
      title: destination.name || "目的地",
      width: 30,
      height: 30,
      zIndex: 99,
      callout: {
        content: destination.name && destination.name !== "当前位置" ? destination.name : "目的地",
        color: "#ffffff",
        bgColor: "#17201e",
        fontSize: 12,
        padding: 6,
        borderRadius: 12,
        display: "ALWAYS"
      }
    }];
    const markerLotIds = {};

    recommendations.slice(0, MAX_MAP_LOTS).forEach((lot, index) => {
      const markerId = index + 2;
      const selected = lot.id === selectedLotId;
      const highlight = selected || (!selectedLotId && lot.isBest);
      markerLotIds[markerId] = lot.id;
      markers.push({
        id: markerId,
        latitude: Number(lot.location.latitude),
        longitude: Number(lot.location.longitude),
        title: lot.name,
        width: highlight ? 24 : 18,
        height: highlight ? 32 : 24,
        zIndex: selected ? 98 : 50 - index,
        callout: {
          content: priceBubbleText(lot),
          color: highlight ? "#ffffff" : "#17201e",
          bgColor: highlight ? "#1a7f64" : "#ffffff",
          borderColor: highlight ? "#1a7f64" : "#d5ddda",
          borderWidth: 1,
          fontSize: highlight ? 14 : 12,
          padding: 6,
          borderRadius: 14,
          textAlign: "center",
          display: "ALWAYS"
        }
      });
    });

    this.markerLotIds = markerLotIds;
    return markers;
  },

  buildMapState(destination, recommendations, selectedLotId) {
    const points = [{ latitude: Number(destination.latitude), longitude: Number(destination.longitude) }];
    recommendations.slice(0, MAX_MAP_LOTS).forEach((lot) => {
      points.push({ latitude: Number(lot.location.latitude), longitude: Number(lot.location.longitude) });
    });
    return {
      mapLatitude: Number(destination.latitude),
      mapLongitude: Number(destination.longitude),
      mapScale: 15,
      mapMarkers: this.buildMarkers(destination, recommendations, selectedLotId),
      mapPoints: points
    };
  },

  selectLot(lotId) {
    const destination = app.globalData.destination;
    if (!destination || !lotId) return;
    const index = this.data.recommendations.findIndex((lot) => lot.id === lotId);
    if (index < 0) return;
    const extra = index >= this.data.visibleRecommendations.length
      ? buildVisibleRecommendationState(this.data.recommendations, index + 1)
      : {};
    this.setData({
      ...extra,
      selectedLotId: lotId,
      scrollIntoId: `lot-${lotId}`,
      mapMarkers: this.buildMarkers(destination, this.data.recommendations, lotId)
    });
  },

  onMarkerTap(event) {
    const lotId = this.markerLotIds[event.detail.markerId];
    if (!lotId) return;
    if (lotId === this.data.selectedLotId) {
      this.navigateToDetail(lotId);
      return;
    }
    this.selectLot(lotId);
  },

  toggleMapSize() {
    this.setData({ mapTall: !this.data.mapTall });
  },

  setRecommendationSortMode(event) {
    const mode = event.currentTarget.dataset.mode;
    if (!mode || mode === this.data.recommendationSortMode) return;
    this.setData({ recommendationSortMode: mode }, () => {
      if (!this.data.hasDestination) return;
      const recommendations = sortAndDecorateRecommendations(this.data.recommendations, mode);
      this.applyRecommendations(recommendations, app.globalData.destination);
    });
  },

  chooseParkingScope() {
    wx.showActionSheet({
      itemList: parkingScopeOptions.map((item) => item.label),
      success: (res) => {
        const option = parkingScopeOptions[res.tapIndex];
        if (!option || option.value === this.data.parkingScope) return;
        this.setData({
          parkingScope: option.value,
          parkingScopeText: option.label
        }, () => this.rebuildRecommendationsFromLoadedLots());
      }
    });
  },

  loadMoreRecommendations() {
    if (!this.data.hasMoreRecommendations) return;
    const nextLimit = this.data.visibleRecommendationLimit + RECOMMENDATION_PAGE_SIZE;
    this.setData(buildVisibleRecommendationState(this.data.recommendations, nextLimit));
  },

  applyDestination(destination) {
    this.setData({
      hasDestination: true,
      destinationName: destination.name || "已选目的地",
      mapLatitude: Number(destination.latitude),
      mapLongitude: Number(destination.longitude)
    });
  },

  setDestination(destination, options) {
    const setOptions = options || {};
    if (setOptions.source !== "location") {
      this._manualDestinationAt = Date.now();
    }
    app.globalData.destination = destination;
    if (setOptions.persist !== false) {
      wx.setStorageSync(DESTINATION_KEY, destination);
    }
    this.applyDestination(destination);
    return this.refreshRecommendations();
  },

  async locateCurrentDestination(options) {
    const locateOptions = options || {};
    const startedAt = Date.now();
    const previousDestination = app.globalData.destination;
    this.setData({
      locating: true,
      emptyTitle: "正在定位",
      emptyText: "定位成功后会自动推荐附近停车场。"
    });

    try {
      const res = await requestCurrentLocation({ type: "gcj02" });
      app.globalData.userLocation = { latitude: res.latitude, longitude: res.longitude };
      if (!locateOptions.force && this._manualDestinationAt && this._manualDestinationAt > startedAt) {
        this.setData({ hasLocation: true, locating: false });
        return;
      }
      this.setData({ hasLocation: true, locating: false });
      await this.setDestination({
        name: "当前位置",
        address: "",
        latitude: res.latitude,
        longitude: res.longitude
      }, { source: "location" });
      if (locateOptions.showToast) {
        wx.showToast({ title: "已切换到当前位置", icon: "none" });
      }
    } catch (error) {
      console.error("locateCurrentDestination error:", error && error.errMsg ? error.errMsg : error);
      app.globalData.userLocation = null;
      this.setData({
        hasLocation: false,
        locating: false,
        destinationName: "点此选择目的地",
        emptyTitle: "没拿到你的位置",
        emptyText: "可以直接选择目的地，也可以在设置里打开定位权限后点地图右下角重试。"
      });
      const savedDestination = wx.getStorageSync(DESTINATION_KEY);
      const fallbackDestination = previousDestination || savedDestination;
      if (fallbackDestination && fallbackDestination.latitude && fallbackDestination.longitude) {
        app.globalData.destination = fallbackDestination;
        this.applyDestination(fallbackDestination);
        await this.refreshRecommendations();
      }
      if (locateOptions.showToast) {
        wx.showToast({ title: "无法获取定位", icon: "none" });
      }
    }
  },

  chooseDestination() {
    const current = app.globalData.destination || app.globalData.userLocation || {};
    const chooseOptions = {
      success: (res) => {
        this.setDestination({
          name: res.name || "已选目的地",
          address: res.address || "",
          latitude: res.latitude,
          longitude: res.longitude
        });
      },
      fail: (error) => {
        if (error && error.errMsg && error.errMsg.indexOf("cancel") >= 0) return;
        wx.showToast({ title: "打开地图选点失败", icon: "none" });
      }
    };
    const latitude = Number(current.latitude);
    const longitude = Number(current.longitude);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      chooseOptions.latitude = latitude;
      chooseOptions.longitude = longitude;
    }
    wx.chooseLocation(chooseOptions);
  },

  selectDurationPreset(event) {
    const minutes = Number(event.currentTarget.dataset.minutes);
    if (!Number.isFinite(minutes) || minutes === this.data.durationMinutes) return;
    this.syncDuration(minutes);
    this.rebuildRecommendationsFromLoadedLots();
  },

  onDurationNativeChange(event) {
    this.syncDuration(pickerValueToDurationMinutes(event.detail.value));
    this.rebuildRecommendationsFromLoadedLots();
  },

  useCurrentLocationAsDestination() {
    this.locateCurrentDestination({ showToast: true, force: true });
  },

  findLoadedLot(id) {
    return (this._lots || []).find((lot) => lot.id === id)
      || this.data.recommendations.find((lot) => lot.id === id)
      || null;
  },

  openNavigation(event) {
    const lot = this.findLoadedLot(event.currentTarget.dataset.id);
    if (lot) openParkingLocation(lot);
  },

  navigateToDetail(id) {
    wx.navigateTo({
      url: `/pages/detail/detail?id=${id}&duration=${this.data.durationMinutes}`
    });
  },

  goDetail(event) {
    this.navigateToDetail(event.currentTarget.dataset.id);
  },

  goAdd() {
    if (!getLoggedInUser()) {
      wx.showModal({
        title: "登录后才能分享",
        content: "分享的停车场会标记你的头像昵称作为数据来源。",
        confirmText: "去登录",
        success: (res) => {
          if (res.confirm) wx.navigateTo({ url: "/pages/profile/profile" });
        }
      });
      return;
    }
    wx.navigateTo({ url: "/pages/add/add" });
  },

  goProfile() {
    wx.navigateTo({ url: "/pages/profile/profile" });
  },

  goVehicles() {
    if (!getLoggedInUser()) {
      wx.navigateTo({ url: "/pages/profile/profile" });
      return;
    }
    wx.navigateTo({ url: "/pages/vehicles/vehicles" });
  },

  onShareAppMessage() {
    const name = this.data.destinationName;
    return {
      title: name && name !== "当前位置" ? `${name} 附近哪里停车便宜` : "附近哪里停车便宜",
      path: `/pages/index/index?duration=${this.data.durationMinutes}`
    };
  }
});
