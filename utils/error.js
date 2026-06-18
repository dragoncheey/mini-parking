function formatErrorMessage(error, fallback) {
  const message = error && error.message ? error.message : "";
  if (!message) return fallback;
  if (message.indexOf("network") >= 0 || message.indexOf("request:fail") >= 0) {
    return fallback;
  }
  return message.length > 60 ? `${message.slice(0, 57)}...` : message;
}

function showErrorModal(title, error, fallback) {
  const content = formatErrorMessage(error, fallback);
  if (typeof wx !== "undefined" && wx.showModal) {
    wx.showModal({
      title,
      content,
      showCancel: false
    });
    return;
  }

  if (typeof wx !== "undefined" && wx.showToast) {
    wx.showToast({ title: content, icon: "none" });
  }
}

module.exports = {
  formatErrorMessage,
  showErrorModal
};
