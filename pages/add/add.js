const {
  getLoggedInUser,
  updateCurrentUserProfile,
  asyncGetParkingLotDetail,
  asyncSaveUserParkingLot,
  asyncUpdateUserParkingLot
} = require("../../utils/storage");
const api = require("../../utils/api");
const { requestParkingRecognition } = require("../../utils/api");
const { showErrorModal } = require("../../utils/error");

const LOGIN_KEY = "parkingLoginState";
const CURRENT_USER_KEY = "parkingCurrentUser";
const EVIDENCE_IMAGE_QUALITY = 70;

const availabilityOptions = [
  { label: "车位较稳", value: "high" },
  { label: "车位一般", value: "medium" },
  { label: "可能满位", value: "low" },
  { label: "待确认", value: "unknown" }
];

const chargeTypeOptions = [
  { label: "按时计费", value: "hourly", hint: "免费后按固定时间单价累计" },
  { label: "按次/包段", value: "flat", hint: "一次收费或按 24 小时重复" },
  { label: "阶梯计费", value: "ladder", hint: "不同停车时段不同价格" }
];

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

function optionIndex(options, value, fallbackIndex) {
  const index = options.findIndex((item) => item.value === value);
  return index >= 0 ? index : fallbackIndex;
}

function defaultLadderRows() {
  return [
    { id: "tier-1", untilMinutes: "120", billingUnitMinutes: "30", unitPrice: "" },
    { id: "tier-final", untilMinutes: "", billingUnitMinutes: "60", unitPrice: "" }
  ];
}

function normalizeLadderRows(ladder) {
  if (!Array.isArray(ladder) || !ladder.length) {
    return defaultLadderRows();
  }
  return ladder.map((step, index) => ({
    id: step.id || `tier-${index + 1}`,
    untilMinutes: step.untilMinutes == null ? "" : textValue(step.untilMinutes),
    billingUnitMinutes: textValue(step.billingUnitMinutes || 60),
    unitPrice: textValue(step.unitPrice || 0)
  }));
}

function buildLadderFromRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      untilMinutes: String(row.untilMinutes || "").trim() ? numberFromForm(row.untilMinutes, 0) : null,
      billingUnitMinutes: numberFromForm(row.billingUnitMinutes, 60),
      unitPrice: numberFromForm(row.unitPrice, 0)
    }));
}

function inferMediaType(path) {
  const value = String(path || "").toLowerCase();
  if (value.indexOf(".png") >= 0) return "image/png";
  if (value.indexOf(".webp") >= 0) return "image/webp";
  return "image/jpeg";
}

function isUnauthorizedError(error) {
  return error && (error.statusCode === 401 || error.code === "UNAUTHORIZED");
}

function isCloudContainerTransportError(error) {
  const message = error && (error.errMsg || error.message || "");
  return message.indexOf("-606001") >= 0 || message.indexOf("callContainer") >= 0;
}

