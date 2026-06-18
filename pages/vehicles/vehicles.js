const {
  deleteUserVehicle,
  getCurrentVehicle,
  getLoggedInUser,
  getUserVehicles,
  saveUserVehicle,
  setCurrentVehicle,
  asyncGetUserVehicles,
  asyncAddVehicle,
  asyncDeleteVehicle
} = require("../../utils/storage");
const api = require("../../utils/api");

const LOGIN_KEY = "parkingLoginState";
const CURRENT_USER_KEY = "parkingCurrentUser";

const vehicleTypeOptions = [
  { label: "新能源小型车", value: "new_energy" },
  { label: "燃油小型车", value: "fuel" }
];

function buildEmptyForm() {
  return {
    plateNumber: "",
    vehicleType: "fuel"
  };
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
    pageTitle: "车辆管理"
  },

  onLoad() {
    this.refresh();
  },

  onShow() {
    this.refresh();
  },

  async refresh() {
    const loggedIn = Boolean(getLoggedInUser());
    let vehicles;
    try {
      vehicles = await asyncGetUserVehicles();
    } catch (e) {
      vehicles = getUserVehicles();
    }
    const currentVehicle = getCurrentVehicle();

    this.setData({
      isLoggedIn: loggedIn,
      loginRequired: !loggedIn,
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
          wx.showToast({
            title: "登录失败",
            icon: "none"
          });
          return;
        }

        this.loginWithCodeAndRefresh(res.code);
      },
      fail: () => {
        wx.showToast({
          title: "登录失败",
          icon: "none"
        });
      }
    });
  },

  async loginWithCodeAndRefresh(code) {
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
          }
        } catch (e) {
          // User cancelled or not supported
        }
      }

      const loginResult = await api.login(code, userInfo);
      const token = loginResult.token;
      wx.setStorageSync("auth_token", token);

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
      this.refresh();
    } catch (error) {
      console.warn("Backend login failed, falling back to local:", error.message);
      wx.setStorageSync(LOGIN_KEY, { loggedAt: Date.now() });
      this.refresh();
    }
  },

  onInput(event) {
    const key = event.currentTarget.dataset.key;
    this.setData({
      [`form.${key}`]: event.detail.value
    });
  },

  onVehicleTypeChange(event) {
    this.setData({
      "form.vehicleType": vehicleTypeOptions[Number(event.detail.value)].value
    });
  },

  async addVehicle() {
    if (!getLoggedInUser()) {
      wx.showToast({
        title: "请先登录",
        icon: "none"
      });
      return;
    }

    const plate = (this.data.form.plateNumber || "").trim();
    const type = this.data.form.vehicleType || "fuel";

    if (!plate) {
      wx.showToast({
        title: "请输入车牌",
        icon: "none"
      });
      return;
    }

    try {
      await asyncAddVehicle(plate, type);
      this.setData({
        form: buildEmptyForm()
      });
      this.refresh();
      wx.showToast({
        title: "已添加车辆",
        icon: "success"
      });
    } catch (error) {
      wx.showToast({
        title: error.message === "PLATE_REQUIRED" ? "请输入车牌" : "车牌已存在",
        icon: "none"
      });
    }
  },

  useVehicle(event) {
    const id = event.currentTarget.dataset.id;
    setCurrentVehicle(id);
    this.refresh();
  },

  async removeVehicle(event) {
    const id = event.currentTarget.dataset.id;
    try {
      await asyncDeleteVehicle(id);
    } catch (e) {
      console.warn("Delete vehicle failed:", e.message);
    }
    this.refresh();
  }
});
