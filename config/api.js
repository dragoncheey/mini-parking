const apiConfig = {
  baseUrl: "http://127.0.0.1:8787",
  recognitionApiUrl: "http://127.0.0.1:8787/api/recognize-parking",
  requestTimeoutMs: 30000
};

const cloudbaseConfig = {
  enabled: true,
  envId: "prod-d0g1zp7w0322a5d42",
  serviceName: "mini-parking-api",
  recognitionPath: "/api/recognize-parking"
};

module.exports = {
  apiConfig,
  cloudbaseConfig
};
