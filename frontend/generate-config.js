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

const apiBaseUrl = process.env.API_BASE_URL?.trim() || "";
const defaultApiBaseUrl = isProductionBuild
  ? "https://system-documentation-backend.onrender.com"
  : "http://localhost:3000";
const resolvedApiBaseUrl = apiBaseUrl || defaultApiBaseUrl;
const content = `window.APP_CONFIG = {\n  apiBaseUrl: "${resolvedApiBaseUrl.replace(/"/g, '\\"')}"\n};\n`;

fs.writeFileSync(path.join(__dirname, "public", "config.js"), content, "utf8");
console.log("Generated public/config.js with API_BASE_URL:", resolvedApiBaseUrl);
