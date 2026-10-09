# MSS AI PPT Sample Assets

这个目录当前提供的是一个可运行的 FastAPI 后端样例，用来完成以下流程：

- 上传 Excel 或使用内置输入数据
- 异步生成 PPT 报告
- 生成 PDF 和预览图
- 支持任务轮询、WebSocket 进度通知、报告改写、评分和后台管理
- 可选启用 LLM 与 RAG

现阶段主要围绕 `mss_classic_ops` 这一套经典模板运行。

## 当前真实目录

```text
mss_ai_ppt_sample_assets/
├─ backend/
│  ├─ app.py                     # FastAPI 入口
│  ├─ config.py                  # 环境变量与目录配置
│  ├─ requirements.txt           # Python 依赖
│  ├─ data/
│  │  ├─ templates/
│  │  │  ├─ catalog.json         # 模板目录
│  │  │  ├─ 经典模板.pptx
│  │  │  └─ 经典模板_descriptor.json
│  │  └─ inputs/
│  │     └─ catalog.json         # 输入数据目录
│  ├─ frontend/                  # 已编译前端静态资源
│  ├─ routers/v1/                # REST API
│  ├─ services/                  # 报告、任务、评分、后台服务
│  ├─ modules/                   # Excel、预览、认证、RAG 等模块
│  └─ outputs/                   # 运行时输出目录
│     ├─ jobs/
│     ├─ logs/
│     ├─ previews/
│     ├─ reports/
│     ├─ sessions/
│     └─ slidespecs/
└─ README.md
```

## 当前内置资源

### 模板

当前 `backend/data/templates/catalog.json` 只登记了 1 个模板：

- `mss_classic_ops`
  - 名称：`经典模板`
  - PPT 文件：`经典模板.pptx`
  - 描述文件：`经典模板_descriptor.json`
  - 页数：25
  - 特性：`excel_driven_content`、`classic_layout`

### 输入数据

当前 `backend/data/inputs/catalog.json` 只登记了 1 份内置输入：

- `classic_ops_dataxlsx`
  - 租户：`tenant_classic_demo`
  - 说明：来自 `backend/data/data.xlsx` 对应的解析结果

注意：

- 对于经典模板流程，后端会优先在运行时解析 Excel，而不是只依赖静态 JSON。
- 解析优先级如下：
  1. `outputs/sessions/{session_id}/uploaded.xlsx`
  2. catalog 中配置的 `excel_file`
  3. `backend/data/data.xlsx`（当 `input_id=classic_ops_dataxlsx` 时）

## 当前服务能力

### 页面与入口

- `/`：重定向到 `/ui/index.html`
- `/ui`：前端页面
- `/docs`：Swagger 文档
- `/redoc`：ReDoc 文档
- `/ws/{client_id}`：WebSocket 进度通道

### API 路由

统一前缀：`/api/v1`

- `reports`
  - `POST /api/v1/reports`：异步创建报告任务
  - `GET /api/v1/reports/{report_id}/download`：下载 PPTX
  - `GET /api/v1/reports/{report_id}/download-pdf`：下载 PDF
  - `GET /api/v1/reports/{report_id}/preview`：获取预览图
  - `PATCH /api/v1/reports/{report_id}/slides`：批量改写指定 slide 内容
  - `POST /api/v1/reports/{report_id}/slides/ai-rewrite`：AI 改写单页
- `jobs`
  - `GET /api/v1/jobs/{job_id}/status`
  - `GET /api/v1/jobs`
  - `POST /api/v1/jobs/{job_id}/cancel`
  - `DELETE /api/v1/jobs/{job_id}`
- `templates`
  - `GET /api/v1/templates`
  - `GET /api/v1/templates/{template_id}/slides`
- `inputs`
  - `GET /api/v1/inputs`
  - `GET /api/v1/inputs/{input_id}`
  - `POST /api/v1/inputs/excel`
- `sessions`
  - `DELETE /api/v1/sessions`
  - `DELETE /api/v1/sessions/{session_id}`
- `system`
  - `GET /api/v1/system/health`
  - `GET /api/v1/system/health/detailed`
  - `GET /api/v1/system/logs`
- `ratings`
  - `POST /api/v1/ratings/jobs/{job_id}/rating`
  - `GET /api/v1/ratings/jobs/{job_id}/rating`
  - `GET /api/v1/ratings/jobs/{job_id}/can-rate`
