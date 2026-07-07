const API_BASE_URL = "https://parking.kuaidianfanfan.com";

const apiConfig = {
  baseUrl: API_BASE_URL,
  recognitionApiUrl: `${API_BASE_URL}/api/recognize-parking`,
  requestTimeoutMs: 30000,
  recognitionTimeoutMs: 60000
};

module.exports = {
  apiConfig
};
