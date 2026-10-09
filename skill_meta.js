'use strict';

/**
 * 本 skill 的身份 —— 唯一来源。
 *
 * SKILL_NAME 是 `session-manager get-state --skill-name <SKILL_NAME>` 用的**skill 名**，
 * 不是平台名（集群规范里这两者是不同命名空间，最容易搞混的地方）。
 *
 * ⚠️ 上传前必须与 muad.skill.json 的 `name` 字段、以及 skill 的安装目录名三者一致，
 * 否则 session-manager 取不到登录态。改这里的时候三处一起改。
 *
 * PLATFORM 是 session-manager 的 adapter 名，本仓库固定 mssw
 * （MIGRATION.md R13：不保留任何非 mssw 平台的接口代码）。
 *
 * ⚠️ 集群里 mssw 的入口**按环境不同**（见 config/api_config.json 的 origin），
 * 别拿服务名当判据 —— `mssp-nginx.mss-pro` 这名字里带 mssp，服务过的却是 mssw，
 * 而且它是个两环境同名不同后端的 k8s Service 名，打错环境的表现是 403/code=9451。
 */

const SKILL_NAME = 'v2-sangfor-report-downloader';
const PLATFORM = 'mssw';

module.exports = {
  SKILL_NAME,
  PLATFORM
};
