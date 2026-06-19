const {
  getLoggedInUser,
  updateCurrentUserProfile,
  getCurrentVehicleId,
  setCurrentVehicleId,
  asyncGetUserVehicles,
  asyncAddVehicle,
  asyncUpdateVehicle,
  asyncDeleteVehicle
} = require("../../utils/storage");
const api = require("../../utils/api");
const { showErrorModal } = require("../../utils/error");

const LOGIN_KEY = "parkingLoginState";
const CURRENT_USER_KEY = "parkingCurrentUser";
const PLATE_MAX_LENGTH = 8;

const provinceKeys = [
  ["京", "津", "沪", "渝", "冀", "豫", "云", "辽", "黑", "湘"],
  ["皖", "鲁", "新", "苏", "浙", "赣", "鄂", "桂", "甘", "晋"],
  ["蒙", "陕", "吉", "闽", "贵", "粤", "青", "藏", "川", "宁"],
  ["琼", "港", "澳", "台"]
];

const letterKeys = [
  ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
  ["Q", "W", "E", "R", "T", "Y", "U", "P", "A", "S"],
  ["D", "F", "G", "H", "J", "K", "L", "Z", "X", "C"],
  ["V", "B", "N", "M", "学", "警", "港", "澳", "删除"]
];

const firstLetterKeys = [
  ["Q", "W", "E", "R", "T", "Y", "U", "P", "A", "S"],
  ["D", "F", "G", "H", "J", "K", "L", "Z", "X", "C"],
  ["V", "B", "N", "M"]
];

const SPECIAL_SUFFIX_KEYS = ["学", "警", "港", "澳"];

function buildEmptyPlateSlots() {
  return Array.from({ length: PLATE_MAX_LENGTH }, (_, index) => ({
    index,
    value: "",
    active: index === 0,
    filled: false
  }));
}

function normalizePlate(rawPlate) {
  return String(rawPlate || "")
    .toUpperCase()
    .replace(/[·\s-]/g, "")
    .slice(0, PLATE_MAX_LENGTH);
}

function formatPlate(plate) {
  const normalized = normalizePlate(plate);
  if (normalized.length <= 2) return normalized;
  return `${normalized.slice(0, 2)}·${normalized.slice(2)}`;
}

function detectVehicleType(plate) {
  return normalizePlate(plate).length === PLATE_MAX_LENGTH ? "new_energy" : "fuel";
}

function vehicleTypeLabel(type) {
  return type === "new_energy" ? "新能源小型车" : "燃油小型车";
}

function buildPlateSlots(plate) {
  const chars = normalizePlate(plate).split("");
  const activeIndex = Math.min(chars.length, PLATE_MAX_LENGTH - 1);
  return Array.from({ length: PLATE_MAX_LENGTH }, (_, index) => ({
    index,
    value: chars[index] || "",
    active: index === activeIndex,
    filled: Boolean(chars[index])
  }));
}

function decorateVehicle(vehicle) {
  const type = vehicle.vehicleType || detectVehicleType(vehicle.plateNumber);
  return {
    ...vehicle,
    plateDisplay: formatPlate(vehicle.plateNumber),
    vehicleType: type,
    vehicleTypeLabel: vehicle.vehicleTypeLabel || vehicleTypeLabel(type),
    energyClass: type === "new_energy" ? "is-new-energy" : "is-fuel"
  };
}

function canUseKey(key, index) {
  if (index === 0) return false;
  if (index === 1) {
    return /^[A-Z]$/.test(key);
  }
  return /^[A-Z0-9]$/.test(key) || SPECIAL_SUFFIX_KEYS.indexOf(key) >= 0;
}

function buildEmptyForm() {
  return {
    plateNumber: "",
    vehicleType: "fuel",
    plateDisplay: "",
    vehicleTypeLabel: "燃油小型车",
    plateSlots: buildEmptyPlateSlots(),
    activePlateIndex: 0,
    keyboardMode: "province"
  };
}

