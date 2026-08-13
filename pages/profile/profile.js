const {
  getLoggedInUser,
  updateCurrentUserProfile,
  asyncGetUserVehicles,
  getCurrentVehicleId
} = require("../../utils/storage");
const api = require("../../utils/api");
const { showErrorModal } = require("../../utils/error");

const LOGIN_KEY = "parkingLoginState";
const CURRENT_USER_KEY = "parkingCurrentUser";
const CURRENT_VEHICLE_KEY = "parkingCurrentVehicleId";

function guestUser() {
  return {
    nickname: "未登录",
    avatarUrl: "",
    avatarText: "我"
  };
}

Page({
  data: {
    isLoggedIn: false,
    user: guestUser(),
    vehicleCount: 0,
    currentVehicleText: "暂未设置",
    loading: false
  },

  onShow() {
    this.refresh();
  },

  async refresh() {
    const user = getLoggedInUser();
    if (!user) {
      this.setData({
        isLoggedIn: false,
        user: guestUser(),
        vehicleCount: 0,
        currentVehicleText: "登录后设置"
      });
      return;
    }

    this.setData({
      isLoggedIn: true,
      user: {
        ...user,
        avatarText: user.avatarText || (user.nickname || "我").slice(0, 1)
      }
    });

    try {
      const vehicles = await asyncGetUserVehicles();
      const currentId = getCurrentVehicleId();
      const currentVehicle = vehicles.find((item) => `${item.id}` === `${currentId}`) || vehicles[0] || null;
      this.setData({
        vehicleCount: vehicles.length,
        currentVehicleText: currentVehicle ? currentVehicle.plateNumber : "暂未设置"
      });
    } catch (error) {
      console.error("profile vehicles error:", error.message);
      this.setData({ vehicleCount: 0, currentVehicleText: "加载失败" });
    }
  },

  login() {
    this.authenticate("用于展示停车场数据来源头像");
  },

  refreshProfile() {
    this.authenticate("用于更新你的头像和昵称");
  },

  async authenticate(profileDescription) {
    this.setData({ loading: true });
    try {
      let userInfo = {};
      if (wx.getUserProfile) {
        try {
          const profileRes = await new Promise((resolve, reject) => {
            wx.getUserProfile({
              desc: profileDescription,
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
        } catch (error) {
          // 用户可以只建立登录态，不授权头像昵称。
        }
      }

      const loginCode = await new Promise((resolve, reject) => {
        wx.login({
          success: (res) => res.code ? resolve(res.code) : reject(new Error("登录凭证为空")),
          fail: reject
        });
      });
      const loginResult = await api.login(loginCode, userInfo);
      api.setToken(loginResult.token);
      getApp().globalData.authToken = loginResult.token;

      const responseUser = loginResult.user || {};
      const nickname = responseUser.nickname || userInfo.nickname || "停车用户";
      wx.setStorageSync(CURRENT_USER_KEY, {
        id: responseUser.openid || responseUser.id || "",
        nickname,
        avatarUrl: responseUser.avatar_url || responseUser.avatarUrl || userInfo.avatarUrl || "",
        avatarText: nickname.slice(0, 1),
        avatarColor: "#176b5b",
        createdAt: Date.now()
      });
      wx.setStorageSync(LOGIN_KEY, { loggedAt: Date.now() });
      await this.refresh();
      wx.showToast({ title: "已登录", icon: "success" });
    } catch (error) {
      console.error("profile login error:", error.message);
      showErrorModal("登录失败", error, "登录失败，请检查网络或云托管配置。");
    } finally {
      this.setData({ loading: false });
    }
  },

  logout() {
    wx.showModal({
      title: "退出当前账号？",
      content: "退出后本机将清除登录状态，云端车辆和上报数据不会被删除。",
      confirmText: "退出",
      confirmColor: "#9b4e34",
      success: (res) => {
        if (!res.confirm) return;
        api.clearToken();
        wx.removeStorageSync(LOGIN_KEY);
        wx.removeStorageSync(CURRENT_USER_KEY);
        wx.removeStorageSync(CURRENT_VEHICLE_KEY);
        const app = getApp();
        app.globalData.authToken = "";
        app.globalData.currentVehicle = null;
        this.refresh();
        wx.showToast({ title: "已退出", icon: "success" });
      }
    });
  },

  goVehicles() {
    if (!this.data.isLoggedIn) {
      wx.showToast({ title: "请先登录", icon: "none" });
      return;
    }
    wx.navigateTo({ url: "/pages/vehicles/vehicles" });
  },

  goAdd() {
    if (!this.data.isLoggedIn) {
      wx.showToast({ title: "请先登录", icon: "none" });
      return;
    }
    wx.navigateTo({ url: "/pages/add/add" });
  },

  goHome() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack();
      return;
    }
    wx.reLaunch({ url: "/pages/index/index" });
  }
});
