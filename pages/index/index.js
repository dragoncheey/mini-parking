const { buildRecommendationSummary, recommendParkingLots } = require("../../utils/recommendation");
const {
  getLoggedInUser,
  updateCurrentUserProfile,
  asyncGetAllParkingLots,
  asyncGetCurrentVehicle
} = require("../../utils/storage");
const api = require("../../utils/api");
const { formatDuration } = require("../../utils/pricing");
const { openParkingLocation } = require("../../utils/location");

const app = getApp();
const LOGIN_KEY = "parkingLoginState";
const CURRENT_USER_KEY = "parkingCurrentUser";
const DESTINATION_KEY = "parkingDestination";
const SEARCH_RADIUS_METERS = 3000;
const DEFAULT_DURATION_MINUTES = 30;
const MIN_DURATION_MINUTES = 1;
const MAX_DURATION_DAYS = 7;
const MAX_DURATION_MINUTES = (MAX_DURATION_DAYS * 24 * 60) + (23 * 60) + 59;

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

Page({
  data: {
    isLoggedIn: false,
    accountStatusText: "游客模式",
    accountActionText: "登录",
    accountStatusClass: "is-guest",
    durationDayOptions,
    durationHourOptions,
    durationMinuteOptions,
    durationPickerValue: durationMinutesToPickerValue(DEFAULT_DURATION_MINUTES),
    durationMinutes: DEFAULT_DURATION_MINUTES,
    durationText: "30分钟",
    hasLocation: false,
    hasDestination: false,
    destination: null,
    destinationName: "选择目的地",
    destinationAddress: "目的地 3 公里内推荐停车场",
    destinationKeyword: "",
    currentVehicle: null,
    currentVehicleText: "未设置车辆",
    currentVehicleHint: "默认按停车场基础规则计费",
    searchKeyword: "",
    destinationMatches: [],
    hasDestinationMatches: false,
    parkingSearchResults: [],
    hasParkingSearchResults: false,
    mapLatitude: 31.23041,
    mapLongitude: 121.4737,
    mapScale: 14,
    mapMarkers: [],
    mapPoints: [],
    recommendations: [],
    hasRecommendations: false,
    summary: "登录后选择目的地，再按预计停车时长推荐 3 公里内更合适的停车场。",
    emptyText: "先选择目的地。系统会在目的地 3 公里内查找停车场。",
    loading: false
  },

  onLoad(query) {
    this.markerLotIds = {};
    this._lots = [];
    this.restoreLogin();
    this.restoreDestination();
    this.refreshVehicle().then(() => this.refreshRecommendations());
    this.syncDuration(Number(query.duration) || app.globalData.durationMinutes || DEFAULT_DURATION_MINUTES);
  },

  onShow() {
    this.refreshVehicle().then(() => this.refreshRecommendations());
  },

  onPullDownRefresh() {
    this.refreshRecommendations().then(() => wx.stopPullDownRefresh());
  },

  restoreLogin() {
    const state = wx.getStorageSync(LOGIN_KEY);
    if (state && state.loggedAt) {
      this.setData({
        isLoggedIn: true,
        accountStatusText: "已登录",
        accountActionText: "刷新",
        accountStatusClass: "is-authenticated"
      });
    }
  },

  restoreDestination() {
    const destination = wx.getStorageSync(DESTINATION_KEY);
    if (destination && destination.latitude && destination.longitude) {
      app.globalData.destination = destination;
      this.applyDestination(destination);
    }
  },

  login() {
    wx.login({
      success: (res) => {
        if (!res.code) {
          wx.showToast({ title: "登录失败", icon: "none" });
          return;
        }
        this.loginWithCode(res.code);
      },
      fail: () => {
        wx.showToast({ title: "登录失败", icon: "none" });
      }
    });
  },

  async loginWithCode(code) {
    this.setData({ loading: true });
    try {
      let userInfo = {};
      if (wx.getUserProfile) {
        try {
          const profileRes = await new Promise((resolve, reject) => {
            wx.getUserProfile({
              desc: "用于展示停车场数据来源头像",
              success: resolve,
              fail: reject
            });
          });
          if (profileRes.userInfo) {
            userInfo = {
              nickname: profileRes.userInfo.nickName,
              avatarUrl: profileRes.userInfo.avatarUrl
            };
            updateCurrentUserProfile(profileRes.userInfo);
          }
        } catch (e) {
          // User cancelled or not supported
        }
      }

      const loginResult = await api.login(code, userInfo);
      const token = loginResult.token;
      wx.setStorageSync("auth_token", token);
      app.globalData.authToken = token;

      if (loginResult.user) {
        const user = loginResult.user;
        wx.setStorageSync(CURRENT_USER_KEY, {
          id: user.openid || user.id || "",
          nickname: user.nickname || "用户",
          avatarUrl: user.avatar_url || user.avatarUrl || "",
          avatarText: (user.nickname || "我").slice(0, 1),
          avatarColor: "#166a5b",
          createdAt: Date.now()
        });
      }

      wx.setStorageSync(LOGIN_KEY, { loggedAt: Date.now() });
      this.setData({
        isLoggedIn: true,
        accountStatusText: "已登录",
        accountActionText: "刷新",
        accountStatusClass: "is-authenticated"
      });
      wx.showToast({ title: "已登录", icon: "success" });
      this.refreshRecommendations();
    } catch (error) {
      console.error("Login failed:", error.message);
      wx.showToast({ title: "登录失败，请检查网络", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  async refreshVehicle() {
    if (!getLoggedInUser()) {
      app.globalData.currentVehicle = null;
      this.setData({
        currentVehicle: null,
        currentVehicleText: "未设置车辆",
        currentVehicleHint: "默认按停车场基础规则计费"
      });
      return;
    }

    try {
      const vehicle = await asyncGetCurrentVehicle();
      app.globalData.currentVehicle = vehicle;
      this.setData({
        currentVehicle: vehicle,
        currentVehicleText: vehicle ? `${vehicle.plateNumber} · ${vehicle.vehicleTypeLabel}` : "未设置车辆",
        currentVehicleHint: vehicle ? "推荐已按当前车辆类型计费" : "默认按停车场基础规则计费"
      });
    } catch (error) {
      console.error("refreshVehicle error:", error.message);
      app.globalData.currentVehicle = null;
      this.setData({
        currentVehicle: null,
        currentVehicleText: "车辆加载失败",
        currentVehicleHint: "请检查线上接口后重试"
      });
    }
  },

  syncDuration(durationMinutes) {
    const safeMinutes = normalizeDurationMinutes(durationMinutes);

    app.globalData.durationMinutes = safeMinutes;
    this.setData({
      durationMinutes: safeMinutes,
      durationText: formatDuration(safeMinutes),
      durationPickerValue: durationMinutesToPickerValue(safeMinutes)
    });
  },

  async refreshRecommendations() {
    const destination = app.globalData.destination;
    this.refreshParkingSearchResults();
    if (!destination) {
      this.markerLotIds = {};
      this._lots = [];
      this.setData({
        hasDestination: false,
        recommendations: [],
        hasRecommendations: false,
        mapMarkers: [],
        mapPoints: [],
        summary: "登录后选择目的地，再按预计停车时长推荐 3 公里内更合适的停车场。",
        emptyText: "先选择目的地。系统会在目的地 3 公里内查找停车场。"
      });
      return;
    }

    this.setData({ loading: true });
    let lots;
    try {
      lots = await asyncGetAllParkingLots(destination.latitude, destination.longitude, SEARCH_RADIUS_METERS);
      this._lots = lots;
    } catch (e) {
      console.error("refreshRecommendations error:", e.message);
      this.markerLotIds = {};
      this._lots = [];
      this.setData({
        recommendations: [],
        hasRecommendations: false,
        mapMarkers: [],
        mapPoints: [],
        summary: "线上接口加载失败，请检查网络或后端服务。",
        emptyText: "线上接口加载失败，请稍后重试。"
      });
      wx.showToast({ title: "加载失败，请检查网络", icon: "none" });
      return;
    } finally {
      this.setData({ loading: false });
    }

    const keyword = this.data.searchKeyword.trim().toLowerCase();
    const filteredLots = lots.filter((lot) => this.matchLotKeyword(lot, keyword));
    const recommendations = recommendParkingLots({
      lots: filteredLots,
      durationMinutes: this.data.durationMinutes,
      destination,
      searchRadiusMeters: SEARCH_RADIUS_METERS,
      vehicleType: this.data.currentVehicle ? this.data.currentVehicle.vehicleType : "",
      preferences: { walkMinuteValue: 0.8 }
    });
    const mapState = this.buildMapState(destination, recommendations);

    this.setData({
      hasLocation: Boolean(app.globalData.userLocation),
      hasDestination: true,
      recommendations,
      hasRecommendations: recommendations.length > 0,
      summary: buildRecommendationSummary(recommendations),
      emptyText: "目的地 3 公里内没有匹配的停车场。可以清空筛选词，或先录入附近停车场。",
      ...mapState
    });
  },

  matchLotKeyword(lot, keyword) {
    if (!keyword) return true;
    const tags = lot.access && Array.isArray(lot.access.tags) ? lot.access.tags.join(" ") : "";
    return searchableText([lot.name, lot.address, tags, lot.pricing && lot.pricing.notes]).indexOf(keyword) >= 0;
  },

  async refreshParkingSearchResults() {
    const keyword = this.data.searchKeyword.trim().toLowerCase();
    if (!keyword) {
      this.setData({ parkingSearchResults: [], hasParkingSearchResults: false });
      return;
    }

    const destination = app.globalData.destination;
    const lots = this._lots || [];
    const results = recommendParkingLots({
      lots: lots.filter((lot) => this.matchLotKeyword(lot, keyword)),
      durationMinutes: this.data.durationMinutes,
      destination,
      searchRadiusMeters: destination ? SEARCH_RADIUS_METERS : 0,
      vehicleType: this.data.currentVehicle ? this.data.currentVehicle.vehicleType : "",
      preferences: { walkMinuteValue: 0.8 }
    }).slice(0, 5);

    this.setData({
      parkingSearchResults: results,
      hasParkingSearchResults: results.length > 0
    });
  },

  buildMapState(destination, recommendations) {
    const markers = [{
      id: 1,
      latitude: Number(destination.latitude),
      longitude: Number(destination.longitude),
      title: destination.name || "目的地",
      callout: {
        content: "目的地", color: "#ffffff", bgColor: "#166a5b",
        padding: 8, borderRadius: 4, display: "ALWAYS"
      }
    }];
    const points = [{ latitude: Number(destination.latitude), longitude: Number(destination.longitude) }];
    const markerLotIds = {};

    recommendations.slice(0, 8).forEach((lot, index) => {
      const markerId = index + 2;
      markerLotIds[markerId] = lot.id;
      markers.push({
        id: markerId,
        latitude: Number(lot.location.latitude),
        longitude: Number(lot.location.longitude),
        title: lot.name,
        callout: {
          content: `${lot.rank}. ${lot.name} ${lot.feeText}`,
          color: "#18212f", bgColor: "#ffffff",
          padding: 8, borderRadius: 4,
          display: index === 0 ? "ALWAYS" : "BYCLICK"
        }
      });
      points.push({ latitude: Number(lot.location.latitude), longitude: Number(lot.location.longitude) });
    });

    this.markerLotIds = markerLotIds;
    return {
      mapLatitude: Number(destination.latitude),
      mapLongitude: Number(destination.longitude),
      mapScale: 14,
      mapMarkers: markers,
      mapPoints: points
    };
  },

  onSearchInput(event) {
    this.setData({ searchKeyword: event.detail.value });
    this.refreshRecommendations();
  },

  clearSearch() {
    this.setData({ searchKeyword: "", parkingSearchResults: [], hasParkingSearchResults: false });
    this.refreshRecommendations();
  },

  onDestinationInput(event) {
    this.setData({ destinationKeyword: event.detail.value });
    this.refreshDestinationMatches(event.detail.value);
  },

  refreshDestinationMatches(keywordValue) {
    const keyword = String(keywordValue || this.data.destinationKeyword || "").trim().toLowerCase();
    if (!keyword) {
      this.setData({ destinationMatches: [], hasDestinationMatches: false });
      return;
    }

    const matches = (this._lots || [])
      .filter((lot) => searchableText([lot.name, lot.address]).indexOf(keyword) >= 0)
      .slice(0, 4)
      .map((lot) => ({
        id: lot.id,
        name: lot.name,
        address: lot.address,
        latitude: lot.location.latitude,
        longitude: lot.location.longitude
      }));

    this.setData({
      destinationMatches: matches,
      hasDestinationMatches: matches.length > 0
    });
  },

  applyDestination(destination) {
    this.setData({
      hasDestination: true,
      destination,
      destinationName: destination.name || "已选目的地",
      destinationAddress: destination.address || "目的地坐标已保存",
      destinationKeyword: destination.name || this.data.destinationKeyword || "",
      mapLatitude: Number(destination.latitude),
      mapLongitude: Number(destination.longitude)
    });
  },

  setDestination(destination) {
    app.globalData.destination = destination;
    wx.setStorageSync(DESTINATION_KEY, destination);
    this.setData({ destinationMatches: [], hasDestinationMatches: false });
    this.applyDestination(destination);
    this.refreshRecommendations();
  },

  searchDestinationCandidates() {
    const keyword = this.data.destinationKeyword.trim();
    if (!keyword) {
      wx.showToast({ title: "请输入目的地", icon: "none" });
      return;
    }
    const matches = this.refreshDestinationMatches(keyword);
    if (!matches || !this.data.hasDestinationMatches) {
      wx.showToast({ title: "暂无匹配结果", icon: "none" });
    }
  },

  selectDestinationMatch(event) {
    const id = event.currentTarget.dataset.id;
    const match = this.data.destinationMatches.find((item) => item.id === id);
    if (!match) return;
    this.setDestination({
      name: match.name,
      address: match.address,
      latitude: match.latitude,
      longitude: match.longitude
    });
  },

  chooseDestination() {
    const current = app.globalData.destination || app.globalData.userLocation || {};
    const chooseOptions = {
      success: (res) => {
        this.setDestination({
          name: res.name || this.data.destinationKeyword || "已选目的地",
          address: res.address || "",
          latitude: res.latitude,
          longitude: res.longitude
        });
      },
      fail: () => {
        wx.showToast({ title: "未选择地点", icon: "none" });
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

  onDurationPickerChange(event) {
    const minutes = pickerValueToDurationMinutes(event.detail.value);
    this.syncDuration(minutes);
    this.refreshRecommendations();
  },

  useCurrentLocationAsDestination() {
    wx.getLocation({
      type: "gcj02",
      success: (res) => {
        app.globalData.userLocation = { latitude: res.latitude, longitude: res.longitude };
        this.setDestination({
          name: "当前位置",
          address: "已使用当前位置作为目的地",
          latitude: res.latitude,
          longitude: res.longitude
        });
        wx.showToast({ title: "已设为目的地", icon: "success" });
      },
      fail: () => {
        wx.showToast({ title: "无法获取定位", icon: "none" });
      }
    });
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

  useLotAsDestination(event) {
    const lot = this.findLoadedLot(event.currentTarget.dataset.id);
    if (!lot) return;
    this.setDestination({
      name: lot.name,
      address: lot.address,
      latitude: lot.location.latitude,
      longitude: lot.location.longitude
    });
  },

  goDetail(event) {
    const id = event.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/detail/detail?id=${id}&duration=${this.data.durationMinutes}`
    });
  },

  onMarkerTap(event) {
    const lotId = this.markerLotIds[event.detail.markerId];
    if (!lotId) return;
    wx.navigateTo({
      url: `/pages/detail/detail?id=${lotId}&duration=${this.data.durationMinutes}`
    });
  },

  goAdd() {
    if (!getLoggedInUser()) {
      wx.showToast({ title: "请先登录再分享", icon: "none" });
      return;
    }
    wx.navigateTo({ url: "/pages/add/add" });
  },

  goVehicles() {
    if (!getLoggedInUser()) {
      wx.showToast({ title: "请先登录再管理车辆", icon: "none" });
      return;
    }
    wx.navigateTo({ url: "/pages/vehicles/vehicles" });
  },

  onShareAppMessage() {
    return {
      title: this.data.destinationName ? `${this.data.destinationName} 附近推荐` : "附近停车推荐",
      path: `/pages/index/index?duration=${this.data.durationMinutes}`
    };
  }
});