- `admin`
  - `POST /api/v1/admin/login`
  - `POST /api/v1/admin/logout`
  - `GET /api/v1/admin/verify`
  - `GET /api/v1/admin/jobs`
  - `GET /api/v1/admin/jobs/{job_id}`
  - `PATCH /api/v1/admin/jobs/{job_id}/rating`
  - `DELETE /api/v1/admin/jobs`
  - `GET /api/v1/admin/statistics`
- `rag`
  - `POST /api/v1/rag/index/build`
  - `POST /api/v1/rag/index/update`
  - `GET /api/v1/rag/index/status`
  - `POST /api/v1/rag/query`

## 运行依赖

### Python

建议 Python 3.10 及以上。

安装依赖：

```powershell
cd f:\report-generation\mss_ai_ppt_sample_assets\backend
pip install -r requirements.txt
```

### LibreOffice

预览图和 PDF 依赖 LibreOffice 的 `soffice`：

- 用于 `PPTX -> PDF -> PNG`
- 健康检查也会检测 LibreOffice 是否可用

Windows 下默认会尝试这些位置：

- `C:\Program Files\LibreOffice\program\soffice.exe`
- `C:\Program Files (x86)\LibreOffice\program\soffice.exe`
- `C:\Program Files\OpenOffice 4\program\soffice.exe`

也可以通过环境变量指定：

```powershell
$env:LIBREOFFICE_PATH="C:\Program Files\LibreOffice\program\soffice.exe"
```

### LLM / OpenAI Compatible API

当 `ENABLE_LLM=true` 时，后端要求：

- `OPENAI_API_KEY`
- 可选 `OPENAI_BASE_URL`
- `OPENAI_MODEL`

当 `ENABLE_LLM=false` 时，系统可以用 mock 流程运行，但涉及 AI 改写的接口不可用。

### RAG

RAG 相关依赖已经在 `requirements.txt` 中声明，包括：

- `qdrant-client`
- `sentence-transformers`
- `huggingface-hub`
- `tiktoken`

只有当 `RAG_ENABLED=true` 时，RAG 检索才会真正启用。

## 环境变量

以下是当前代码真正使用、且最值得关注的环境变量：

### 基础目录

- `MSS_ENV_PATH`
- `MSS_DATA_DIR`
- `MSS_OUTPUTS_DIR`
- `MSS_OUTPUTS_URL_PREFIX`

### LLM

- `ENABLE_LLM`
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`
- `LLM_CONNECT_TIMEOUT_SECONDS`
- `LLM_READ_TIMEOUT_SECONDS`
- `LLM_WRITE_TIMEOUT_SECONDS`
- `LLM_POOL_TIMEOUT_SECONDS`
- `LLM_RETRY_ATTEMPTS`
- `LLM_RETRY_BACKOFF_MIN_SECONDS`
- `LLM_RETRY_BACKOFF_MAX_SECONDS`
- `LLM_DISABLE_LOCAL_ONLY_BATCH_SPLIT`

### 通用

- `DEFAULT_LOCALE`
- `PREVIEW_CLEANUP_DAYS`
- `SESSION_RETENTION_DAYS`
- `JOB_RETENTION_DAYS`
- `JOB_MAX_RETRIES`
- `LOG_LEVEL`
- `LOG_MAX_BYTES`
- `LOG_BACKUP_COUNT`

### 管理后台

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD_HASH`
- `ADMIN_SESSION_SECRET`
- `ADMIN_SESSION_MAX_AGE`

生成管理员密码哈希：

```powershell
cd f:\report-generation
python -m mss_ai_ppt_sample_assets.backend.scripts.generate_admin_password
```

### RAG