Page({
  data: {
    isLoggedIn: false,
    loginRequired: true,
    form: buildEmptyForm(),
    provinceKeys,
    letterKeys,
    firstLetterKeys,
    keyboardTitle: "选择省份简称",
    showAddPanel: false,
    panelMode: "add",
    panelTitle: "添加爱车",
    confirmButtonText: "确定",
    editingVehicleId: "",
    vehicles: [],
    currentVehicleId: "",
    currentVehicleLabel: "未设置",
    emptyText: "暂无车辆，请先录入车牌。",
    pageTitle: "我的爱车",
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
      vehicles = (await asyncGetUserVehicles()).map(decorateVehicle);
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
        ? `${currentVehicle.plateDisplay} · ${currentVehicle.vehicleTypeLabel}`
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

  openAddPanel() {
    this.setData({
      showAddPanel: true,
      panelMode: "add",
      panelTitle: "添加爱车",
      confirmButtonText: "确定",
      editingVehicleId: "",
      form: buildEmptyForm(),
      keyboardTitle: "选择省份简称"
    });
  },

  openEditPanel(event) {
    const id = event.currentTarget.dataset.id;
    const vehicle = this.data.vehicles.find((item) => `${item.id}` === `${id}`);
    if (!vehicle) return;

    const plate = normalizePlate(vehicle.plateNumber);
    this.setData({
      showAddPanel: true,
      panelMode: "edit",
      panelTitle: "编辑车牌号",
      confirmButtonText: "保存",
      editingVehicleId: id
    });
    this.updatePlateForm(plate, Math.max(0, plate.length - 1));
  },

  closeAddPanel() {
    this.setData({
      showAddPanel: false,
      panelMode: "add",
      panelTitle: "添加爱车",
      confirmButtonText: "确定",
      editingVehicleId: "",
      form: buildEmptyForm()
    });
  },

  stopPanelTap() {},

  setPlateFocus(event) {
    const index = Number(event.currentTarget.dataset.index) || 0;
    const plateLength = normalizePlate(this.data.form.plateNumber).length;
    this.updatePlateForm(this.data.form.plateNumber, Math.min(index, plateLength));
  },

  onPlateKeyTap(event) {
    const key = event.currentTarget.dataset.key;
    if (!key) return;
    if (key === "删除") {
      this.deletePlateKey();
      return;
    }

    const plate = normalizePlate(this.data.form.plateNumber);
    const chars = plate.split("");
    const activeIndex = Number(this.data.form.activePlateIndex) || 0;

    if (activeIndex === 0) {
      chars[0] = key;
      this.updatePlateForm(chars.join(""), 1);
      return;
    }

    if (!canUseKey(key, activeIndex)) return;

    chars[activeIndex] = key;
    const nextPlate = chars.join("");
    const nextIndex = Math.min(activeIndex + 1, PLATE_MAX_LENGTH - 1);
    this.updatePlateForm(nextPlate, nextIndex);
  },

  deletePlateKey() {
    const chars = normalizePlate(this.data.form.plateNumber).split("");
    let activeIndex = Number(this.data.form.activePlateIndex) || 0;
    const hasCurrentValue = Boolean(chars[activeIndex]);
    const deleteIndex = hasCurrentValue ? activeIndex : Math.max(0, activeIndex - 1);
    chars.splice(deleteIndex, 1);
    activeIndex = Math.max(0, deleteIndex);
    this.updatePlateForm(chars.join(""), activeIndex);
  },

  updatePlateForm(rawPlate, focusIndex) {
    const plate = normalizePlate(rawPlate);
    const maxFocusIndex = Math.min(plate.length, PLATE_MAX_LENGTH - 1);
    const activeIndex = Math.min(
      maxFocusIndex,
      Math.max(0, Number.isFinite(Number(focusIndex)) ? Number(focusIndex) : plate.length)
    );
    const type = detectVehicleType(plate);
    this.setData({
      form: {
        plateNumber: plate,
        vehicleType: type,
        plateDisplay: formatPlate(plate),
        vehicleTypeLabel: vehicleTypeLabel(type),
        plateSlots: buildPlateSlots(plate).map((slot) => ({
          ...slot,
          active: slot.index === activeIndex
        })),
        activePlateIndex: activeIndex,
        keyboardMode: activeIndex === 0 ? "province" : "letters"
      },
      keyboardTitle: activeIndex === 0 ? "选择省份简称" : "输入车牌号码"
    });
  },

  validatePlate(plate) {
    const normalized = normalizePlate(plate);
    if (normalized.length !== 7 && normalized.length !== 8) {
      return "请输入完整车牌";
    }
    if (!/^[\u4e00-\u9fa5][A-Z][A-Z0-9\u4e00-\u9fa5]{5,6}$/.test(normalized)) {
      return "车牌格式不正确";
    }
    return "";
  },

  async addVehicle() {
    if (!getLoggedInUser()) {
      wx.showToast({ title: "请先登录", icon: "none" });
      return;
    }

    const plate = normalizePlate(this.data.form.plateNumber);
    const type = detectVehicleType(plate);
    const validationMessage = this.validatePlate(plate);

    if (validationMessage) {
      wx.showToast({ title: validationMessage, icon: "none" });
      return;
    }

    this.setData({ loading: true });
    try {
      await asyncAddVehicle(plate, type);
      this.setData({ form: buildEmptyForm(), showAddPanel: false });
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

  async saveVehicle() {
    if (this.data.panelMode !== "edit") {
      await this.addVehicle();
      return;
    }

    if (!getLoggedInUser()) {
      wx.showToast({ title: "请先登录", icon: "none" });
      return;
    }

    const id = this.data.editingVehicleId;
    const plate = normalizePlate(this.data.form.plateNumber);
    const type = detectVehicleType(plate);
    const validationMessage = this.validatePlate(plate);

    if (!id) {
      wx.showToast({ title: "请选择车辆", icon: "none" });
      return;
    }

    if (validationMessage) {
      wx.showToast({ title: validationMessage, icon: "none" });
      return;
    }

    this.setData({ loading: true });
    try {
      await asyncUpdateVehicle(id, plate, type);
      this.closeAddPanel();
      await this.refresh();
      wx.showToast({ title: "已保存", icon: "success" });
    } catch (error) {
      console.error("Update vehicle failed:", error.message);
      const msg = error.message.includes("PLATE_DUPLICATED")
        ? "车牌已存在"
        : error.message.includes("MISSING_PLATE")
          ? "请输入车牌"
          : "保存失败，请检查网络";
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
