'use strict';

/**
 * API 入口集中配置加载（Node 侧）。
 *
 * 作用：读 `config/api_config.json`，提供按平台取 origin / Host 头 / referer 路径 /
 * endpoint 的统一入口，避免域名和端口散落在业务文件里。
 *
 * ⚠️ 只在**集群模式**被调用（见 session.js）。本地模式不读本文件，
 * 因为集群的统一 Host 头打到 SIT 域名上会直接导致请求失败。
 *
 * - origin 支持平台级环境变量覆盖（json 里的 `env` 字段点名变量名）。
 * - Host 头支持 `host_env` 覆盖，三态语义：未设置 → 用配置值；空串 → 不发 Host 头；有值 → 用该值。
 */

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = path.join(__dirname, 'config', 'api_config.json');

let cache = null;

function loadApiConfig(forceReload = false) {
  if (cache && !forceReload) {
    return cache;
  }
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`API 配置文件不存在: ${CONFIG_PATH}`);
  }
  cache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return cache;
}

function platformSection(platform) {
  const cfg = loadApiConfig();
  const section = cfg.platforms && cfg.platforms[platform];
  if (!section) {
    throw new Error(`api_config.json 缺少 platforms.${platform} 配置项`);
  }
  return section;
}

/** 取某平台的 origin。优先平台级 env，其次配置文件。 */
function getOrigin(platform) {
  const section = platformSection(platform);
  const envName = section.env;
  if (envName) {
    const envOrigin = process.env[envName];
    if (envOrigin && String(envOrigin).trim()) {
      return String(envOrigin).trim().replace(/\/+$/, '');
    }
  }
  const origin = section.origin;
  if (!origin) {
    throw new Error(`api_config.json 缺少 platforms.${platform}.origin 配置项`);
  }
  return String(origin).trim().replace(/\/+$/, '');
}

/**
 * 取某平台的统一 Host 头。
 *
 * 三态：host_env 未设置 → 配置里的 host_header；host_env 为空串 → ''（调用方据此不发 Host 头）；
 * host_env 有值 → 该值。
 */
function getHostHeader(platform) {
  const section = platformSection(platform);
  const envName = section.host_env;
  if (envName && Object.prototype.hasOwnProperty.call(process.env, envName)) {
    return String(process.env[envName] || '');
  }
  const hostHeader = section.host_header;
  return hostHeader === null || hostHeader === undefined ? '' : String(hostHeader);
}

/** 取某平台的 referer 路径（默认 /index.html）。 */
function getRefererPath(platform) {
  const section = platformSection(platform);
  return section.referer_path ? String(section.referer_path) : '/index.html';
}

/** 取某平台 endpoint 的完整 URL（origin + path）。 */
function getEndpoint(platform, key) {
  const section = platformSection(platform);
  const endpoints = section.endpoints || {};
  if (!(key in endpoints)) {
    throw new Error(`api_config.json 缺少 platforms.${platform}.endpoints.${key} 配置项`);
  }
  const value = String(endpoints[key]);
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  if (!value.startsWith('/')) {
    throw new Error(`api_config.json platforms.${platform}.endpoints.${key} 必须以 / 开头或为完整 URL，当前值: ${value}`);
  }
  return getOrigin(platform) + value;
}

module.exports = {
  CONFIG_PATH,
  loadApiConfig,
  getOrigin,
  getHostHeader,
  getRefererPath,
  getEndpoint
};
