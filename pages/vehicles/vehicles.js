const {
  getLoggedInUser,
  updateCurrentUserProfile,
  getCurrentVehicleId,
  setCurrentVehicleId,
  asyncGetUserVehicles,
  asyncAddVehicle,
  asyncDeleteVehicle
} = require("../../utils/storage");
const api = require("../../utils/api");
const { showErrorModal } = require("../../utils/error");

const LOGIN_KEY = "parkingLoginState";
const CURRENT_USER_KEY = "parkingCurrentUser";

const vehicleTypeOptions = [
  { label: "新能源小型车", value: "new_energy" },
  { label: "燃油小型车", value: "fuel" }
];

function buildEmptyForm() {
  return { plateNumber: "", vehicleType: "fuel" };
}

Page({
  data: {
    isLoggedIn: false,
    loginRequired: true,
    vehicleTypeOptions,
    form: buildEmptyForm(),
    vehicles: [],
    currentVehicleId: "",
    currentVehicleLabel: "未设置",
    emptyText: "暂无车辆，请先录入车牌。",
    pageTitle: "车辆管理",
    loading: false
  },

  onLoad() {
    this.refresh();
  },

  onShow() {
    this.refresh();
  },

  async refresh() {
    const loggedIn = Boolean(getLoggedInUser());
    this.setData({ isLoggedIn: loggedIn, loginRequired: !loggedIn });

    if (!loggedIn) {
      this.setData({ vehicles: [], currentVehicleId: "", currentVehicleLabel: "未设置", emptyText: "请先登录" });
      return;
    }

    this.setData({ loading: true });
    let vehicles = [];
    try {
      vehicles = await asyncGetUserVehicles();
    } catch (e) {
      console.error("refresh vehicles error:", e.message);
      wx.showToast({ title: "加载车辆失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }

    const currentId = getCurrentVehicleId();
    const currentVehicle = vehicles.find((vehicle) => `${vehicle.id}` === `${currentId}`) || vehicles[0] || null;
    this.setData({
      vehicles,
      currentVehicleId: currentVehicle ? currentVehicle.id : "",
      currentVehicleLabel: currentVehicle
        ? `${currentVehicle.plateNumber} · ${currentVehicle.vehicleTypeLabel}`
        : "未设置",
      emptyText: vehicles.length ? "" : "暂无车辆，请先录入车牌。"
    });
  },

  login() {
    wx.login({
      success: (res) => {
        if (!res.code) {
          wx.showToast({ title: "登录失败", icon: "none" });
          return;
        }
        this.loginWithCodeAndRefresh(res.code);
      },
      fail: () => {
        wx.showToast({ title: "登录失败", icon: "none" });
      }
    });
  },

  async loginWithCodeAndRefresh(code) {
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
          // User cancelled
        }
      }

      const loginResult = await api.login(code, userInfo);
      wx.setStorageSync("auth_token", loginResult.token);

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
      wx.showToast({ title: "已登录", icon: "success" });
      this.refresh();
    } catch (error) {
      console.error("Login failed:", error.message);
      showErrorModal("登录失败", error, "登录失败，请检查网络或云托管配置。");
    } finally {
      this.setData({ loading: false });
    }
  },

  onInput(event) {
    const key = event.currentTarget.dataset.key;
    this.setData({ [`form.${key}`]: event.detail.value });
  },

  onVehicleTypeChange(event) {
    this.setData({
      "form.vehicleType": vehicleTypeOptions[Number(event.detail.value)].value
    });
  },

  async addVehicle() {
    if (!getLoggedInUser()) {
      wx.showToast({ title: "请先登录", icon: "none" });
      return;
    }

    const plate = (this.data.form.plateNumber || "").trim();
    const type = this.data.form.vehicleType || "fuel";

    if (!plate) {
      wx.showToast({ title: "请输入车牌", icon: "none" });
      return;
    }

    this.setData({ loading: true });
    try {
      await asyncAddVehicle(plate, type);
      this.setData({ form: buildEmptyForm() });
      await this.refresh();
      wx.showToast({ title: "已添加车辆", icon: "success" });
    } catch (error) {
      console.error("Add vehicle failed:", error.message);
      const msg = error.message.includes("PLATE_DUPLICATED")
        ? "车牌已存在"
        : error.message.includes("MISSING_PLATE")
          ? "请输入车牌"
          : "添加失败，请检查网络";
      wx.showToast({ title: msg, icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  useVehicle(event) {
    const id = event.currentTarget.dataset.id;
    setCurrentVehicleId(id);
    this.refresh();
  },

  async removeVehicle(event) {
    const id = event.currentTarget.dataset.id;
    this.setData({ loading: true });
    try {
      await asyncDeleteVehicle(id);
      await this.refresh();
      wx.showToast({ title: "已删除", icon: "success" });
    } catch (e) {
      console.error("Delete vehicle failed:", e.message);
      wx.showToast({ title: "删除失败，请检查网络", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  }
});
