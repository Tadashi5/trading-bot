// dataDir.js — Persistent data directory
// On Fly.io with a mounted volume: set DATA_DIR=/data in fly.toml [env]
// In local dev: falls back to the app directory so nothing changes
const path = require('path');
module.exports = process.env.DATA_DIR || path.join(__dirname);
