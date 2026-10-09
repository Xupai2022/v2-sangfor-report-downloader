import os
from pathlib import Path
from typing import Optional
from urllib.parse import quote_plus
from dotenv import load_dotenv

# Load .env file from project root
REPO_ROOT_DIR = Path(__file__).resolve().parent.parent.parent
env_path = Path(os.getenv("MSS_ENV_PATH", str(REPO_ROOT_DIR / ".env")))
load_dotenv(dotenv_path=env_path, override=True)

ROOT_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = ROOT_DIR / "frontend"

DATA_DIR = Path(os.getenv("MSS_DATA_DIR", str(ROOT_DIR / "data"))).resolve()
TEMPLATES_DIR = DATA_DIR / "templates"
INPUTS_DIR = DATA_DIR / "inputs"
MOCK_OUTPUTS_DIR = DATA_DIR / "mock_outputs"

OUTPUTS_DIR = Path(os.getenv("MSS_OUTPUTS_DIR", str(ROOT_DIR / "outputs"))).resolve()
REPORTS_DIR = OUTPUTS_DIR / "reports"
LOGS_DIR = OUTPUTS_DIR / "logs"
PREVIEWS_DIR = OUTPUTS_DIR / "previews"
SLIDESPECS_DIR = OUTPUTS_DIR / "slidespecs"
SESSIONS_DIR = OUTPUTS_DIR / "sessions"  # Isolated session directories for concurrent requests
JOBS_DIR = OUTPUTS_DIR / "jobs"  # Job state storage directory
RAG_DIR = OUTPUTS_DIR / "rag"
RAG_META_FILE = RAG_DIR / "index_meta.json"

OUTPUTS_URL_PREFIX = "/" + os.getenv("MSS_OUTPUTS_URL_PREFIX", "/outputs").strip("/")


def outputs_url_for(path: Path) -> str:
    """Convert an outputs filesystem path to a URL path under OUTPUTS_URL_PREFIX."""
    prefix = OUTPUTS_URL_PREFIX.rstrip("/")
    try:
        rel = path.resolve().relative_to(OUTPUTS_DIR.resolve())
        return f"{prefix}/{rel.as_posix()}"
    except Exception:
        return str(path)


