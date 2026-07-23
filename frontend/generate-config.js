const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, ".env") });

const apiBaseUrl = process.env.API_BASE_URL || "";
const isVercelBuild = Boolean(process.env.VERCEL);
const defaultLocalApiBaseUrl = isVercelBuild ? "https://system-documentation-backend.onrender.com" : "http://localhost:3000";
const resolvedApiBaseUrl = apiBaseUrl || defaultLocalApiBaseUrl;
const content = `window.APP_CONFIG = {\n  apiBaseUrl: "${resolvedApiBaseUrl.replace(/"/g, '\\"')}"\n};\n`;

fs.writeFileSync(path.join(__dirname, "public", "config.js"), content, "utf8");
console.log("Generated public/config.js with API_BASE_URL:", apiBaseUrl);
