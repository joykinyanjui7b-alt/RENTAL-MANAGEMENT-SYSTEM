const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const envPath = path.join(__dirname, ".env");
const isProductionBuild = Boolean(
  process.env.VERCEL_ENV === "production" ||
  process.env.VERCEL === "1" ||
  process.env.NODE_ENV === "production" ||
  process.env.CI === "true" ||
  process.env.GITHUB_ACTIONS === "true"
);

if (!isProductionBuild && fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const rawApiBaseUrl = process.env.API_BASE_URL?.trim() || "";
const fallbackApiBaseUrl = "https://rental-management-system-vnn1.onrender.com";
const brokenBackendHostnames = ["rms-zffu.onrender.com", "system-documentation-backend.onrender.com"];
const configuredApiBaseUrl = rawApiBaseUrl && !brokenBackendHostnames.some((host) => rawApiBaseUrl.includes(host)) ? rawApiBaseUrl : "";
const defaultApiBaseUrl = isProductionBuild
  ? fallbackApiBaseUrl
  : "http://localhost:3000";
const resolvedApiBaseUrl = configuredApiBaseUrl || defaultApiBaseUrl;
const content = `window.APP_CONFIG = {\n  apiBaseUrl: "${resolvedApiBaseUrl.replace(/"/g, '\\"')}"\n};\n`;

fs.writeFileSync(path.join(__dirname, "public", "config.js"), content, "utf8");
console.log("Generated public/config.js with API_BASE_URL:", resolvedApiBaseUrl);