class Settings:
    """Centralised configuration for the backend service (minimal env reader)."""

    def __init__(self):
        # OpenAI-compatible endpoint configuration
        self.openai_api_key: Optional[str] = os.getenv("OPENAI_API_KEY")
        self.openai_base_url: Optional[str] = os.getenv("OPENAI_BASE_URL")
        self.openai_model: str = os.getenv("OPENAI_MODEL", "GLM4.7")
        self.llm_temperature: float = float(os.getenv("LLM_TEMPERATURE", "0.3"))
        self.llm_json_stream: bool = os.getenv("LLM_JSON_STREAM", "false").lower() == "true"
        # LLM 连接超时（秒）：TCP 建连阶段超时，通常用于快速发现不可达/拒连。
        self.llm_connect_timeout_seconds: float = float(os.getenv("LLM_CONNECT_TIMEOUT_SECONDS", "5"))

        # LLM 读取超时（秒）：请求已发出但长时间收不到上游响应时触发。
        self.llm_read_timeout_seconds: float = float(os.getenv("LLM_READ_TIMEOUT_SECONDS", "240"))

        # LLM 写入超时（秒）：向上游发送请求体/流时写入阻塞超时。
        self.llm_write_timeout_seconds: float = float(os.getenv("LLM_WRITE_TIMEOUT_SECONDS", "15"))

        # LLM 连接池等待超时（秒）：连接池无可用连接时等待上限。
        self.llm_pool_timeout_seconds: float = float(os.getenv("LLM_POOL_TIMEOUT_SECONDS", "5"))

        # LLM 重试次数（总尝试次数）：用于超时/连接失败/限流的内部重试。
        self.llm_retry_attempts: int = int(os.getenv("LLM_RETRY_ATTEMPTS", "2"))
        
        # LLM 重试退避最小等待（秒）：指数退避下限。
        self.llm_retry_backoff_min_seconds: float = float(os.getenv("LLM_RETRY_BACKOFF_MIN_SECONDS", "1"))

        # LLM 重试退避最大等待（秒）：指数退避上限。
        self.llm_retry_backoff_max_seconds: float = float(os.getenv("LLM_RETRY_BACKOFF_MAX_SECONDS", "4"))

        # Feature flags
        self.enable_llm: bool = os.getenv("ENABLE_LLM", "false").lower() == "true"
        # When enabled, local_only slides are forced into a single batch
        # (legacy local_only split/optimization remains available when disabled).
        self.llm_disable_local_only_batch_split: bool = (
            os.getenv("LLM_DISABLE_LOCAL_ONLY_BATCH_SPLIT", "false").lower() == "true"
        )
        self.default_locale: str = os.getenv("DEFAULT_LOCALE", "zh-CN")

        # SOAR MongoDB ingestion configuration
        self.soar_mongo_username: Optional[str] = os.getenv("SOAR_MONGO_USERNAME")
        self.soar_mongo_password: Optional[str] = os.getenv("SOAR_MONGO_PASSWORD")
        self.soar_mongo_host: str = os.getenv("SOAR_MONGO_HOST", "")
        self.soar_mongo_port: int = int(os.getenv("SOAR_MONGO_PORT", "27017"))
        self.soar_mongo_auth_db: str = os.getenv("SOAR_MONGO_AUTH_DB", "admin")
        self.soar_mongo_database: str = os.getenv("SOAR_MONGO_DATABASE", "SOAR_DB")
        self.soar_mongo_alarm_collection: str = os.getenv("SOAR_MONGO_ALARM_COLLECTION", "alarm")
        self.soar_mongo_event_collection: str = os.getenv("SOAR_MONGO_EVENT_COLLECTION", "Event_info")
        self.soar_mongo_asset_collection: str = os.getenv("SOAR_MONGO_ASSET_COLLECTION", "Assets")
        self.soar_mongo_business_collection: str = os.getenv("SOAR_MONGO_BUSINESS_COLLECTION", "Business")
        self.soar_mongo_connect_timeout_ms: int = int(os.getenv("SOAR_MONGO_CONNECT_TIMEOUT_MS", "5000"))
        self.soar_mongo_asset_batch_size: int = int(os.getenv("SOAR_MONGO_ASSET_BATCH_SIZE", "5000"))
        self.soar_default_company_id: str = os.getenv("SOAR_DEFAULT_COMPANY_ID", "41621089")
        self.soar_default_date_range: str = os.getenv("SOAR_DEFAULT_DATE_RANGE", "2025-04-10~2026-04-14")
        self.soar_manage_sub_type_map_file: str = os.getenv(
            "SOAR_MANAGE_SUB_TYPE_MAP_FILE",
            str(DATA_DIR / "ingestion" / "manage_sub_type_map.json"),
        )
        configured_soar_uri = (os.getenv("SOAR_MONGO_URI") or "").strip()
        self.soar_mongo_uri: Optional[str] = configured_soar_uri or self._build_soar_mongo_uri()

        # Preview cleanup configuration
        self.preview_cleanup_days: int = int(os.getenv("PREVIEW_CLEANUP_DAYS", "7"))

        # Session cleanup configuration (outputs/sessions retention)
        self.session_retention_days: int = int(os.getenv("SESSION_RETENTION_DAYS", "7"))

        # Logging configuration
        self.log_level: str = os.getenv("LOG_LEVEL", "INFO").upper()
        self.log_max_bytes: int = int(os.getenv("LOG_MAX_BYTES", str(50 * 1024 * 1024)))  # 50MB default
        self.log_backup_count: int = int(os.getenv("LOG_BACKUP_COUNT", "10"))

        # Job management configuration
        self.job_retention_days: int = int(os.getenv("JOB_RETENTION_DAYS", "7"))
        self.job_max_retries: int = int(os.getenv("JOB_MAX_RETRIES", "3"))

        # Admin authentication configuration
        self.admin_username: str = os.getenv("ADMIN_USERNAME", "admin")
        self.admin_password_hash: str = os.getenv("ADMIN_PASSWORD_HASH", "")
        self.admin_session_secret: str = os.getenv(
            "ADMIN_SESSION_SECRET",
            "change-me-in-production-use-secrets-token-urlsafe-32"
        )
        self.admin_session_max_age: int = int(os.getenv("ADMIN_SESSION_MAX_AGE", "604800"))  # 7 days

        # RAG configuration
        self.rag_enabled: bool = os.getenv("RAG_ENABLED", "false").lower() == "true"
        self.rag_vector_backend: str = os.getenv("RAG_VECTOR_BACKEND", "qdrant")
        self.rag_qdrant_url: Optional[str] = os.getenv("RAG_QDRANT_URL")
        self.rag_qdrant_api_key: Optional[str] = os.getenv("RAG_QDRANT_API_KEY")
        self.rag_qdrant_collection: str = os.getenv("RAG_QDRANT_COLLECTION", "kb_chunks")
        self.rag_qdrant_path: str = os.getenv("RAG_QDRANT_PATH", str(RAG_DIR / "qdrant"))
        self.rag_embed_model: str = os.getenv("RAG_EMBED_MODEL", "BAAI/bge-small-zh-v1.5")
        self.rag_top_k: int = int(os.getenv("RAG_TOP_K", "3"))
        self.rag_candidate_top_k: int = int(os.getenv("RAG_CANDIDATE_TOP_K", "16"))
        self.rag_max_context_chars: int = int(os.getenv("RAG_MAX_CONTEXT_CHARS", "4000"))
        self.rag_max_context_chars_per_slide: int = int(os.getenv("RAG_MAX_CONTEXT_CHARS_PER_SLIDE", "1600"))
        self.rag_min_score: float = float(os.getenv("RAG_MIN_SCORE", "0.30"))
        self.rag_prompt_budget_ratio: float = float(os.getenv("RAG_PROMPT_BUDGET_RATIO", "0.20"))
        self.rag_prompt_budget_min_tokens: int = int(os.getenv("RAG_PROMPT_BUDGET_MIN_TOKENS", "400"))
        self.rag_prompt_budget_max_tokens: int = int(os.getenv("RAG_PROMPT_BUDGET_MAX_TOKENS", "2500"))
        self.rag_chunk_size_tokens: int = int(os.getenv("RAG_CHUNK_SIZE_TOKENS", "220"))
        self.rag_chunk_overlap_tokens: int = int(os.getenv("RAG_CHUNK_OVERLAP_TOKENS", "40"))
        self.rag_hf_local_files_only: bool = os.getenv("RAG_HF_LOCAL_FILES_ONLY", "false").lower() == "true"
        self.rag_source_dir: str = os.getenv("RAG_SOURCE_DIR", str(DATA_DIR / "rag_docs"))
        self.rag_enable_rerank: bool = os.getenv("RAG_ENABLE_RERANK", "true").lower() == "true"
        self.rag_rerank_model: str = os.getenv(
            "RAG_RERANK_MODEL",
            "mss_ai_ppt_sample_assets/backend/models/bge-reranker-base",
        )
        rerank_scenes_raw = os.getenv("RAG_RERANK_SCENES", "diagnostic,generate,rewrite")
        self.rag_rerank_scenes = {
            item.strip().lower()
            for item in rerank_scenes_raw.split(",")
            if item.strip()
        } or {"diagnostic", "generate", "rewrite"}
        self.rag_final_top_k_per_slide: int = int(os.getenv("RAG_FINAL_TOP_K_PER_SLIDE", "3"))
        self.rag_common_fallback_top_k: int = int(os.getenv("RAG_COMMON_FALLBACK_TOP_K", "2"))
        self.rag_section_min_chars: int = int(os.getenv("RAG_SECTION_MIN_CHARS", "80"))
        self.rag_preload_on_startup: bool = os.getenv("RAG_PRELOAD_ON_STARTUP", "false").lower() == "true"

        # Validate OpenAI configuration when LLM is enabled
        if self.enable_llm and not self.openai_api_key:
            raise ValueError(
                "OPENAI_API_KEY is required when ENABLE_LLM=true. "
                "Please set it in your .env file."
            )

    def _build_soar_mongo_uri(self) -> Optional[str]:
        if not self.soar_mongo_host:
            return None

        credentials = ""
        if self.soar_mongo_username:
            encoded_user = quote_plus(self.soar_mongo_username)
            encoded_password = quote_plus(self.soar_mongo_password or "")
            credentials = f"{encoded_user}:{encoded_password}@"

        return (
            f"mongodb://{credentials}{self.soar_mongo_host}:{self.soar_mongo_port}/"
            f"{self.soar_mongo_auth_db}?authSource={self.soar_mongo_auth_db}"
        )


settings = Settings()
