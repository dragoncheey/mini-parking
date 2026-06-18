const { findParkingLot, getCurrentVehicle, getLoggedInUser, asyncGetParkingLotDetail, asyncVoteParkingLot } = require("../../utils/storage");
const api = require("../../utils/api");
const { recommendParkingLots } = require("../../utils/recommendation");
const { openParkingLocation } = require("../../utils/location");

const app = getApp();

Page({
  data: {
    lot: null,
    detail: null,
    amapPoiId: "未录入",
    sourceText: "手动录入",
    evidenceStatus: "无照片证据",
    evidencePhotos: [],
    evidencePhotoCount: 0,
    currentVehicle: null,
    currentVehicleText: "未设置车辆",
    canVote: false,
    upVoteClass: "",
    downVoteClass: ""
  },

  onLoad(query) {
    const durationMinutes = Math.max(10, Number(query.duration) || app.globalData.durationMinutes || 60);
    app.globalData.durationMinutes = durationMinutes;
    this.loadDetail(query.id, durationMinutes);
  },

  async loadDetail(id, durationMinutes) {
    let lot = null;
    let userVote = null;

    // Try backend API first, fallback to local
    try {
      const result = await asyncGetParkingLotDetail(id);
      lot = result.lot;
      userVote = result.userVote;
    } catch (e) {
      console.warn("loadDetail fallback to local:", e.message);
      lot = findParkingLot(id);
    }

    if (!lot) {
      this.setData({
        lot: null,
        detail: null
      });
      return;
    }

    const currentVehicle = getCurrentVehicle();
    const detail = recommendParkingLots({
      lots: [lot],
      durationMinutes,
      destination: app.globalData.destination || app.globalData.userLocation,
      vehicleType: currentVehicle ? currentVehicle.vehicleType : ""
    })[0];
    const amap = lot.location && lot.location.amap ? lot.location.amap : {};
    const evidence = lot.evidence || {};

    // Determine vote display: prefer API-provided userVote, else use local voteStats
    let upClass = "";
    let downClass = "";
    if (userVote) {
      upClass = userVote === "up" ? "is-active" : "";
      downClass = userVote === "down" ? "is-active" : "";
    } else if (lot.voteStats && lot.voteStats.currentUserVote) {
      upClass = lot.voteStats.currentUserVote === "up" ? "is-active" : "";
      downClass = lot.voteStats.currentUserVote === "down" ? "is-active" : "";
    }

    this.setData({
      lot,
      detail,
      currentVehicle,
      currentVehicleText: currentVehicle ? `${currentVehicle.plateNumber} · ${currentVehicle.vehicleTypeLabel}` : "未设置车辆",
      amapPoiId: amap.poiId || "未录入",
      sourceText: lot.source === "user" ? "用户分享" : "手动录入",
      evidenceStatus: evidence.recognitionStatus || "无照片证据",
      evidencePhotos: evidence.photos || [],
      evidencePhotoCount: evidence.photos ? evidence.photos.length : 0,
      canVote: Boolean(getLoggedInUser() && !lot.canEdit),
      upVoteClass: upClass,
      downVoteClass: downClass
    });
  },

  openNavigation() {
    openParkingLocation(this.data.lot);
  },

  goEdit() {
    const lot = this.data.lot;
    if (!lot || !lot.canEdit) {
      wx.showToast({
        title: "只能维护自己上报的信息",
        icon: "none"
      });
      return;
    }

    wx.navigateTo({
      url: `/pages/add/add?id=${lot.id}`
    });
  },

  async vote(event) {
    const voteValue = event.currentTarget.dataset.vote;
    const lot = this.data.lot;

    if (!lot) {
      return;
    }

    if (lot.canEdit) {
      wx.showToast({
        title: "自己上报的信息不能评价",
        icon: "none"
      });
      return;
    }

    try {
      const result = await asyncVoteParkingLot(lot.id, voteValue);

      // Update UI based on vote result
      const upClass = voteValue === "up" ? "is-active" : "";
      const downClass = voteValue === "down" ? "is-active" : "";
      this.setData({
        upVoteClass: upClass,
        downVoteClass: downClass
      });

      wx.showToast({
        title: "已更新评价",
        icon: "success"
      });
    } catch (error) {
      wx.showToast({
        title: error.message === "LOGIN_REQUIRED" ? "请先登录再评价" : "评价失败",
        icon: "none"
      });
    }
  },

  copyLocation() {
    const lot = this.data.lot;
    if (!lot) {
      return;
    }

    const amap = lot.location && lot.location.amap ? lot.location.amap : {};
    const text = [
      lot.name,
      lot.address,
      `坐标：${lot.location.latitude},${lot.location.longitude}`,
      amap.poiId ? `高德 POI：${amap.poiId}` : ""
    ].filter(Boolean).join("\n");

    wx.setClipboardData({
      data: text,
      success() {
        wx.showToast({
          title: "已复制",
          icon: "success"
        });
      }
    });
  },

  previewEvidence(event) {
    const index = Number(event.currentTarget.dataset.index) || 0;
    const urls = this.data.evidencePhotos.map((photo) => photo.uploadedUrl || photo.path);
    wx.previewImage({
      current: urls[index],
      urls
    });
  },

  onShareAppMessage() {
    const lot = this.data.lot;
    return {
      title: lot ? `${lot.name} 停车费用参考` : "停车场费用参考",
      path: lot ? `/pages/detail/detail?id=${lot.id}&duration=${app.globalData.durationMinutes}` : "/pages/index/index"
    };
  }
});