- `RAG_ENABLED`
- `RAG_VECTOR_BACKEND`
- `RAG_QDRANT_URL`
- `RAG_QDRANT_API_KEY`
- `RAG_QDRANT_COLLECTION`
- `RAG_QDRANT_PATH`
- `RAG_SOURCE_DIR`
- `RAG_EMBED_MODEL`
- `RAG_TOP_K`
- `RAG_CANDIDATE_TOP_K`
- `RAG_MAX_CONTEXT_CHARS`
- `RAG_MAX_CONTEXT_CHARS_PER_SLIDE`
- `RAG_MIN_SCORE`
- `RAG_PROMPT_BUDGET_RATIO`
- `RAG_PROMPT_BUDGET_MIN_TOKENS`
- `RAG_PROMPT_BUDGET_MAX_TOKENS`
- `RAG_CHUNK_SIZE_TOKENS`
- `RAG_CHUNK_OVERLAP_TOKENS`
- `RAG_HF_LOCAL_FILES_ONLY`
- `RAG_ENABLE_RERANK`
- `RAG_RERANK_MODEL`
- `RAG_RERANK_SCENES`
- `RAG_FINAL_TOP_K_PER_SLIDE`
- `RAG_COMMON_FALLBACK_TOP_K`
- `RAG_SECTION_MIN_CHARS`
- `RAG_PRELOAD_ON_STARTUP`

### SOAR Mongo ingestion

- `SOAR_MONGO_URI`
- or split config: `SOAR_MONGO_USERNAME`, `SOAR_MONGO_PASSWORD`, `SOAR_MONGO_HOST`, `SOAR_MONGO_PORT`, `SOAR_MONGO_AUTH_DB`
- `SOAR_MONGO_DATABASE`
- `SOAR_MONGO_ALARM_COLLECTION`
- `SOAR_MONGO_EVENT_COLLECTION`
- `SOAR_MONGO_CONNECT_TIMEOUT_MS`
- `SOAR_MANAGE_SUB_TYPE_MAP_FILE`

Raw extraction script:

```powershell
cd f:\report-generation
python -m mss_ai_ppt_sample_assets.backend.scripts.export_soar_mongo_data `
  --output mss_ai_ppt_sample_assets/backend/outputs/soar_raw_export.json
```

Default date range uses `SOAR_DEFAULT_DATE_RANGE`, and `2025-04-10~2026-04-14`
means Beijing time `2025-04-10T00:00:00+08:00` to `2026-04-14T23:59:59.999999+08:00`.
`manage_sub_type` is resolved from the repository asset configured by `SOAR_MANAGE_SUB_TYPE_MAP_FILE`
(default: `backend/data/ingestion/manage_sub_type_map.json`).
This script only performs query + projection export for `alarm` and `Event_info`.

## Linux 生产部署（systemd）

以下方式适合 Linux 服务器生产环境部署，目标是让服务具备以下能力：

- SSH / 终端断开后继续运行
- 服务异常退出后自动拉起
- 服务器重启后自动启动

本项目推荐直接使用 systemd 托管现有 FastAPI 进程，不修改后端业务启动逻辑，继续沿用：

```bash
python -m uvicorn mss_ai_ppt_sample_assets.backend.app:app --host 0.0.0.0 --port 8000
```

仓库内已提供 systemd 模板：

- `deploy/systemd/mss-ai-ppt.service`
- `mss_ai_ppt_sample_assets/backend/scripts/rag-backend.service`

推荐以前者作为正式部署模板，复制到 `/etc/systemd/system/mss-ai-ppt.service`。

### 1. 准备服务器依赖

至少准备以下运行环境：

- Python 3.10+
- `pip` / 虚拟环境
- LibreOffice（用于 PPT/PDF/预览图相关能力）
- 如启用 RAG/LLM，则需准备对应模型与外部依赖

示例：

```bash
sudo apt-get update
sudo apt-get install -y python3 python3-venv python3-pip libreoffice
```

### 2. 部署目录示例

以下示例假设项目部署到：

```text
/opt/report-generation
```

建议目录结构：

```text
/opt/report-generation/
├─ .env
├─ deploy/
├─ mss_ai_ppt_sample_assets/
└─ .venv/                # 可选，若你使用虚拟环境
```

### 3. 安装 Python 依赖

在项目根目录执行：

```bash
cd /opt/report-generation
python3 -m venv .venv
source .venv/bin/activate
pip install -r mss_ai_ppt_sample_assets/backend/requirements.txt
```

如果你希望 systemd 使用虚拟环境 Python，可将 service 文件中的 `ExecStart` 改为：

```ini
ExecStart=/opt/report-generation/.venv/bin/python -m uvicorn mss_ai_ppt_sample_assets.backend.app:app --host 0.0.0.0 --port 8000
```

### 4. 放置 `.env` 并配置 `MSS_ENV_PATH`

`backend/config.py` 支持通过 `MSS_ENV_PATH` 指定环境文件路径。

当前推荐在 service 中显式配置：

```ini
Environment="MSS_ENV_PATH=/opt/report-generation/.env"
```

这样服务启动时会稳定读取该 `.env` 文件，而不是依赖当前 shell 环境。

建议 `.env` 至少包含你真实需要的配置项，例如：

```dotenv
ENABLE_LLM=false
LOG_LEVEL=INFO
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=<replace-me>
ADMIN_SESSION_SECRET=<replace-me-with-random-secret>
```

如果你需要自定义运行输出目录，也可在 `.env` 中配置：

```dotenv
MSS_OUTPUTS_DIR=/opt/report-generation/mss_ai_ppt_sample_assets/backend/outputs
```

### 5. 创建运行用户并设置目录权限

建议使用专门的 Linux 用户运行服务，例如 `app`：

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin app
sudo chown -R app:app /opt/report-generation
```

