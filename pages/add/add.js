const {
  buildOwnerFromUser,
  findParkingLot,
  getLoggedInUser,
  saveUserParkingLot,
  updateCurrentUserProfile,
  updateUserParkingLot,
  asyncSaveUserParkingLot,
  asyncUpdateUserParkingLot
} = require("../../utils/storage");
const api = require("../../utils/api");
const { requestParkingRecognition } = require("../../utils/api");

const LOGIN_KEY = "parkingLoginState";
const CURRENT_USER_KEY = "parkingCurrentUser";

const availabilityOptions = [
  { label: "车位较稳", value: "high" },
  { label: "车位一般", value: "medium" },
  { label: "可能满位", value: "low" },
  { label: "待确认", value: "unknown" }
];

function todayText() {
  const date = new Date();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function numberFromForm(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function textValue(value) {
  return value == null ? "" : `${value}`;
}

function optionalTextValue(value) {
  return value == null ? "" : `${value}`;
}

function inferMediaType(path) {
  const value = String(path || "").toLowerCase();
  if (value.indexOf(".png") >= 0) {
    return "image/png";
  }
  if (value.indexOf(".webp") >= 0) {
    return "image/webp";
  }
  return "image/jpeg";
}

function buildEmptyForm() {
  return {
    name: "",
    address: "",
    entrance: "",
    latitude: "",
    longitude: "",
    amapPoiId: "",
    freeMinutes: "60",
    billingUnitMinutes: "60",
    unitPrice: "5",
    maxDailyPrice: "",
    notes: "",
    newEnergyEnabled: false,
    newEnergyFreeMinutes: "120",
    newEnergyBillingUnitMinutes: "",
    newEnergyUnitPrice: "",
    newEnergyMaxDailyPrice: "",
    newEnergyNotes: "",
    walkingPenaltyMinutes: "0"
  };
}

function formFromLot(lot) {
  const location = lot.location || {};
  const amap = location.amap || {};
  const pricing = lot.pricing || {};
  const pricingByVehicle = pricing.pricingByVehicle || {};
  const newEnergyRule = pricingByVehicle.new_energy || null;
  const access = lot.access || {};

  return {
    name: textValue(lot.name),
    address: textValue(lot.address),
    entrance: textValue(access.entrance),
    latitude: textValue(location.latitude),
    longitude: textValue(location.longitude),
    amapPoiId: textValue(amap.poiId),
    freeMinutes: textValue(pricing.freeMinutes || 0),
    billingUnitMinutes: textValue(pricing.billingUnitMinutes || 60),
    unitPrice: textValue(pricing.unitPrice || 0),
    maxDailyPrice: pricing.maxDailyPrice ? textValue(pricing.maxDailyPrice) : "",
    notes: textValue(pricing.notes),
    newEnergyEnabled: Boolean(newEnergyRule),
    newEnergyFreeMinutes: newEnergyRule ? textValue(newEnergyRule.freeMinutes || 0) : "120",
    newEnergyBillingUnitMinutes: newEnergyRule ? optionalTextValue(newEnergyRule.billingUnitMinutes) : "",
    newEnergyUnitPrice: newEnergyRule ? optionalTextValue(newEnergyRule.unitPrice) : "",
    newEnergyMaxDailyPrice: newEnergyRule ? optionalTextValue(newEnergyRule.maxDailyPrice) : "",
    newEnergyNotes: newEnergyRule ? textValue(newEnergyRule.notes) : "",
    walkingPenaltyMinutes: textValue(access.walkingPenaltyMinutes || 0)
  };
}

Page({
  data: {
    availabilityOptions,
    availabilityIndex: 1,
    availabilityLabel: availabilityOptions[1].label,
    isLoggedIn: false,
    loginRequired: true,
    isEditing: false,
    editId: "",
    pageTitle: "录入停车场",
    introText: "可通过拍照和定位采集停车场来源，再人工复核收费规则。系统会按目的地距离、预计停车时长、车位情况和数据可信度综合推荐。",
    saveButtonText: "保存并参与推荐",
    evidencePhotos: [],
    photoCount: 0,
    recognitionStatus: "未采集照片",
    recognitionHint: "可拍摄停车场入口或收费牌，再结合定位形成可复核数据源。",
    isRecognizing: false,
    canRecognize: false,
    recognizeDisabled: true,
    recognitionWarnings: [],
    recognitionWarningText: ""
  },

  onLoad(query) {
    const editId = query && query.id ? query.id : "";
    this.pendingEditId = editId;
    this.bootstrap(editId);
  },

  bootstrap(editId) {
    const user = getLoggedInUser();
    if (!user) {
      this.setData({
        isLoggedIn: false,
        loginRequired: true,
        isEditing: Boolean(editId),
        editId: editId || "",
        pageTitle: editId ? "维护停车场" : "录入停车场",
        introText: "登录后才能上报或维护停车场信息，来源会展示为你的用户头像。",
        saveButtonText: editId ? "保存修改" : "保存并参与推荐"
      });
      return;
    }

    this.setData({
      isLoggedIn: true,
      loginRequired: false
    });

    if (editId) {
      this.loadEditableLot(editId);
      return;
    }

    this.setData({
      isEditing: false,
      editId: "",
      pageTitle: "录入停车场",
      introText: "可通过拍照和定位采集停车场来源，再人工复核收费规则。系统会按目的地距离、预计停车时长、车位情况和数据可信度综合推荐。",
      saveButtonText: "保存并参与推荐",
      availabilityIndex: 1,
      availabilityLabel: availabilityOptions[1].label,
      evidencePhotos: [],
      photoCount: 0,
      recognitionStatus: "未采集照片",
      recognitionHint: "可拍摄停车场入口或收费牌，再结合定位形成可复核数据源。",
      recognitionWarnings: [],
      recognitionWarningText: "",
      canRecognize: false,
      recognizeDisabled: true,
      form: buildEmptyForm()
    });
  },

  loginAndContinue() {
    wx.login({
      success: (res) => {
        if (!res.code) {
          wx.showToast({
            title: "登录失败",
            icon: "none"
          });
          return;
        }

        this.loginWithCodeAndContinue(res.code);
      },
      fail: () => {
        wx.showToast({
          title: "登录失败",
          icon: "none"
        });
      }
    });
  },

  async loginWithCodeAndContinue(code) {
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
      wx.showToast({
        title: "已登录",
        icon: "success"
      });
      this.bootstrap(this.pendingEditId || this.data.editId);
    } catch (error) {
      console.warn("Backend login failed, falling back to local:", error.message);
      wx.setStorageSync(LOGIN_KEY, { loggedAt: Date.now() });
      this.bootstrap(this.pendingEditId || this.data.editId);
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
        }
      }
    });
  },

  loadEditableLot(editId) {
    const lot = findParkingLot(editId);
    if (!lot || !lot.canEdit) {
      wx.showToast({
        title: lot ? "只能维护自己上报的信息" : "未找到停车场",
        icon: "none"
      });
      setTimeout(() => {
        wx.navigateBack();
      }, 600);
      return;
    }

    const availabilityIndex = Math.max(0, availabilityOptions.findIndex((item) => item.value === lot.availability));
    const evidence = lot.evidence || {};
    const photos = Array.isArray(evidence.photos) ? evidence.photos : [];
    const warnings = Array.isArray(evidence.recognitionWarnings) ? evidence.recognitionWarnings : [];

    this.setData({
      isEditing: true,
      editId,
      pageTitle: "维护停车场",
      introText: "你正在维护自己上报的停车场。保存修改后，旧的点赞/踩会清空，可信度会回到 50，等待其他用户重新确认。",
      saveButtonText: "保存修改",
      availabilityIndex,
      availabilityLabel: availabilityOptions[availabilityIndex].label,
      evidencePhotos: photos,
      photoCount: photos.length,
      recognitionStatus: evidence.recognitionStatus || (photos.length ? "已采集，待复核" : "未采集照片"),
      recognitionHint: photos.length
        ? "已载入原有现场图片。修改保存后可信度将重置。"
        : "可补充拍摄入口或收费牌，帮助其他用户复核。",
      recognitionWarnings: warnings,
      recognitionWarningText: warnings.join("；"),
      canRecognize: photos.length > 0,
      recognizeDisabled: photos.length <= 0,
      form: formFromLot(lot)
    });
  },

  onInput(event) {
    const key = event.currentTarget.dataset.key;
    this.setData({
      [`form.${key}`]: event.detail.value
    });
  },

  onSwitchChange(event) {
    const key = event.currentTarget.dataset.key;
    this.setData({
      [`form.${key}`]: Boolean(event.detail.value)
    });
  },

  onAvailabilityChange(event) {
    const availabilityIndex = Number(event.detail.value);
    this.setData({
      availabilityIndex,
      availabilityLabel: availabilityOptions[availabilityIndex].label
    });
  },

  useCurrentLocation() {
    wx.getLocation({
      type: "gcj02",
      success: (res) => {
        this.setData({
          "form.latitude": `${res.latitude}`,
          "form.longitude": `${res.longitude}`
        });
        wx.showToast({
          title: "已填入坐标",
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

  chooseParkingLocation() {
    wx.chooseLocation({
      success: (res) => {
        this.setData({
          "form.name": this.data.form.name || res.name || "",
          "form.address": res.address || this.data.form.address || "",
          "form.latitude": `${res.latitude}`,
          "form.longitude": `${res.longitude}`
        });
        wx.showToast({
          title: "已选择位置",
          icon: "success"
        });
      },
      fail: () => {
        wx.showToast({
          title: "未选择位置",
          icon: "none"
        });
      }
    });
  },

  async captureEvidence() {
    wx.chooseMedia({
      count: 3,
      mediaType: ["image"],
      sourceType: ["camera", "album"],
      camera: "back",
      success: async (res) => {
        const newPhotos = [];
        for (const file of res.tempFiles) {
          const photo = {
            path: file.tempFilePath,
            size: file.size || 0,
            capturedAt: Date.now()
          };

          // Try to upload the image to backend
          try {
            const uploadedUrl = await api.uploadImage(file.tempFilePath);
            if (uploadedUrl) {
              photo.uploadedUrl = uploadedUrl;
              photo.uploaded = true;
            }
          } catch (e) {
            console.warn("Image upload failed, keeping temp path:", e.message);
          }

          newPhotos.push(photo);
        }

        const evidencePhotos = this.data.evidencePhotos.concat(newPhotos).slice(0, 6);
        this.setData({
          evidencePhotos,
          photoCount: evidencePhotos.length,
          canRecognize: evidencePhotos.length > 0,
          recognizeDisabled: evidencePhotos.length <= 0,
          recognitionStatus: "已采集，待识别/复核",
          recognitionHint: "当前已保存照片证据和定位字段。接入 OCR 后可自动回填免费时长、计费单位和价格。"
        });

        if (!this.data.form.latitude || !this.data.form.longitude) {
          this.useCurrentLocation();
        }
      },
      fail: () => {
        wx.showToast({
          title: "未选择照片",
          icon: "none"
        });
      }
    });
  },

  previewEvidence(event) {
    const index = Number(event.currentTarget.dataset.index) || 0;
    const urls = this.data.evidencePhotos.map((photo) => photo.path);
    wx.previewImage({
      current: urls[index],
      urls
    });
  },

  removeEvidence(event) {
    const index = Number(event.currentTarget.dataset.index) || 0;
    const evidencePhotos = this.data.evidencePhotos.filter((item, itemIndex) => itemIndex !== index);
    this.setData({
      evidencePhotos,
      photoCount: evidencePhotos.length,
      canRecognize: evidencePhotos.length > 0,
      recognizeDisabled: evidencePhotos.length <= 0 || this.data.isRecognizing,
      recognitionStatus: evidencePhotos.length ? "已采集，待识别/复核" : "未采集照片",
      recognitionHint: evidencePhotos.length
        ? "当前已保存照片证据和定位字段。接入 OCR 后可自动回填免费时长、计费单位和价格。"
        : "可拍摄停车场入口或收费牌，再结合定位形成可复核数据源。"
    });
  },

  readPhotoBase64(photo) {
    const filePath = photo.localPath || photo.tempFilePath || photo.path;
    return new Promise((resolve, reject) => {
      wx.getFileSystemManager().readFile({
        filePath,
        encoding: "base64",
        success: (res) => {
          resolve({
            base64: res.data,
            mediaType: inferMediaType(filePath)
          });
        },
        fail: reject
      });
    });
  },

  requestRecognition(payload) {
    return requestParkingRecognition(payload);
  },

  applyRecognition(recognition) {
    const result = recognition || {};
    const pricing = result.pricing || {};
    const location = result.location || {};
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    const updates = {
      "form.name": result.name || this.data.form.name,
      "form.address": result.address || this.data.form.address,
      "form.entrance": result.entrance || this.data.form.entrance,
      "form.freeMinutes": `${pricing.freeMinutes == null ? this.data.form.freeMinutes : pricing.freeMinutes}`,
      "form.billingUnitMinutes": `${pricing.billingUnitMinutes == null ? this.data.form.billingUnitMinutes : pricing.billingUnitMinutes}`,
      "form.unitPrice": `${pricing.unitPrice == null ? this.data.form.unitPrice : pricing.unitPrice}`,
      "form.maxDailyPrice": pricing.maxDailyPrice ? `${pricing.maxDailyPrice}` : this.data.form.maxDailyPrice,
      "form.notes": pricing.notes || this.data.form.notes,
      "form.walkingPenaltyMinutes": `${result.walkingPenaltyMinutes == null ? this.data.form.walkingPenaltyMinutes : result.walkingPenaltyMinutes}`,
      recognitionWarnings: warnings,
      recognitionWarningText: warnings.join("；"),
      recognitionStatus: `已识别，可信度 ${result.confidence || 0}`,
      recognitionHint: result.evidenceSummary || "已根据照片和定位回填字段，请保存前复核。"
    };

    if (location.latitude != null) {
      updates["form.latitude"] = `${location.latitude}`;
    }
    if (location.longitude != null) {
      updates["form.longitude"] = `${location.longitude}`;
    }
    if (location.amapPoiId) {
      updates["form.amapPoiId"] = location.amapPoiId;
    }

    if (result.availability) {
      const index = availabilityOptions.findIndex((item) => item.value === result.availability);
      if (index >= 0) {
        updates.availabilityIndex = index;
        updates.availabilityLabel = availabilityOptions[index].label;
      }
    }

    this.setData(updates);
  },

  async recognizeEvidence() {
    if (!this.data.evidencePhotos.length) {
      wx.showToast({
        title: "请先拍照",
        icon: "none"
      });
      return;
    }

    this.setData({
      isRecognizing: true,
      recognizeDisabled: true,
      recognitionStatus: "识别中",
      recognitionHint: "正在读取照片并请求识别接口。"
    });

    try {
      const photos = await Promise.all(this.data.evidencePhotos.slice(0, 3).map((photo) => this.readPhotoBase64(photo)));
      const response = await this.requestRecognition({
        photos,
        form: this.data.form,
        textHint: this.data.form.notes
      });

      this.applyRecognition(response.recognition);
      wx.showToast({
        title: "识别完成",
        icon: "success"
      });
    } catch (error) {
      this.setData({
        recognitionStatus: "识别失败，待人工复核",
        recognitionHint: error.message || "识别接口不可用，请检查本地 API 或网络配置。"
      });
      wx.showToast({
        title: "识别失败",
        icon: "none"
      });
    } finally {
      this.setData({
        isRecognizing: false,
        recognizeDisabled: this.data.evidencePhotos.length <= 0
      });
    }
  },

  validate(form) {
    if (!form.name.trim()) {
      return "请填写停车场名称";
    }
    if (!form.address.trim()) {
      return "请填写地址";
    }
    if (!Number.isFinite(Number(form.latitude)) || !Number.isFinite(Number(form.longitude))) {
      return "请填写有效坐标";
    }
    if (numberFromForm(form.billingUnitMinutes, 0) <= 0) {
      return "计费单位必须大于 0";
    }
    if (numberFromForm(form.unitPrice, -1) < 0) {
      return "价格不能为负数";
    }
    return "";
  },

  buildLotPayload(user) {
    const form = this.data.form;
    const maxDailyPrice = numberFromForm(form.maxDailyPrice, 0);
    const availability = availabilityOptions[this.data.availabilityIndex].value;
    const basePricing = {
      freeMinutes: numberFromForm(form.freeMinutes, 0),
      billingUnitMinutes: numberFromForm(form.billingUnitMinutes, 60),
      unitPrice: numberFromForm(form.unitPrice, 0),
      maxDailyPrice,
      minCharge: 0,
      notes: form.notes.trim()
    };

    if (form.newEnergyEnabled) {
      const newEnergyFreeMinutes = numberFromForm(form.newEnergyFreeMinutes, 120);
      basePricing.pricingByVehicle = {
        new_energy: {
          freeMinutes: newEnergyFreeMinutes,
          notes: form.newEnergyNotes.trim() || `新能源${newEnergyFreeMinutes}分钟免费，之后按默认规则计费`
        }
      };

      if (form.newEnergyBillingUnitMinutes.trim()) {
        basePricing.pricingByVehicle.new_energy.billingUnitMinutes = numberFromForm(form.newEnergyBillingUnitMinutes, basePricing.billingUnitMinutes);
      }
      if (form.newEnergyUnitPrice.trim()) {
        basePricing.pricingByVehicle.new_energy.unitPrice = numberFromForm(form.newEnergyUnitPrice, basePricing.unitPrice);
      }
      if (form.newEnergyMaxDailyPrice.trim()) {
        basePricing.pricingByVehicle.new_energy.maxDailyPrice = numberFromForm(form.newEnergyMaxDailyPrice, basePricing.maxDailyPrice);
      }
    }

    return {
      name: form.name.trim(),
      address: form.address.trim(),
      source: "user",
      updatedAt: todayText(),
      ownerId: user.id,
      owner: buildOwnerFromUser(user),
      availability,
      distanceHintMeters: 500,
      location: {
        latitude: numberFromForm(form.latitude, 0),
        longitude: numberFromForm(form.longitude, 0),
        amap: {
          poiId: form.amapPoiId.trim(),
          name: form.name.trim()
        }
      },
      access: {
        entrance: form.entrance.trim() || "入口待补充",
        walkingPenaltyMinutes: numberFromForm(form.walkingPenaltyMinutes, 0),
        tags: []
      },
      pricing: basePricing,
      evidence: {
        photos: this.data.evidencePhotos,
        recognitionStatus: this.data.recognitionStatus,
        recognitionWarnings: this.data.recognitionWarnings,
        capturedLocation: {
          latitude: numberFromForm(form.latitude, 0),
          longitude: numberFromForm(form.longitude, 0)
        },
        capturedAt: Date.now()
      }
    };
  },

  /**
   * Build the payload for the backend API (field names match server expectations)
   */
  buildApiPayload(user) {
    const form = this.data.form;
    const availability = availabilityOptions[this.data.availabilityIndex].value;
    const basePricing = {
      freeMinutes: numberFromForm(form.freeMinutes, 0),
      billingUnitMinutes: numberFromForm(form.billingUnitMinutes, 60),
      unitPrice: numberFromForm(form.unitPrice, 0),
      maxDailyPrice: numberFromForm(form.maxDailyPrice, 0),
      minCharge: 0,
      notes: form.notes.trim()
    };

    if (form.newEnergyEnabled) {
      const newEnergyFreeMinutes = numberFromForm(form.newEnergyFreeMinutes, 120);
      basePricing.pricingByVehicle = {
        new_energy: {
          freeMinutes: newEnergyFreeMinutes,
          notes: form.newEnergyNotes.trim() || `新能源${newEnergyFreeMinutes}分钟免费，之后按默认规则计费`
        }
      };

      if (form.newEnergyBillingUnitMinutes.trim()) {
        basePricing.pricingByVehicle.new_energy.billingUnitMinutes = numberFromForm(form.newEnergyBillingUnitMinutes, basePricing.billingUnitMinutes);
      }
      if (form.newEnergyUnitPrice.trim()) {
        basePricing.pricingByVehicle.new_energy.unitPrice = numberFromForm(form.newEnergyUnitPrice, basePricing.unitPrice);
      }
      if (form.newEnergyMaxDailyPrice.trim()) {
        basePricing.pricingByVehicle.new_energy.maxDailyPrice = numberFromForm(form.newEnergyMaxDailyPrice, basePricing.maxDailyPrice);
      }
    }

    const evidencePhotos = this.data.evidencePhotos.map((photo) => photo.uploadedUrl || photo.path);

    return {
      name: form.name.trim(),
      address: form.address.trim(),
      latitude: numberFromForm(form.latitude, 0),
      longitude: numberFromForm(form.longitude, 0),
      entrance_tip: form.entrance.trim() || "",
      availability,
      walk_extra_minutes: numberFromForm(form.walkingPenaltyMinutes, 0),
      pricing: basePricing,
      evidence_photos: evidencePhotos
    };
  },

  async save() {
    const user = getLoggedInUser();
    if (!user) {
      this.setData({
        isLoggedIn: false,
        loginRequired: true
      });
      wx.showToast({
        title: "请先登录",
        icon: "none"
      });
      return;
    }

    const form = this.data.form;
    const error = this.validate(form);
    if (error) {
      wx.showToast({
        title: error,
        icon: "none"
      });
      return;
    }

    const payload = this.buildLotPayload(user);
    const apiPayload = this.buildApiPayload(user);

    if (this.data.isEditing) {
      // Try backend first
      try {
        const updatedLot = await api.updateParkingLot(this.data.editId, apiPayload);
        updateUserParkingLot(this.data.editId, updatedLot || payload);
        wx.showToast({
          title: "已保存修改",
          icon: "success"
        });
      } catch (e) {
        console.warn("Update via API failed, falling back to local:", e.message);
        updateUserParkingLot(this.data.editId, payload);
        wx.showToast({
          title: "已保存修改（离线）",
          icon: "none"
        });
      }
    } else {
      const newLot = {
        ...payload,
        id: `user_${Date.now()}`,
        confidence: this.data.evidencePhotos.length ? 68 : 58
      };

      // Try backend first
      try {
        const savedLot = await api.createParkingLot(apiPayload);
        // Also save locally for cache
        saveUserParkingLot(savedLot || newLot);
        wx.showToast({
          title: "已保存",
          icon: "success"
        });
      } catch (e) {
        console.warn("Create via API failed, falling back to local:", e.message);
        saveUserParkingLot(newLot);
        wx.showToast({
          title: "已保存（离线）",
          icon: "none"
        });
      }
    }

    setTimeout(() => {
      wx.navigateBack();
    }, 500);
  }
});
