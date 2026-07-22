const currentOrigin = (typeof window !== "undefined" && window.location && window.location.origin ? window.location.origin : "").trim();
const requestedApiBaseUrl = (typeof window !== "undefined" && window.__RMS_API_BASE_URL__ ? window.__RMS_API_BASE_URL__ : "").trim();
const fallbackApiBaseUrl = currentOrigin.includes("vercel.app") || currentOrigin.includes("netlify.app")
  ? "https://rental-management-system-vnn1.onrender.com"
  : currentOrigin;

window.APP_CONFIG = {
  apiBaseUrl: requestedApiBaseUrl || fallbackApiBaseUrl
};