请确保运行用户对以下目录有写权限：

- `mss_ai_ppt_sample_assets/backend/outputs/`
- `mss_ai_ppt_sample_assets/backend/outputs/logs/`
- 以及你在 `.env` 中通过 `MSS_OUTPUTS_DIR` 指定的实际输出目录

说明：

- `backend/logging_config.py` 会自动创建日志目录
- 默认会写入滚动日志：
  - `outputs/logs/app.log`
  - `outputs/logs/error.log`

### 6. 安装 systemd service

将仓库中的模板复制到系统目录：

```bash
sudo cp /opt/report-generation/deploy/systemd/mss-ai-ppt.service /etc/systemd/system/mss-ai-ppt.service
```

当前模板核心内容如下：

```ini
[Unit]
Description=MSS AI PPT Backend
After=network.target

[Service]
Type=simple
User=app
Group=app
WorkingDirectory=/opt/report-generation
Environment="MSS_ENV_PATH=/opt/report-generation/.env"
ExecStart=/usr/bin/python3 -m uvicorn mss_ai_ppt_sample_assets.backend.app:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

如果你的 Python 路径、部署目录或运行用户不同，请按实际情况调整 `User`、`Group`、`WorkingDirectory`、`ExecStart` 和 `MSS_ENV_PATH`。

### 7. 启用并启动服务

```bash
sudo systemctl daemon-reload
sudo systemctl enable mss-ai-ppt
sudo systemctl start mss-ai-ppt
sudo systemctl status mss-ai-ppt
```

常用管理命令：

```bash
sudo systemctl restart mss-ai-ppt
sudo systemctl stop mss-ai-ppt
sudo systemctl status mss-ai-ppt
```

查看 systemd 日志：

```bash
sudo journalctl -u mss-ai-ppt -f
```

### 8. 启动后的真实行为

服务启动后，应用会按当前代码执行已有启动流程，包括：

- session 清理
- job 清理
- preview 临时目录和孤儿目录清理
- 中断任务恢复 / 标记失败
- 可选 RAG 预热

这些行为来自 `backend/app.py`，本次部署方式不会改变应用原有启动逻辑。

### 9. 验证部署是否成功

部署后建议依次验证：

```bash
sudo systemctl daemon-reload
sudo systemctl enable mss-ai-ppt
sudo systemctl start mss-ai-ppt
sudo systemctl status mss-ai-ppt
sudo journalctl -u mss-ai-ppt -f
```

再访问：

- `http://<server>:8000/docs`
- `http://<server>:8000/ui/index.html`
- 可选：`GET /api/v1/jobs/{job_id}/status`

常驻能力验证：

- 断开 SSH 后重新连接，确认服务仍为 `active`
- 执行 `sudo systemctl restart mss-ai-ppt`，确认服务可恢复
- 重启服务器后确认服务自动拉起

### 10. 生产环境注意事项

部署到生产环境前，至少检查以下事项：

- 不要继续使用默认 `ADMIN_SESSION_SECRET`
- 必须把 `ADMIN_PASSWORD_HASH` 替换为真实管理员密码哈希
- 当前应用提供 `/ws/{client_id}` WebSocket 接口；若后续接入 nginx / 反向代理，需要开启 WebSocket 透传
- `SessionMiddleware` 当前配置为 `https_only=False`，本轮按“只改服务配置”的要求不改业务代码；若后续上 HTTPS，建议再将其调整为更严格的生产配置


