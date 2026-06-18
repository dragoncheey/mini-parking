App({
  onLaunch() {
    if (wx.cloud) {
      wx.cloud.init({
        env: "prod-d0g1zp7w0322a5d42",
        traceUser: true
      });
    }
  },
  globalData: {
    userLocation: null,
    destination: null,
    durationMinutes: 30,
    authToken: ""
  }
});
