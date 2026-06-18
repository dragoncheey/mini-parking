function buildCommonPath(lot) {
  const location = lot.location || {};
  const amap = location.amap || {};
  const params = [
    `name=${encodeURIComponent(lot.name || "")}`,
    `address=${encodeURIComponent(lot.address || "")}`,
    `latitude=${encodeURIComponent(location.latitude || "")}`,
    `longitude=${encodeURIComponent(location.longitude || "")}`,
    `poiId=${encodeURIComponent(amap.poiId || "")}`
  ];

  return `pages/index/index?${params.join("&")}`;
}

const amapMiniProgram = {
  enabled: false,
  appId: "",
  buildPath(lot) {
    return buildCommonPath(lot);
  }
};

const baiduMiniProgram = {
  enabled: false,
  appId: "",
  buildPath(lot) {
    return buildCommonPath(lot);
  }
};

module.exports = {
  amapMiniProgram,
  baiduMiniProgram
};