在仓库根目录启动：

```powershell
cd f:\report-generation
python -m uvicorn mss_ai_ppt_sample_assets.backend.app:app --host 0.0.0.0 --port 8000 --reload
```

或者直接运行：

```powershell
cd f:\report-generation
python -m mss_ai_ppt_sample_assets.backend.app
```

启动后常用地址：

- 前端：`http://localhost:8000/ui/index.html`
- 登录页：`http://localhost:8000/ui/login.html`
- 管理页：`http://localhost:8000/ui/admin.html`
- Swagger：`http://localhost:8000/docs`

## 典型使用流程

### 1. 使用内置数据生成报告

```http
POST /api/v1/reports
Content-Type: application/json

{
  "input_id": "classic_ops_dataxlsx",
  "template_id": "mss_classic_ops",
  "use_mock": false,
  "use_rag": false,
  "focus_options": ["vulnerability"]
}
```

说明：

- `focus_options` 在当前接口里是必填字段，不能为空
- 允许值会被归一化为：
  - `vulnerability`
  - `alert`
  - `business_protection`

### 2. 上传 Excel 后生成报告

先上传：

```http
POST /api/v1/inputs/excel
Content-Type: multipart/form-data
```

然后使用返回的 `session_id` 发起生成：

```http
POST /api/v1/reports
Content-Type: application/json

{
  "input_id": "custom",
  "template_id": "mss_classic_ops",
  "session_id": "your_session_id",
  "use_mock": false,
  "use_rag": false,
  "focus_options": ["alert"]
}
```

这里的关键点是：

- 对 `mss_classic_ops`，后端会优先读取该 `session_id` 目录下的 `uploaded.xlsx`
- 因此上传 Excel 后，即使 `input_id` 不是 catalog 中的内置 ID，也可以跑通经典模板流程

### 3. 查询任务状态

```http
GET /api/v1/jobs/{job_id}/status
```

### 4. 下载与预览

- 下载 PPTX：`GET /api/v1/reports/{job_id}/download`
- 下载 PDF：`GET /api/v1/reports/{job_id}/download-pdf`
- 获取预览图：`GET /api/v1/reports/{job_id}/preview`

## 当前任务与并发行为

当前实现有几个重要行为需要明确：

- 报告生成是异步任务，`POST /api/v1/reports` 返回 `202`
- 浏览器通过 cookie 维持 `browser_id`
- 同一个浏览器默认只允许 1 个运行中的任务
- 若重复提交相同请求，系统会通过 `idempotency_key` 复用已有任务
- 若传入 `force_new_task=true`，会取消当前浏览器正在运行的旧任务，并创建新任务
- 服务启动时会把“上次服务异常重启时仍处于 running 的任务”标记为失败

## 报告改写能力

### 批量改写指定页

`PATCH /api/v1/reports/{report_id}/slides`

- 直接更新 slide placeholder 内容
- 改写后会重新渲染 PPT，并重新生成预览图

### AI 改写单页

`POST /api/v1/reports/{report_id}/slides/ai-rewrite`

- 仅在 `ENABLE_LLM=true` 时可用
- `user_prompt` 必填
- `target_tokens` 可选，不传则改写当前页所有 `ai_generate=true` 的 token
- 当前实现里 `use_rag` 参数保留用于兼容，但后端会显式跳过 RAG 检索，优先严格遵循用户提示词

## 评分与后台管理

### 用户评分

- `liked` / `disliked`
- 点踩必须附带至少 10 个字符的评论
- 每个 session 对同一任务只能评一次

### 管理后台

当前后台认证依赖 FastAPI `SessionMiddleware` 的 cookie session。

常用接口：

- 登录：`POST /api/v1/admin/login`
- 校验登录态：`GET /api/v1/admin/verify`
- 任务分页、筛选、搜索：`GET /api/v1/admin/jobs`
- 统计信息：`GET /api/v1/admin/statistics`

## 自动清理与启动时行为

服务启动时会尝试执行以下清理动作：

- 可选预热 RAG
- 清理过期 session
- 清理预览临时目录和孤儿预览目录
- 清理陈旧文件锁
- 将重启前未完成任务标记为失败
- 清理过期 job