function createRecognitionRequestId() {
  return `recognition-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function estimateBase64Bytes(base64) {
  const value = String(base64 || "");
  if (!value) return 0;
  const padding = value.endsWith("==") ? 2 : (value.endsWith("=") ? 1 : 0);
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function getReadableRecognitionError(error) {
  const requestId = error && error.requestId ? `（requestId: ${error.requestId}）` : "";
  if (isCloudContainerTransportError(error)) {
    return `云托管识别请求失败，请确认服务已部署并稍后重试。若照片较大，已自动压缩后再识别。${requestId}`;
  }
  return `${(error && (error.message || error.errMsg)) || "识别接口不可用，请检查网络配置。"}${requestId}`;
}

function getReadableUploadError(error) {
  const requestId = error && error.requestId ? `（requestId: ${error.requestId}）` : "";
  if (isUnauthorizedError(error)) {
    return `登录已过期，请重新登录后再上传照片。${requestId}`;
  }
  return `${(error && (error.message || error.errMsg)) || "图片上传失败，请检查网络或存储配置。"}${requestId}`;
}

function getPhotoLocalPath(photo) {
  return photo && (photo.localPath || photo.tempFilePath || photo.originalPath || photo.path);
}

function attachUploadResult(photo, upload) {
  const uploadedUrl = upload && (upload.uploadedUrl || upload.url);
  if (!uploadedUrl) {
    throw new Error("图片上传失败：上传接口未返回图片地址。");
  }
  return {
    ...photo,
    uploadedUrl,
    storageBucket: upload.storageBucket || "",
    storagePath: upload.storagePath || "",
    uploaded: true,
    uploadError: ""
  };
}

function buildEmptyForm() {
  return {
    name: "", address: "", entrance: "",
    latitude: "", longitude: "",
    chargeType: "hourly",
    freeMinutes: "60", billingUnitMinutes: "60", unitPrice: "5", maxDailyPrice: "", minCharge: "", notes: "",
    flatDurationMinutes: "1440", flatPrice: "", flatRepeat: true,
    ladderRows: defaultLadderRows(),
    newEnergyEnabled: false,
    newEnergyFreeMinutes: "120", newEnergyBillingUnitMinutes: "",
    newEnergyUnitPrice: "", newEnergyMaxDailyPrice: "",
    newEnergyFlatDurationMinutes: "", newEnergyFlatPrice: "", newEnergyNotes: "",
    walkingPenaltyMinutes: "0"
  };
}

function formFromLot(lot) {
  const location = lot.location || {};
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
    chargeType: textValue(pricing.chargeType || "hourly"),
    freeMinutes: textValue(pricing.freeMinutes || 0),
    billingUnitMinutes: textValue(pricing.billingUnitMinutes || 60),
    unitPrice: textValue(pricing.unitPrice || 0),
    maxDailyPrice: pricing.maxDailyPrice ? textValue(pricing.maxDailyPrice) : "",
    minCharge: pricing.minCharge ? textValue(pricing.minCharge) : "",
    flatDurationMinutes: textValue(pricing.flatDurationMinutes || 1440),
    flatPrice: pricing.flatPrice ? textValue(pricing.flatPrice) : "",
    flatRepeat: pricing.flatRepeat !== false,
    ladderRows: normalizeLadderRows(pricing.ladder),
    notes: textValue(pricing.notes),
    newEnergyEnabled: Boolean(newEnergyRule),
    newEnergyFreeMinutes: newEnergyRule ? textValue(newEnergyRule.freeMinutes || 0) : "120",
    newEnergyBillingUnitMinutes: newEnergyRule ? optionalTextValue(newEnergyRule.billingUnitMinutes) : "",
    newEnergyUnitPrice: newEnergyRule ? optionalTextValue(newEnergyRule.unitPrice) : "",
    newEnergyMaxDailyPrice: newEnergyRule ? optionalTextValue(newEnergyRule.maxDailyPrice) : "",
    newEnergyFlatDurationMinutes: newEnergyRule ? optionalTextValue(newEnergyRule.flatDurationMinutes) : "",
    newEnergyFlatPrice: newEnergyRule ? optionalTextValue(newEnergyRule.flatPrice) : "",
    newEnergyNotes: newEnergyRule ? textValue(newEnergyRule.notes) : "",
    walkingPenaltyMinutes: textValue(access.walkingPenaltyMinutes || 0)
  };
}

Page({
  data: {
    availabilityOptions,
    availabilityIndex: 1,
    availabilityLabel: availabilityOptions[1].label,
    chargeTypeOptions,
    chargeTypeIndex: 0,
    chargeTypeLabel: chargeTypeOptions[0].label,
    chargeTypeHint: chargeTypeOptions[0].hint,
    isFlatChargeType: false,
    isLadderChargeType: false,
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
    recognitionWarningText: "",
    loading: false
  },

  onLoad(query) {
    const editId = (query && query.id) || "";
    this.pendingEditId = editId;
    this.bootstrap(editId);
  },

  async bootstrap(editId) {
    const user = getLoggedInUser();
    if (!user) {
      this.setData({
        isLoggedIn: false,
        loginRequired: true,
        isEditing: Boolean(editId),
        editId: editId || "",
        pageTitle: editId ? "维护停车场" : "录入停车场",
        introText: "登录后才能上报或维护停车场信息。",
        saveButtonText: editId ? "保存修改" : "保存并参与推荐"
      });
      return;
    }

    this.setData({ isLoggedIn: true, loginRequired: false });

    if (editId) {
      await this.loadEditableLot(editId);
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
      chargeTypeIndex: 0,
      chargeTypeLabel: chargeTypeOptions[0].label,
      chargeTypeHint: chargeTypeOptions[0].hint,
      isFlatChargeType: false,
      isLadderChargeType: false,
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
          wx.showToast({ title: "登录失败", icon: "none" });
          return;
        }
        this.loginWithCodeAndContinue(res.code);
      },
      fail: () => {
        wx.showToast({ title: "登录失败", icon: "none" });
      }
    });
  },

  async loginWithCodeAndContinue(code) {
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
      this.bootstrap(this.pendingEditId || this.data.editId);
    } catch (error) {
      console.error("Login failed:", error.message);
      showErrorModal("登录失败", error, "登录失败，请检查网络或云托管配置。");
    } finally {
      this.setData({ loading: false });
    }
  },

  async loadEditableLot(editId) {
    this.setData({ loading: true });
    let lot = null;
    try {
      const result = await asyncGetParkingLotDetail(editId);
      lot = result.lot;
    } catch (e) {
      console.error("loadEditableLot error:", e.message);
    } finally {
      this.setData({ loading: false });
    }

    if (!lot) {
      wx.showToast({ title: "未找到停车场", icon: "none" });
      setTimeout(() => wx.navigateBack(), 600);
      return;
    }

    if (!lot.canEdit) {
      wx.showToast({ title: "只能维护自己上报的信息", icon: "none" });
      setTimeout(() => wx.navigateBack(), 600);
      return;
    }

    const availabilityIndex = Math.max(0, availabilityOptions.findIndex((item) => item.value === lot.availability));
    const evidence = lot.evidence || {};
    const photos = Array.isArray(evidence.photos) ? evidence.photos : [];
    const warnings = Array.isArray(evidence.recognitionWarnings) ? evidence.recognitionWarnings : [];

    const form = formFromLot(lot);
    const chargeTypeIndex = optionIndex(chargeTypeOptions, form.chargeType, 0);

    this.setData({
      isEditing: true,
      editId,
      pageTitle: "维护停车场",
      introText: "你正在维护自己上报的停车场。保存修改后，旧的点赞/踩会清空，可信度会回到 50，等待其他用户重新确认。",
      saveButtonText: "保存修改",
      availabilityIndex,
      availabilityLabel: availabilityOptions[availabilityIndex].label,
      chargeTypeIndex,
      chargeTypeLabel: chargeTypeOptions[chargeTypeIndex].label,
      chargeTypeHint: chargeTypeOptions[chargeTypeIndex].hint,
      isFlatChargeType: form.chargeType === "flat",
      isLadderChargeType: form.chargeType === "ladder",
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
      form
    });
  },

  onInput(event) {
    const key = event.currentTarget.dataset.key;
    this.setData({ [`form.${key}`]: event.detail.value });
  },

  onSwitchChange(event) {
    const key = event.currentTarget.dataset.key;
    this.setData({ [`form.${key}`]: Boolean(event.detail.value) });
  },

  onLadderInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    const key = event.currentTarget.dataset.key;
    if (!Number.isFinite(index) || !key) return;
    this.setData({ [`form.ladderRows[${index}].${key}`]: event.detail.value });
  },

  addLadderRow() {
    const rows = (this.data.form.ladderRows || []).concat({
      id: `tier-${Date.now()}`,
      untilMinutes: "",
      billingUnitMinutes: "60",
      unitPrice: ""
    });
    this.setData({ "form.ladderRows": rows });
  },

  removeLadderRow(event) {
    const index = Number(event.currentTarget.dataset.index);
    const rows = (this.data.form.ladderRows || []).filter((item, itemIndex) => itemIndex !== index);
    this.setData({ "form.ladderRows": rows.length ? rows : defaultLadderRows() });
  },

  onAvailabilityChange(event) {
    const availabilityIndex = Number(event.detail.value);
    this.setData({ availabilityIndex, availabilityLabel: availabilityOptions[availabilityIndex].label });
  },

  onChargeTypeChange(event) {
    const chargeTypeIndex = Number(event.detail.value);
    const option = chargeTypeOptions[chargeTypeIndex] || chargeTypeOptions[0];
    const updates = {
      chargeTypeIndex,
      chargeTypeLabel: option.label,
      chargeTypeHint: option.hint,
      isFlatChargeType: option.value === "flat",
      isLadderChargeType: option.value === "ladder",
      "form.chargeType": option.value
    };

    if (option.value === "ladder" && (!this.data.form.ladderRows || !this.data.form.ladderRows.length)) {
      updates["form.ladderRows"] = defaultLadderRows();
    }

    this.setData({
      ...updates
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
        wx.showToast({ title: "已填入坐标", icon: "success" });
      },
      fail: () => {
        wx.showToast({ title: "无法获取定位", icon: "none" });
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
        wx.showToast({ title: "已选择位置", icon: "success" });
      },
      fail: () => {
        wx.showToast({ title: "未选择位置", icon: "none" });
      }
    });
  },

  async captureEvidence() {
    wx.chooseMedia({
      count: 3,
      mediaType: ["image"],
      sizeType: ["compressed"],
      sourceType: ["camera", "album"],
      camera: "back",
      success: async (res) => {
        const newPhotos = [];
        for (const file of res.tempFiles) {
          const localPath = await this.prepareEvidencePhoto(file.tempFilePath);
          const photo = {
            path: localPath,
            originalPath: file.tempFilePath,
            localPath,
            size: file.size || 0,
            capturedAt: Date.now()
          };
          try {
            Object.assign(photo, await this.uploadEvidencePhoto(photo));
          } catch (e) {
            const uploadError = getReadableUploadError(e);
            photo.uploaded = false;
            photo.uploadError = uploadError;
            console.warn("Image upload failed:", {
              message: e.message,
              code: e.code,
              statusCode: e.statusCode,
              requestId: e.requestId
            });
            wx.showToast({ title: "图片上传失败", icon: "none" });
          }
          newPhotos.push(photo);
        }

        const evidencePhotos = this.data.evidencePhotos.concat(newPhotos).slice(0, 6);
        const failedUploads = evidencePhotos.filter((photo) => photo.uploadError).length;
        this.setData({
          evidencePhotos,
          photoCount: evidencePhotos.length,
          canRecognize: evidencePhotos.length > 0,
          recognizeDisabled: evidencePhotos.length <= 0,
          recognitionStatus: "已采集，待识别/复核",
          recognitionHint: failedUploads
            ? "部分照片尚未上传成功，点击识别时会先自动重试上传。"
            : "当前已保存照片证据和定位字段。接入 OCR 后可自动回填免费时长、计费单位和价格。"
        });

        if (!this.data.form.latitude || !this.data.form.longitude) {
          this.useCurrentLocation();
        }
      },
      fail: () => {
        wx.showToast({ title: "未选择照片", icon: "none" });
      }
    });
  },

  async uploadEvidencePhoto(photo, options) {
    const filePath = getPhotoLocalPath(photo);
    if (!filePath) {
      throw new Error("图片上传失败：找不到本地照片路径。");
    }
    const upload = await api.uploadImage(filePath, options);
    return attachUploadResult(photo, upload);
  },

  previewEvidence(event) {
    const index = Number(event.currentTarget.dataset.index) || 0;
    const urls = this.data.evidencePhotos.map((photo) => photo.path);
    wx.previewImage({ current: urls[index], urls });
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

  prepareEvidencePhoto(filePath) {
    if (!wx.compressImage) {
      return Promise.resolve(filePath);
    }
    return new Promise((resolve) => {
      wx.compressImage({
        src: filePath,
        quality: EVIDENCE_IMAGE_QUALITY,
        success: (res) => resolve(res.tempFilePath || filePath),
        fail: () => resolve(filePath)
      });
    });
  },

  readPhotoBase64(photo) {
    const filePath = photo.localPath || photo.tempFilePath || photo.path;
    return new Promise((resolve, reject) => {
      wx.getFileSystemManager().readFile({
        filePath,
        encoding: "base64",
        success: (res) => resolve({
          base64: res.data,
          mediaType: inferMediaType(filePath),
          sourcePath: filePath,
          base64Chars: res.data ? res.data.length : 0,
          estimatedBytes: estimateBase64Bytes(res.data)
        }),
        fail: reject
      });
    });
  },

  buildRecognitionPhotoRefs(photos) {
    return photos
      .filter((photo) => photo && photo.uploadedUrl)
      .map((photo, index) => ({
        index,
        uploadedUrl: photo.uploadedUrl,
        storageBucket: photo.storageBucket || "",
        storagePath: photo.storagePath || "",
        mediaType: inferMediaType(photo.uploadedUrl || photo.localPath || photo.path)
      }));
  },

  async ensureRecognitionPhotosUploaded(selectedPhotos, requestId) {
    let evidencePhotos = this.data.evidencePhotos.slice();
    const uploadedPhotos = [];

    for (let index = 0; index < selectedPhotos.length; index += 1) {
      const photo = selectedPhotos[index];
      if (photo && photo.uploadedUrl) {
        uploadedPhotos.push(photo);
        continue;
      }

      console.info("[mini-parking upload] retry-before-recognition", {
        requestId,
        index,
        localPath: getPhotoLocalPath(photo)
      });

      try {
        const uploadedPhoto = await this.uploadEvidencePhoto(photo, { requestId: `${requestId}-upload-${index + 1}` });
        evidencePhotos[index] = uploadedPhoto;
        uploadedPhotos.push(uploadedPhoto);
        this.setData({ evidencePhotos });
      } catch (error) {
        const uploadError = getReadableUploadError(error);
        evidencePhotos[index] = {
          ...photo,
          uploaded: false,
          uploadError
        };
        this.setData({
          evidencePhotos,
          recognitionHint: uploadError
        });
        throw new Error(`照片上传失败：${uploadError}`);
      }
    }

    return uploadedPhotos;
  },

  requestRecognition(payload, options) {
    return requestParkingRecognition(payload, options);
  },

  applyRecognition(recognition) {
    const result = recognition || {};
    const pricing = result.pricing || {};
    const location = result.location || {};
    const pricingByVehicle = pricing.pricingByVehicle || {};
    const newEnergyRule = pricingByVehicle.new_energy || null;
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    const updates = {
      "form.name": result.name || this.data.form.name,
      "form.address": result.address || this.data.form.address,
      "form.entrance": result.entrance || this.data.form.entrance,
      "form.chargeType": pricing.chargeType || this.data.form.chargeType,
      "form.freeMinutes": `${pricing.freeMinutes == null ? this.data.form.freeMinutes : pricing.freeMinutes}`,
      "form.billingUnitMinutes": `${pricing.billingUnitMinutes == null ? this.data.form.billingUnitMinutes : pricing.billingUnitMinutes}`,
      "form.unitPrice": `${pricing.unitPrice == null ? this.data.form.unitPrice : pricing.unitPrice}`,
      "form.maxDailyPrice": pricing.maxDailyPrice ? `${pricing.maxDailyPrice}` : this.data.form.maxDailyPrice,
      "form.minCharge": pricing.minCharge ? `${pricing.minCharge}` : this.data.form.minCharge,
      "form.flatDurationMinutes": `${pricing.flatDurationMinutes == null ? this.data.form.flatDurationMinutes : pricing.flatDurationMinutes}`,
      "form.flatPrice": pricing.flatPrice ? `${pricing.flatPrice}` : this.data.form.flatPrice,
      "form.flatRepeat": pricing.flatRepeat == null ? this.data.form.flatRepeat : Boolean(pricing.flatRepeat),
      "form.ladderRows": Array.isArray(pricing.ladder) && pricing.ladder.length
        ? normalizeLadderRows(pricing.ladder)
        : this.data.form.ladderRows,
      "form.notes": pricing.notes || this.data.form.notes,
      "form.walkingPenaltyMinutes": `${result.walkingPenaltyMinutes == null ? this.data.form.walkingPenaltyMinutes : result.walkingPenaltyMinutes}`,
      recognitionWarnings: warnings,
      recognitionWarningText: warnings.join("；"),
      recognitionStatus: `已识别，可信度 ${result.confidence || 0}`,
      recognitionHint: result.evidenceSummary || "已根据照片和定位回填字段，请保存前复核。"
    };

    if (location.latitude != null) updates["form.latitude"] = `${location.latitude}`;
    if (location.longitude != null) updates["form.longitude"] = `${location.longitude}`;

    if (pricing.chargeType) {
      const index = optionIndex(chargeTypeOptions, pricing.chargeType, 0);
      updates.chargeTypeIndex = index;
      updates.chargeTypeLabel = chargeTypeOptions[index].label;
      updates.chargeTypeHint = chargeTypeOptions[index].hint;
      updates.isFlatChargeType = pricing.chargeType === "flat";
      updates.isLadderChargeType = pricing.chargeType === "ladder";
    }

    if (newEnergyRule) {
      updates["form.newEnergyEnabled"] = true;
      updates["form.newEnergyFreeMinutes"] = `${newEnergyRule.freeMinutes == null ? this.data.form.newEnergyFreeMinutes : newEnergyRule.freeMinutes}`;
      updates["form.newEnergyBillingUnitMinutes"] = newEnergyRule.billingUnitMinutes == null ? this.data.form.newEnergyBillingUnitMinutes : `${newEnergyRule.billingUnitMinutes}`;
      updates["form.newEnergyUnitPrice"] = newEnergyRule.unitPrice == null ? this.data.form.newEnergyUnitPrice : `${newEnergyRule.unitPrice}`;
      updates["form.newEnergyMaxDailyPrice"] = newEnergyRule.maxDailyPrice == null ? this.data.form.newEnergyMaxDailyPrice : `${newEnergyRule.maxDailyPrice}`;
      updates["form.newEnergyFlatDurationMinutes"] = newEnergyRule.flatDurationMinutes == null ? this.data.form.newEnergyFlatDurationMinutes : `${newEnergyRule.flatDurationMinutes}`;
      updates["form.newEnergyFlatPrice"] = newEnergyRule.flatPrice == null ? this.data.form.newEnergyFlatPrice : `${newEnergyRule.flatPrice}`;
      updates["form.newEnergyNotes"] = newEnergyRule.notes || this.data.form.newEnergyNotes;
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
      wx.showToast({ title: "请先拍照", icon: "none" });
      return;
    }

    this.setData({
      isRecognizing: true,
      recognizeDisabled: true,
      recognitionStatus: "识别中",
      recognitionHint: "正在读取照片并请求识别接口。"
    });

    const requestId = createRecognitionRequestId();
    try {
      const selectedPhotos = this.data.evidencePhotos.slice(0, 3);
      console.info("[mini-parking recognition] start", {
        requestId,
        evidencePhotoCount: this.data.evidencePhotos.length,
        selectedPhotoCount: selectedPhotos.length
      });

      const uploadedPhotos = await this.ensureRecognitionPhotosUploaded(selectedPhotos, requestId);
      const photoRefs = this.buildRecognitionPhotoRefs(uploadedPhotos);
      const recognitionPayload = {
        form: this.data.form,
        textHint: this.data.form.notes
      };

      if (photoRefs.length !== selectedPhotos.length) {
        throw new Error("照片上传未完成，请重新拍照/上传后再识别。");
      }

      recognitionPayload.photoRefs = photoRefs;
      console.info("[mini-parking recognition] photo-refs-ready", {
        requestId,
        photoRefs
      });

      const response = await this.requestRecognition(recognitionPayload, { requestId });

      console.info("[mini-parking recognition] success", {
        requestId,
        mode: response.mode,
        hasRecognition: Boolean(response.recognition)
      });
      this.applyRecognition(response.recognition);
      wx.showToast({ title: "识别完成", icon: "success" });
    } catch (error) {
      error.requestId = error.requestId || requestId;
      const recognitionHint = getReadableRecognitionError(error);
      console.error("[mini-parking recognition] failed", {
        requestId,
        errMsg: error.errMsg,
        message: error.message,
        code: error.code,
        errno: error.errno,
        statusCode: error.statusCode
      });
      this.setData({
        recognitionStatus: "识别失败，待人工复核",
        recognitionHint
      });
      wx.showToast({ title: "识别失败", icon: "none" });
    } finally {
      this.setData({
        isRecognizing: false,
        recognizeDisabled: this.data.evidencePhotos.length <= 0
      });
    }
  },

  validate(form) {
    if (!form.name.trim()) return "请填写停车场名称";
    if (!form.address.trim()) return "请填写地址";
    if (!Number.isFinite(Number(form.latitude)) || !Number.isFinite(Number(form.longitude))) {
      return "请填写有效坐标";
    }
    if (form.chargeType === "flat") {
      if (numberFromForm(form.flatDurationMinutes, 0) <= 0) return "按次/包段时长必须大于 0";
      if (numberFromForm(form.flatPrice, -1) < 0) return "按次/包段价格不能为负数";
    } else if (form.chargeType === "ladder") {
      const rows = form.ladderRows || [];
      if (!rows.length) return "请至少填写一条阶梯规则";
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        if (numberFromForm(row.billingUnitMinutes, 0) <= 0) return `第 ${index + 1} 条阶梯计费单位必须大于 0`;
        if (numberFromForm(row.unitPrice, -1) < 0) return `第 ${index + 1} 条阶梯价格不能为负数`;
        if (String(row.untilMinutes || "").trim() && numberFromForm(row.untilMinutes, 0) <= 0) {
          return `第 ${index + 1} 条截止分钟必须大于 0`;
        }
      }
    } else {
      if (numberFromForm(form.billingUnitMinutes, 0) <= 0) return "计费单位必须大于 0";
      if (numberFromForm(form.unitPrice, -1) < 0) return "价格不能为负数";
    }
    return "";
  },

  buildApiPayload() {
    const form = this.data.form;
    const availability = availabilityOptions[this.data.availabilityIndex].value;
    const basePricing = {
      chargeType: form.chargeType || "hourly",
      freeMinutes: numberFromForm(form.freeMinutes, 0),
      maxDailyPrice: numberFromForm(form.maxDailyPrice, 0),
      minCharge: numberFromForm(form.minCharge, 0),
      notes: form.notes.trim()
    };

    if (basePricing.chargeType === "flat") {
      basePricing.flatDurationMinutes = numberFromForm(form.flatDurationMinutes, 1440);
      basePricing.flatPrice = numberFromForm(form.flatPrice, 0);
      basePricing.flatRepeat = Boolean(form.flatRepeat);
    } else if (basePricing.chargeType === "ladder") {
      basePricing.ladder = buildLadderFromRows(form.ladderRows);
    } else {
      basePricing.billingUnitMinutes = numberFromForm(form.billingUnitMinutes, 60);
      basePricing.unitPrice = numberFromForm(form.unitPrice, 0);
    }

    if (form.newEnergyEnabled) {
      const newEnergyFreeMinutes = numberFromForm(form.newEnergyFreeMinutes, 120);
      basePricing.pricingByVehicle = {
        new_energy: {
          freeMinutes: newEnergyFreeMinutes,
          notes: form.newEnergyNotes.trim() || `新能源${newEnergyFreeMinutes}分钟免费，之后按默认规则计费`
        }
      };
      if (form.newEnergyBillingUnitMinutes.trim()) {
        basePricing.pricingByVehicle.new_energy.billingUnitMinutes =
          numberFromForm(form.newEnergyBillingUnitMinutes, basePricing.billingUnitMinutes);
      }
      if (form.newEnergyUnitPrice.trim()) {
        basePricing.pricingByVehicle.new_energy.unitPrice =
          numberFromForm(form.newEnergyUnitPrice, basePricing.unitPrice);
      }
      if (form.newEnergyMaxDailyPrice.trim()) {
        basePricing.pricingByVehicle.new_energy.maxDailyPrice =
          numberFromForm(form.newEnergyMaxDailyPrice, basePricing.maxDailyPrice);
      }
      if (form.newEnergyFlatDurationMinutes.trim()) {
        basePricing.pricingByVehicle.new_energy.flatDurationMinutes =
          numberFromForm(form.newEnergyFlatDurationMinutes, basePricing.flatDurationMinutes || 1440);
      }
      if (form.newEnergyFlatPrice.trim()) {
        basePricing.pricingByVehicle.new_energy.flatPrice =
          numberFromForm(form.newEnergyFlatPrice, basePricing.flatPrice || 0);
      }
    }

    const evidencePhotos = this.data.evidencePhotos.map((photo) => {
      if (photo.uploadedUrl) {
        return {
          path: photo.uploadedUrl,
          uploadedUrl: photo.uploadedUrl,
          storageBucket: photo.storageBucket || "",
          storagePath: photo.storagePath || "",
          uploaded: true
        };
      }
      return photo.path;
    });

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
      this.setData({ isLoggedIn: false, loginRequired: true });
      wx.showToast({ title: "请先登录", icon: "none" });
      return;
    }

    const form = this.data.form;
    const error = this.validate(form);
    if (error) {
      wx.showToast({ title: error, icon: "none" });
      return;
    }

    const apiPayload = this.buildApiPayload();
    this.setData({ loading: true });

    try {
      if (this.data.isEditing) {
        await asyncUpdateUserParkingLot(this.data.editId, apiPayload);
        wx.showToast({ title: "已保存修改", icon: "success" });
      } else {
        await asyncSaveUserParkingLot(apiPayload);
        wx.showToast({ title: "已保存", icon: "success" });
      }
      setTimeout(() => wx.navigateBack(), 500);
    } catch (e) {
      console.error("Save failed:", e.message);
      if (isUnauthorizedError(e)) {
        wx.removeStorageSync(LOGIN_KEY);
        wx.removeStorageSync(CURRENT_USER_KEY);
        wx.removeStorageSync("auth_token");
        this.setData({ isLoggedIn: false, loginRequired: true });
        wx.showToast({ title: "登录已过期，请重新登录", icon: "none" });
      } else {
        wx.showToast({ title: e.message || "保存失败，请检查网络后重试", icon: "none" });
      }
    } finally {
      this.setData({ loading: false });
    }
  }
});
