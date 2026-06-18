const { buildRecommendationSummary, recommendParkingLots } = require("../../utils/recommendation");
const {
  findParkingLot,
  getAllParkingLots,
  getCurrentVehicle,
  getLoggedInUser,
  updateCurrentUserProfile,
  asyncGetAllParkingLots
} = require("../../utils/storage");
const api = require("../../utils/api");
const { formatDuration } = require("../../utils/pricing");
const { openParkingLocation } = require("../../utils/location");

const app = getApp();
const LOGIN_KEY = "parkingLoginState";
const CURRENT_USER_KEY = "parkingCurrentUser";
const DESTINATION_KEY = "parkingDestination";
const SEARCH_RADIUS_METERS = 3000;
const MIN_DURATION_MINUTES = 10;
const MAX_DURATION_MINUTES = 24 * 60;
const DURATION_STEP_MINUTES = 5;

function searchableText(parts) {
  return parts.filter(Boolean).join(" ").toLowerCase();
}

Page({
  data: {
    isLoggedIn: false,
    accountStatusText: "游客模式",
    accountActionText: "登录",
    accountStatusClass: "is-guest",
    minDurationMinutes: MIN_DURATION_MINUTES,
    maxDurationMinutes: MAX_DURATION_MINUTES,
    durationStepMinutes: DURATION_STEP_MINUTES,
    durationMinutes: 60,
    durationText: "1小时",
    hasLocation: false,
    hasDestination: false,
    destination: null,
    destinationName: "选择目的地",
    destinationAddress: "目的地 3 公里内推荐停车场",
    destinationKeyword: "",
    currentVehicle: null,
    currentVehicleText: "未设置车辆",
    currentVehicleHint: "默认按停车场基础规则计费",
    quickDurations: [
      { label: "10分钟", minutes: 10, activeClass: "" },
      { label: "15分钟", minutes: 15, activeClass: "" },
      { label: "30分钟", minutes: 30, activeClass: "" },
      { label: "1小时", minutes: 60, activeClass: "is-active" }
    ],
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
    emptyText: "先选择目的地。系统会在目的地 3 公里内查找停车场。"
  },

  onLoad(query) {
    this.markerLotIds = {};
    this.restoreLogin();
    this.restoreDestination();
    this.refreshVehicle();
    this.syncDuration(Number(query.duration) || app.globalData.durationMinutes || 60);
    this.refreshRecommendations();
  },

  onShow() {
    this.refreshVehicle();
    this.refreshRecommendations();
  },

  onPullDownRefresh() {
    this.refreshRecommendations();
    wx.stopPullDownRefresh();
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
          wx.showToast({
            title: "登录失败",
            icon: "none"
          });
          return;
        }

        const code = res.code;

        // Try to get user profile for nickname/avatar
        this.loginWithCode(code);
      },
      fail: () => {
        wx.showToast({
          title: "登录失败",
          icon: "none"
        });
      }
    });
  },

  async loginWithCode(code) {
    try {
      // Get user profile if available
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
          // User cancelled or not supported, continue without profile
        }
      }

      // Call backend login API
      const loginResult = await api.login(code, userInfo);

      // Store token
      const token = loginResult.token;
      wx.setStorageSync("auth_token", token);
      app.globalData.authToken = token;

      // Update user profile from backend response
      if (loginResult.user) {
        const user = loginResult.user;
        wx.setStorageSync(CURRENT_USER_KEY, {
          id: user.openid || user.id || "",
          nickname: user.nickname || "本机用户",
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
      wx.showToast({
        title: "已登录",
        icon: "success"
      });
      this.refreshRecommendations();
    } catch (error) {
      console.warn("Backend login failed, falling back to local:", error.message);
      // Fallback: local-only login
      wx.setStorageSync(LOGIN_KEY, { loggedAt: Date.now() });
      this.setData({
        isLoggedIn: true,
        accountStatusText: "已登录",
        accountActionText: "刷新",
        accountStatusClass: "is-authenticated"
      });
      wx.showToast({
        title: "已登录（离线模式）",
        icon: "none"
      });
    }
  },

  tryUpdateUserProfile() {
    if (!wx.getUserProfile) {
      return;
    }

    wx.getUserProfile({
      desc: "用于展示停车场数据来源头像",
      success: (profileRes) => {
        if (profileRes.userInfo) {
          updateCurrentUserProfile(profileRes.userInfo);
          this.refreshRecommendations();
        }
      }
    });
  },

  refreshVehicle() {
    const vehicle = getCurrentVehicle();
    app.globalData.currentVehicle = vehicle;
    this.setData({
      currentVehicle: vehicle,
      currentVehicleText: vehicle ? `${vehicle.plateNumber} · ${vehicle.vehicleTypeLabel}` : "未设置车辆",
      currentVehicleHint: vehicle ? "推荐已按当前车辆类型计费" : "默认按停车场基础规则计费"
    });
  },

  syncDuration(durationMinutes) {
    const rawMinutes = Number(durationMinutes) || 60;
    const boundedMinutes = Math.min(MAX_DURATION_MINUTES, Math.max(MIN_DURATION_MINUTES, rawMinutes));
    const safeMinutes = Math.round(boundedMinutes / DURATION_STEP_MINUTES) * DURATION_STEP_MINUTES;
    const quickDurations = this.data.quickDurations.map((item) => ({
      ...item,
      activeClass: item.minutes === safeMinutes ? "is-active" : ""
    }));

    app.globalData.durationMinutes = safeMinutes;
    this.setData({
      durationMinutes: safeMinutes,
      durationText: formatDuration(safeMinutes),
      quickDurations
    });
  },

  async refreshRecommendations() {
    const destination = app.globalData.destination;
    this.refreshParkingSearchResults();
    if (!destination) {
      this.markerLotIds = {};
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

    // Try backend API first, fallback to local
    let lots;
    try {
      lots = await asyncGetAllParkingLots(destination.latitude, destination.longitude, SEARCH_RADIUS_METERS);
    } catch (e) {
      lots = getAllParkingLots();
    }

    const keyword = this.data.searchKeyword.trim().toLowerCase();
    const filteredLots = lots.filter((lot) => this.matchLotKeyword(lot, keyword));
    const recommendations = recommendParkingLots({
      lots: filteredLots,
      durationMinutes: this.data.durationMinutes,
      destination,
      searchRadiusMeters: SEARCH_RADIUS_METERS,
      vehicleType: this.data.currentVehicle ? this.data.currentVehicle.vehicleType : "",
      preferences: {
        walkMinuteValue: 0.8
      }
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
    if (!keyword) {
      return true;
    }

    const tags = lot.access && Array.isArray(lot.access.tags) ? lot.access.tags.join(" ") : "";
    return searchableText([
      lot.name,
      lot.address,
      tags,
      lot.pricing && lot.pricing.notes
    ]).indexOf(keyword) >= 0;
  },

  async refreshParkingSearchResults() {
    const keyword = this.data.searchKeyword.trim().toLowerCase();
    if (!keyword) {
      this.setData({
        parkingSearchResults: [],
        hasParkingSearchResults: false
      });
      return;
    }

    const destination = app.globalData.destination;
    let lots;
    try {
      lots = await asyncGetAllParkingLots(
        destination ? destination.latitude : undefined,
        destination ? destination.longitude : undefined,
        destination ? SEARCH_RADIUS_METERS : undefined
      );
    } catch (e) {
      lots = getAllParkingLots();
    }

    const results = recommendParkingLots({
      lots: lots.filter((lot) => this.matchLotKeyword(lot, keyword)),
      durationMinutes: this.data.durationMinutes,
      destination,
      searchRadiusMeters: destination ? SEARCH_RADIUS_METERS : 0,
      vehicleType: this.data.currentVehicle ? this.data.currentVehicle.vehicleType : "",
      preferences: {
        walkMinuteValue: 0.8
      }
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
        content: "目的地",
        color: "#ffffff",
        bgColor: "#166a5b",
        padding: 8,
        borderRadius: 4,
        display: "ALWAYS"
      }
    }];
    const points = [{
      latitude: Number(destination.latitude),
      longitude: Number(destination.longitude)
    }];
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
          color: "#18212f",
          bgColor: "#ffffff",
          padding: 8,
          borderRadius: 4,
          display: index === 0 ? "ALWAYS" : "BYCLICK"
        }
      });
      points.push({
        latitude: Number(lot.location.latitude),
        longitude: Number(lot.location.longitude)
      });
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
    this.setData({
      searchKeyword: event.detail.value
    });
    this.refreshRecommendations();
  },

  clearSearch() {
    this.setData({
      searchKeyword: "",
      parkingSearchResults: [],
      hasParkingSearchResults: false
    });
    this.refreshRecommendations();
  },

  onDestinationInput(event) {
    this.setData({
      destinationKeyword: event.detail.value
    });
    this.refreshDestinationMatches(event.detail.value);
  },

  refreshDestinationMatches(keywordValue) {
    const keyword = String(keywordValue || this.data.destinationKeyword || "").trim().toLowerCase();
    if (!keyword) {
      this.setData({
        destinationMatches: [],
        hasDestinationMatches: false
      });
      return [];
    }

    const matches = getAllParkingLots()
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
    return matches;
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
    this.setData({
      destinationMatches: [],
      hasDestinationMatches: false
    });
    this.applyDestination(destination);
    this.refreshRecommendations();
  },

  searchDestinationCandidates() {
    const keyword = this.data.destinationKeyword.trim();
    if (!keyword) {
      wx.showToast({
        title: "请输入目的地",
        icon: "none"
      });
      return;
    }

    const matches = this.refreshDestinationMatches(keyword);
    if (!matches.length) {
      wx.showToast({
        title: "暂无本地匹配",
        icon: "none"
      });
    }
  },

  selectDestinationMatch(event) {
    const id = event.currentTarget.dataset.id;
    const match = this.data.destinationMatches.find((item) => item.id === id);
    if (!match) {
      return;
    }

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
        wx.showToast({
          title: "未选择地点",
          icon: "none"
        });
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

  onDurationSlide(event) {
    const minutes = Number(event.detail.value) || MIN_DURATION_MINUTES;
    this.syncDuration(minutes);
    this.refreshRecommendations();
  },

  setQuickDuration(event) {
    const minutes = Number(event.currentTarget.dataset.minutes) || 60;
    this.syncDuration(minutes);
    this.refreshRecommendations();
  },

  useCurrentLocationAsDestination() {
    wx.getLocation({
      type: "gcj02",
      success: (res) => {
        app.globalData.userLocation = {
          latitude: res.latitude,
          longitude: res.longitude
        };
        this.setDestination({
          name: "当前位置",
          address: "已使用当前位置作为目的地",
          latitude: res.latitude,
          longitude: res.longitude
        });
        wx.showToast({
          title: "已设为目的地",
          icon: "success"
        });
      },
      fail: () => {
        wx.showToast({
          title: "无法获取定位",
          icon: "none"
        });
      }
    });
  },

  openNavigation(event) {
    const lot = findParkingLot(event.currentTarget.dataset.id);
    openParkingLocation(lot);
  },

  useLotAsDestination(event) {
    const lot = findParkingLot(event.currentTarget.dataset.id);
    if (!lot) {
      return;
    }

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
    if (!lotId) {
      return;
    }

    wx.navigateTo({
      url: `/pages/detail/detail?id=${lotId}&duration=${this.data.durationMinutes}`
    });
  },

  goAdd() {
    if (!getLoggedInUser()) {
      wx.showToast({
        title: "请先登录再分享",
        icon: "none"
      });
      return;
    }

    wx.navigateTo({
      url: "/pages/add/add"
    });
  },

  goVehicles() {
    if (!getLoggedInUser()) {
      wx.showToast({
        title: "请先登录再管理车辆",
        icon: "none"
      });
      return;
    }

    wx.navigateTo({
      url: "/pages/vehicles/vehicles"
    });
  },

  onShareAppMessage() {
    return {
      title: this.data.destinationName ? `${this.data.destinationName} 附近推荐` : "附近停车推荐",
      path: `/pages/index/index?duration=${this.data.durationMinutes}`
    };
  }
});
