const {
  RECOMMENDATION_PAGE_SIZE,
  buildRecommendationSummary,
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
const { openParkingLocation } = require("../../utils/location");

const app = getApp();
const DESTINATION_KEY = "parkingDestination";
const SEARCH_RADIUS_METERS = 3000;
const DEFAULT_DURATION_MINUTES = 30;
const MIN_DURATION_MINUTES = 1;
const MAX_DURATION_DAYS = 7;
const MAX_DURATION_MINUTES = (MAX_DURATION_DAYS * 24 * 60) + (23 * 60) + 59;
const SHEET_COLLAPSED_HEIGHT = 330;
const SHEET_MAP_GAP = 96;
const MAP_EXPANDED_SHEET_HEIGHT = 220;
const SHEET_ANIMATION_MS = 220;
const SHEET_DRAG_THRESHOLD = 56;
const MAP_VISIBLE_GAP = 0;
const MAP_GESTURE_RESTORE_MS = 80;

const recommendationSortOptions = [
  { value: "comprehensive", label: "综合排序" },
  { value: "distance", label: "距离最近" },
  { value: "price", label: "低价优先" }
];

const parkingScopeOptions = [
  { value: "all", label: "全部" },
  { value: "offstreet", label: "室内车库" },
  { value: "street", label: "路侧停车" }
];

const durationQuickOptions = [
  { value: 30, label: "30分钟" },
  { value: 60, label: "1小时" },
  { value: 120, label: "2小时" },
  { value: 240, label: "4小时" }
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

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

Page({
  data: {
    isLoggedIn: false,
    accountStatusText: "游客模式",
    accountActionText: "登录",
    accountStatusClass: "is-guest",
    userAvatarUrl: "",
    userAvatarText: "我",
    recommendationSortOptions,
    parkingScopeOptions,
    durationQuickOptions,
    recommendationSortMode: "comprehensive",
    recommendationSortText: "综合排序",
    sortDropdownOpen: false,
    parkingScope: "all",
    mapExpanded: false,
    sheetExpanded: false,
    sheetAnimating: false,
    sheetHeightPx: SHEET_COLLAPSED_HEIGHT,
    sheetTranslateY: 0,
    mapViewportHeightPx: 392,
    mapLocateBottomPx: SHEET_COLLAPSED_HEIGHT + 24,
    mapGestureEnabled: true,
    durationPickerRanges: [durationDayOptions, durationHourOptions, durationMinuteOptions],
    durationPickerValue: durationMinutesToPickerValue(DEFAULT_DURATION_MINUTES),
    durationMinutes: DEFAULT_DURATION_MINUTES,
    durationText: "30分钟",
    locating: false,
    locationStatusText: "等待定位",
    showDurationMenu: false,
    hasLocation: false,
    hasDestination: false,
    destination: null,
    destinationName: "正在定位",
    destinationAddress: "定位成功后自动推荐附近停车场",
    destinationKeyword: "",
    currentVehicle: null,
    currentVehicleText: "未设置车辆",
    currentVehicleHint: "默认按停车场基础规则计费",
    mapSearchKeyword: "",
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
    visibleRecommendations: [],
    visibleRecommendationLimit: RECOMMENDATION_PAGE_SIZE,
    hasRecommendations: false,
    hasMoreRecommendations: false,
    summary: "正在定位当前位置。",
    emptyText: "定位成功后会自动推荐附近停车场。",
    loading: false
  },

  onLoad(query) {
    this.markerLotIds = {};
    this._lots = null;
    this._bootstrapping = true;
    this.initSheetMetrics();
    this.restoreLogin();
    this.syncDuration(Number(query.duration) || app.globalData.durationMinutes || DEFAULT_DURATION_MINUTES);
    this.refreshVehicle()
      .then(() => this.locateCurrentDestination({ showToast: false }))
      .finally(() => {
        this._bootstrapping = false;
      });
  },

  onShow() {
    this.initSheetMetrics();
    this.restoreLogin();
    if (this._bootstrapping) return;
    this.refreshVehicle().then(() => this.refreshRecommendations());
  },

  onPullDownRefresh() {
    this.refreshRecommendations().then(() => wx.stopPullDownRefresh());
  },

  initSheetMetrics() {
    let windowHeight = 720;
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      windowHeight = info.windowHeight || windowHeight;
    } catch (error) {
      windowHeight = 720;
    }

    const expandedHeight = Math.max(SHEET_COLLAPSED_HEIGHT, windowHeight - SHEET_MAP_GAP);
    this._sheetCollapsedHeight = SHEET_COLLAPSED_HEIGHT;
    this._sheetMapExpandedHeight = Math.min(MAP_EXPANDED_SHEET_HEIGHT, SHEET_COLLAPSED_HEIGHT);
    this._sheetExpandedHeight = expandedHeight;
    this._windowHeight = windowHeight;
    const sheetHeight = this.getCurrentSheetHeight();
    this.setData({
      sheetHeightPx: sheetHeight,
      sheetTranslateY: 0,
      mapViewportHeightPx: this.getMapViewportHeight(sheetHeight),
      mapLocateBottomPx: sheetHeight + 24
    });
  },

  getMapViewportHeight(sheetHeight) {
    const windowHeight = this._windowHeight || 720;
    return Math.max(0, windowHeight - sheetHeight + MAP_VISIBLE_GAP);
  },

  getCurrentSheetHeight() {
    if (this.data.sheetExpanded) {
      return this._sheetExpandedHeight || SHEET_COLLAPSED_HEIGHT;
    }
    if (this.data.mapExpanded) {
      return this._sheetMapExpandedHeight || MAP_EXPANDED_SHEET_HEIGHT;
    }
    return this._sheetCollapsedHeight || SHEET_COLLAPSED_HEIGHT;
  },

  setSheetExpanded(expanded) {
    const sheetHeight = expanded
      ? this._sheetExpandedHeight
      : (this.data.mapExpanded ? this._sheetMapExpandedHeight : this._sheetCollapsedHeight);
    this.setData({
      sheetExpanded: expanded,
      sheetAnimating: true,
      sheetHeightPx: sheetHeight,
      sheetTranslateY: 0,
      mapViewportHeightPx: this.getMapViewportHeight(sheetHeight),
      mapLocateBottomPx: sheetHeight + 24
    });
    this.finishSheetAnimation();
  },

  finishSheetAnimation() {
    if (this._sheetAnimationTimer) {
      clearTimeout(this._sheetAnimationTimer);
    }
    this._sheetAnimationTimer = setTimeout(() => {
      this.setData({ sheetAnimating: false });
      this._sheetAnimationTimer = null;
    }, SHEET_ANIMATION_MS);
  },

  toggleSheet() {
    if (this._ignoreNextSheetTap) {
      this._ignoreNextSheetTap = false;
      return;
    }
    this.setSheetExpanded(!this.data.sheetExpanded);
  },

  expandSheetFromSearch() {
    if (!this.data.sheetExpanded) {
      this.setSheetExpanded(true);
    }
  },

  enterMapMode() {
    const sheetHeight = this._sheetMapExpandedHeight || MAP_EXPANDED_SHEET_HEIGHT;
    this.setData({
      mapExpanded: true,
      sheetExpanded: false,
      sheetAnimating: true,
      showDurationMenu: false,
      sheetHeightPx: sheetHeight,
      sheetTranslateY: 0,
      mapViewportHeightPx: this.getMapViewportHeight(sheetHeight),
      mapLocateBottomPx: sheetHeight + 24
    });
    this.finishSheetAnimation();
  },

  exitMapMode() {
    const sheetHeight = this._sheetCollapsedHeight || SHEET_COLLAPSED_HEIGHT;
    this.setData({
      mapExpanded: false,
      sheetExpanded: false,
      sheetAnimating: true,
      sheetHeightPx: sheetHeight,
      sheetTranslateY: 0,
      mapViewportHeightPx: this.getMapViewportHeight(sheetHeight),
      mapLocateBottomPx: sheetHeight + 24
    });
    this.finishSheetAnimation();
  },

  onSheetTouchStart(event) {
    const touch = event.touches && event.touches[0];
    if (!touch) return;
    this.onSheetInteractionStart();
    this._sheetDragStartY = touch.clientY;
    this._sheetDragStartHeight = this.data.sheetHeightPx;
    this._sheetDragStartExpanded = this.data.sheetExpanded;
    this.setData({ sheetAnimating: false });
  },

  onSheetTouchMove(event) {
    if (this._sheetDragStartY == null) return;
    const touch = event.touches && event.touches[0];
    if (!touch) return;
    const deltaY = touch.clientY - this._sheetDragStartY;
    const minHeight = this.data.mapExpanded ? this._sheetMapExpandedHeight : this._sheetCollapsedHeight;
    const nextHeight = clampNumber(
      this._sheetDragStartHeight - deltaY,
      minHeight,
      this._sheetExpandedHeight
    );
    this.setData({
      sheetHeightPx: nextHeight,
      sheetTranslateY: 0,
      mapViewportHeightPx: this.getMapViewportHeight(nextHeight),
      mapLocateBottomPx: nextHeight + 24
    });
  },

  onSheetTouchEnd() {
    if (this._sheetDragStartY == null) return;
    const draggedHeight = this.data.sheetHeightPx;
    const collapsedHeight = this.data.mapExpanded ? this._sheetMapExpandedHeight : this._sheetCollapsedHeight;
    const midpoint = (this._sheetExpandedHeight + collapsedHeight) / 2;
    const didDrag = Math.abs(draggedHeight - this._sheetDragStartHeight) > 4;
    const shouldExpand = this._sheetDragStartExpanded
      ? draggedHeight > this._sheetExpandedHeight - SHEET_DRAG_THRESHOLD
      : draggedHeight > midpoint || draggedHeight > collapsedHeight + SHEET_DRAG_THRESHOLD;
    this._sheetDragStartY = null;
    this._sheetDragStartHeight = null;
    this._ignoreNextSheetTap = didDrag;
    this.setSheetExpanded(shouldExpand);
    this.onSheetInteractionEnd();
  },

  onSheetTouchCancel() {
    this._sheetDragStartY = null;
    this._sheetDragStartHeight = null;
    this.setSheetExpanded(this.data.sheetExpanded);
    this.onSheetInteractionEnd();
  },

  onSheetInteractionStart() {
    if (this._mapGestureRestoreTimer) {
      clearTimeout(this._mapGestureRestoreTimer);
      this._mapGestureRestoreTimer = null;
    }
    if (this.data.mapGestureEnabled) {
      this.setData({ mapGestureEnabled: false });
    }
  },

  onSheetInteractionEnd() {
    if (this._mapGestureRestoreTimer) {
      clearTimeout(this._mapGestureRestoreTimer);
    }
    this._mapGestureRestoreTimer = setTimeout(() => {
      this.setData({ mapGestureEnabled: true });
      this._mapGestureRestoreTimer = null;
    }, MAP_GESTURE_RESTORE_MS);
  },

  restoreLogin() {
    const user = getLoggedInUser();
    if (user) {
      this.setData({
        isLoggedIn: true,
        accountStatusText: user.nickname || "我的",
        accountActionText: "账户",
        accountStatusClass: "is-authenticated",
        userAvatarUrl: user.avatarUrl || "",
        userAvatarText: user.avatarText || (user.nickname || "我").slice(0, 1)
      });
      return;
    }
    this.setData({
      isLoggedIn: false,
      accountStatusText: "我的",
      accountActionText: "登录",
      accountStatusClass: "is-guest",
      userAvatarUrl: "",
      userAvatarText: "我"
    });
  },

  restoreDestination() {
    const destination = wx.getStorageSync(DESTINATION_KEY);
    if (destination && destination.latitude && destination.longitude) {
      app.globalData.destination = destination;
      this.applyDestination(destination);
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
    if (!destination) {
      this.markerLotIds = {};
      this._lots = [];
      this.setData({
        hasDestination: false,
        recommendations: [],
        visibleRecommendations: [],
        visibleRecommendationLimit: RECOMMENDATION_PAGE_SIZE,
        hasRecommendations: false,
        hasMoreRecommendations: false,
        mapMarkers: [],
        mapPoints: [],
        summary: this.data.locating ? "正在定位当前位置。" : "请选择目的地后查看附近停车推荐。",
        emptyText: this.data.locating ? "定位成功后会自动推荐附近停车场。" : "请选择目的地。系统会在目的地 3 公里内查找停车场。"
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
        visibleRecommendations: [],
        visibleRecommendationLimit: RECOMMENDATION_PAGE_SIZE,
        hasRecommendations: false,
        hasMoreRecommendations: false,
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

    this.applyRecommendationLots(lots, destination);
  },

  applyRecommendationLots(lots, destination) {
    const keyword = String(this.data.mapSearchKeyword || "").trim().toLowerCase();
    const scopedLots = filterLotsByScope(lots, this.data.parkingScope);
    const filteredLots = keyword
      ? scopedLots.filter((lot) => this.matchLotKeyword(lot, keyword))
      : scopedLots;
    const baseRecommendations = recommendParkingLots({
      lots: filteredLots,
      durationMinutes: this.data.durationMinutes,
      destination,
      searchRadiusMeters: SEARCH_RADIUS_METERS,
      vehicleType: this.data.currentVehicle ? this.data.currentVehicle.vehicleType : "",
      preferences: { walkMinuteValue: 0.8 }
    });
    const recommendations = sortAndDecorateRecommendations(baseRecommendations, this.data.recommendationSortMode);
    const mapState = this.buildMapState(destination, recommendations);
    const visibleState = buildVisibleRecommendationState(recommendations, RECOMMENDATION_PAGE_SIZE);

    this.setData({
      hasLocation: Boolean(app.globalData.userLocation),
      hasDestination: true,
      recommendations,
      ...visibleState,
      hasRecommendations: recommendations.length > 0,
      summary: buildRecommendationSummary(recommendations),
      emptyText: keyword
        ? "没有匹配的停车场，请换个关键词或清空搜索。"
        : "目的地 3 公里内没有匹配的停车场。可以调整筛选，或先录入附近停车场。",
      ...mapState
    });
  },

  rebuildRecommendationsFromLoadedLots() {
    const destination = app.globalData.destination;
    if (!destination || !Array.isArray(this._lots)) {
      return this.refreshRecommendations();
    }
    this.applyRecommendationLots(this._lots, destination);
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
    const lots = filterLotsByScope(this._lots || [], this.data.parkingScope);
    const results = recommendParkingLots({
      lots: lots.filter((lot) => this.matchLotKeyword(lot, keyword)),
      durationMinutes: this.data.durationMinutes,
      destination,
      searchRadiusMeters: destination ? SEARCH_RADIUS_METERS : 0,
      vehicleType: this.data.currentVehicle ? this.data.currentVehicle.vehicleType : "",
      preferences: { walkMinuteValue: 0.8 }
    });
    const sortedResults = sortAndDecorateRecommendations(results, this.data.recommendationSortMode).slice(0, 5);

    this.setData({
      parkingSearchResults: sortedResults,
      hasParkingSearchResults: sortedResults.length > 0
    });
  },

  buildMapState(destination, recommendations) {
    const markers = [{
      id: 1,
      latitude: Number(destination.latitude),
      longitude: Number(destination.longitude),
      title: destination.name || "目的地",
      callout: {
        content: "目的地", color: "#ffffff", bgColor: "#176b5b",
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
          color: "#17201e", bgColor: "#ffffff",
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
    const value = event.detail.value;
    this.setData({ mapSearchKeyword: value }, () => {
      this.rebuildRecommendationsFromLoadedLots();
      this.expandSheetFromSearch();
    });
  },

  clearSearch() {
    this.setData({
      mapSearchKeyword: ""
    }, () => this.rebuildRecommendationsFromLoadedLots());
  },

  toggleSortDropdown() {
    this.setData({
      sortDropdownOpen: !this.data.sortDropdownOpen,
      showDurationMenu: false
    });
  },

  closeSortDropdown() {
    if (this.data.sortDropdownOpen) {
      this.setData({ sortDropdownOpen: false });
    }
  },

  setRecommendationSortMode(event) {
    const mode = event.currentTarget.dataset.mode;
    if (!mode) return;
    const recommendations = sortAndDecorateRecommendations(this.data.recommendations, mode);
    const mapState = this.data.hasDestination
      ? this.buildMapState(app.globalData.destination, recommendations)
      : {};
    this.setData({
      recommendationSortMode: mode,
      recommendationSortText: getRecommendationSortText(mode),
      sortDropdownOpen: false,
      recommendations,
      ...buildVisibleRecommendationState(recommendations, RECOMMENDATION_PAGE_SIZE),
      summary: buildRecommendationSummary(recommendations),
      ...mapState
    });
  },

  loadMoreRecommendations() {
    if (!this.data.sheetExpanded || !this.data.hasMoreRecommendations) return;
    const nextLimit = this.data.visibleRecommendationLimit + RECOMMENDATION_PAGE_SIZE;
    this.setData(buildVisibleRecommendationState(this.data.recommendations, nextLimit));
  },

  onDestinationInput(event) {
    const value = event.detail.value;
    this.setData({
      destinationKeyword: value,
      searchKeyword: value
    });
    this.refreshDestinationMatches(value);
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

  setDestination(destination, options) {
    const setOptions = options || {};
    if (setOptions.source !== "location") {
      this._manualDestinationAt = Date.now();
    }
    app.globalData.destination = destination;
    if (setOptions.persist !== false) {
      wx.setStorageSync(DESTINATION_KEY, destination);
    }
    this.setData({
      destinationMatches: [],
      hasDestinationMatches: false,
      searchKeyword: destination.name || this.data.searchKeyword || "",
      locationStatusText: setOptions.source === "location" ? "已定位" : "自定义目的地"
    });
    this.applyDestination(destination);
    return this.refreshRecommendations();
  },

  async locateCurrentDestination(options) {
    const locateOptions = options || {};
    const startedAt = Date.now();
    const previousDestination = app.globalData.destination;
    this.setData({
      locating: true,
      locationStatusText: "定位中",
      emptyText: "定位成功后会自动推荐附近停车场。"
    });

    try {
      const res = await new Promise((resolve, reject) => {
        wx.getLocation({
          type: "gcj02",
          success: resolve,
          fail: reject
        });
      });
      const destination = {
        name: "当前位置",
        address: "已按当前位置推荐附近停车场",
        latitude: res.latitude,
        longitude: res.longitude
      };
      app.globalData.userLocation = { latitude: res.latitude, longitude: res.longitude };
      if (!locateOptions.force && this._manualDestinationAt && this._manualDestinationAt > startedAt) {
        this.setData({
          hasLocation: true,
          locating: false,
          locationStatusText: "自定义目的地"
        });
        return;
      }
      this.setData({
        hasLocation: true,
        locating: false,
        locationStatusText: "已定位"
      });
      await this.setDestination(destination, { source: "location" });
      if (locateOptions.showToast) {
        wx.showToast({ title: "已定位", icon: "success" });
      }
    } catch (error) {
      console.error("locateCurrentDestination error:", error && error.errMsg ? error.errMsg : error);
      app.globalData.userLocation = null;
      this.setData({
        hasLocation: false,
        locating: false,
        locationStatusText: "定位失败",
        destinationName: "选择目的地",
        destinationAddress: "无法获取当前位置，可手动选择目的地",
        summary: "无法获取当前位置，可手动选择目的地后推荐附近停车场。",
        emptyText: "无法获取当前位置。请选择目的地后查看推荐。"
      });
      const savedDestination = wx.getStorageSync(DESTINATION_KEY);
      const fallbackDestination = previousDestination || savedDestination;
      if (fallbackDestination && fallbackDestination.latitude && fallbackDestination.longitude) {
        app.globalData.destination = fallbackDestination;
        this.setData({ locationStatusText: previousDestination ? "保留当前目的地" : "使用上次目的地" });
        this.applyDestination(fallbackDestination);
        await this.refreshRecommendations();
      }
      if (locateOptions.showToast) {
        wx.showToast({ title: "无法获取定位", icon: "none" });
      }
    }
  },

  searchDestinationCandidates() {
    const keyword = this.data.destinationKeyword.trim();
    if (!keyword) {
      wx.showToast({ title: "请输入目的地", icon: "none" });
      return;
    }
    const matches = this.refreshDestinationMatches(keyword);
    if (!matches || matches.length === 0) {
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

  selectDurationPreset(event) {
    const minutes = Number(event.currentTarget.dataset.minutes);
    if (!Number.isFinite(minutes)) return;
    this.syncDuration(minutes);
    this.setData({ showDurationMenu: false });
    this.rebuildRecommendationsFromLoadedLots();
  },

  onDurationNativeChange(event) {
    const minutes = pickerValueToDurationMinutes(event.detail.value);
    this.syncDuration(minutes);
    this.setData({ showDurationMenu: false });
    this.rebuildRecommendationsFromLoadedLots();
  },

  toggleDurationMenu() {
    this.setData({
      showDurationMenu: !this.data.showDurationMenu,
      sortDropdownOpen: false
    });
  },

  setParkingScope(event) {
    const scope = event.currentTarget.dataset.scope;
    if (!scope || scope === this.data.parkingScope) return;
    this.setData({ parkingScope: scope, sortDropdownOpen: false }, () => {
      this.rebuildRecommendationsFromLoadedLots();
    });
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
      wx.navigateTo({ url: "/pages/profile/profile" });
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
    return {
      title: this.data.destinationName ? `${this.data.destinationName} 附近推荐` : "附近停车推荐",
      path: `/pages/index/index?duration=${this.data.durationMinutes}`
    };
  }
});
