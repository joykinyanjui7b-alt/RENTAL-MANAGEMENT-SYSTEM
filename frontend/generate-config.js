const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, ".env") });

const apiBaseUrl = process.env.API_BASE_URL || "";
const content = `window.APP_CONFIG = {\n  apiBaseUrl: "${apiBaseUrl.replace(/"/g, '\\"')}"\n};\n`;

fs.writeFileSync(path.join(__dirname, "public", "config.js"), content, "utf8");
console.log("Generated public/config.js with API_BASE_URL:", apiBaseUrl);
