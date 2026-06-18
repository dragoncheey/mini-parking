const { amapMiniProgram, baiduMiniProgram } = require("../config/map");

const EARTH_RADIUS_METERS = 6371000;

function toRadians(degrees) {
  return degrees * Math.PI / 180;
}

function isValidCoordinate(location) {
  return Boolean(
    location
      && Number.isFinite(Number(location.latitude))
      && Number.isFinite(Number(location.longitude))
  );
}

function calculateDistanceMeters(origin, target) {
  if (!isValidCoordinate(origin) || !isValidCoordinate(target)) {
    return null;
  }

  const lat1 = toRadians(Number(origin.latitude));
  const lat2 = toRadians(Number(target.latitude));
  const deltaLat = toRadians(Number(target.latitude) - Number(origin.latitude));
  const deltaLng = toRadians(Number(target.longitude) - Number(origin.longitude));
  const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2)
    + Math.cos(lat1) * Math.cos(lat2)
    * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(EARTH_RADIUS_METERS * c);
}

function estimateWalkingMinutes(distanceMeters, extraMinutes) {
  const distance = Number.isFinite(Number(distanceMeters)) ? Number(distanceMeters) : 0;
  const penalty = Number.isFinite(Number(extraMinutes)) ? Number(extraMinutes) : 0;
  return Math.max(1, Math.ceil(distance / 80 + penalty));
}

function formatDistance(distanceMeters) {
  const distance = Number(distanceMeters);
  if (!Number.isFinite(distance)) {
    return "距离待定位";
  }

  if (distance >= 1000) {
    return `${(distance / 1000).toFixed(1)} km`;
  }

  return `${Math.max(1, Math.round(distance))} m`;
}

function openParkingLocation(lot) {
  if (!lot || !isValidCoordinate(lot.location)) {
    wx.showToast({
      title: "缺少坐标",
      icon: "none"
    });
    return;
  }

  const actions = buildNavigationActions(lot);
  wx.showActionSheet({
    itemList: actions.map((item) => item.label),
    success(res) {
      const action = actions[res.tapIndex];
      if (action) {
        action.run();
      }
    }
  });
}

function buildNavigationActions(lot) {
  const actions = [{
    label: "微信位置页",
    run() {
      openLocationFallback(lot);
    }
  }];

  if (amapMiniProgram.enabled && amapMiniProgram.appId) {
    actions.push({
      label: "高德地图",
      run() {
        openConfiguredMapMiniProgram(lot, amapMiniProgram);
      }
    });
  }

  if (baiduMiniProgram.enabled && baiduMiniProgram.appId) {
    actions.push({
      label: "百度地图",
      run() {
        openConfiguredMapMiniProgram(lot, baiduMiniProgram);
      }
    });
  }

  actions.push({
    label: "复制坐标",
    run() {
      copyParkingLocation(lot, "已复制坐标");
    }
  });

  return actions;
}

function openConfiguredMapMiniProgram(lot, config) {
  wx.navigateToMiniProgram({
    appId: config.appId,
    path: config.buildPath(lot),
    fail() {
      openLocationFallback(lot);
    }
  });
}

function openLocationFallback(lot) {
  wx.openLocation({
    latitude: Number(lot.location.latitude),
    longitude: Number(lot.location.longitude),
    name: lot.name,
    address: lot.address,
    scale: 18,
    fail() {
      copyParkingLocation(lot, "已复制位置");
    }
  });
}

function copyParkingLocation(lot, title) {
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
        title,
        icon: "none"
      });
    }
  });
}

module.exports = {
  buildNavigationActions,
  calculateDistanceMeters,
  copyParkingLocation,
  estimateWalkingMinutes,
  formatDistance,
  isValidCoordinate,
  openParkingLocation
};
