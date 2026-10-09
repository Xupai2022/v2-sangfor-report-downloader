from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
import uuid
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from zipfile import ZipFile

import fitz
from lxml import etree

from mss_ai_ppt_sample_assets.backend import config
from mss_ai_ppt_sample_assets.backend.models.inputs import TenantInput

logger = logging.getLogger(__name__)

_LOCAL_RERANK_WEIGHT_FILES = (
    "model.safetensors",
    "pytorch_model.bin",
    "tf_model.h5",
    "flax_model.msgpack",
)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sanitize_filename(value: str) -> str:
    text = re.sub(r"[^0-9A-Za-z._-]+", "_", value or "").strip("._")
    return text or "unknown"


def _clean_whitespace(text: str) -> str:
    compact = " ".join((text or "").replace("\u3000", " ").split())
    return compact.strip()


def _estimate_chars_per_token() -> int:
    # Simple and stable approximation for mixed zh/en content.
    return 2


@dataclass
class RetrievalResult:
    rag_used: bool
    context: str = ""
    retrieval_trace: List[Dict[str, Any]] = field(default_factory=list)
    hits: List[Dict[str, Any]] = field(default_factory=list)
    context_by_slide: Dict[str, str] = field(default_factory=dict)
    retrieval_stats: Dict[str, Any] = field(default_factory=dict)


@dataclass
class GenerationRetrievalTask:
    slide_key: str
    slide_title: str
    ai_tokens: List[str]
    ai_instructions: List[str]
    facts: Dict[str, Any]
    focus_options: List[str]
    context_policy: str = "auto"


@dataclass
class RewriteRetrievalTask:
    slide_key: str
    ai_tokens: List[str]
    ai_instructions: List[str]
    user_prompt: str
    facts: Dict[str, Any]
    current_slide_content: Dict[str, Any]


@dataclass
class MarkdownSection:
    text: str
    section_scope: str
    slide_key: str
    section_title: str
    heading_path: str
    page_no: Optional[int] = None


class QueryBuilderV2:
    """Construct compact retrieval queries aligned to generation tasks."""

    MAX_INSTRUCTION_CHARS = 120
    MAX_USER_PROMPT_CHARS = 220
    MAX_FACT_VALUE_CHARS = 80
    MAX_FACT_ITEMS = 8

    @staticmethod
    def _truncate(text: Any, limit: int) -> str:
        value = str(text or "").strip()
        if len(value) <= limit:
            return value
        return value[: max(0, limit - 3)].rstrip() + "..."

    @staticmethod
    def _compact_fact_key(path: str) -> str:
        parts = [part for part in str(path or "").split(".") if part]
        return parts[-1] if parts else str(path or "")

    @classmethod
    def _summarize_scalar(cls, value: Any) -> str:
        if value is None:
            return "null"
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, (int, float)):
            return str(value)
        if isinstance(value, str):
            return cls._truncate(value, cls.MAX_FACT_VALUE_CHARS)
        return cls._truncate(json.dumps(value, ensure_ascii=False), cls.MAX_FACT_VALUE_CHARS)

    @classmethod
    def _is_scalar_value(cls, value: Any) -> bool:
        return value is None or isinstance(value, (bool, int, float, str))

    @classmethod
    def _summarize_value(cls, key: str, value: Any) -> str:
        compact_key = cls._compact_fact_key(key)
        if cls._is_scalar_value(value):
            return f"{compact_key}={cls._summarize_scalar(value)}"
        if isinstance(value, list):
            return f"{compact_key}=[list:{len(value)}]"
        if isinstance(value, dict):
            dict_keys = [str(item) for item in list(value.keys())[:5]]
            suffix = ",..." if len(value) > 5 else ""
            return f"{compact_key}={{keys:{','.join(dict_keys)}{suffix}}}"
        return f"{compact_key}={cls._summarize_scalar(value)}"

    @classmethod
    def _normalize_facts(cls, facts: Dict[str, Any]) -> List[str]:
        if not facts:
            return []

        scalar_items: List[Tuple[str, Any]] = []
        structured_items: List[Tuple[str, Any]] = []
        for key in sorted(facts.keys()):
            value = facts[key]
            if cls._is_scalar_value(value):
                scalar_items.append((key, value))
            else:
                structured_items.append((key, value))

        normalized: List[str] = []
        for key, value in scalar_items + structured_items:
            if len(normalized) >= cls.MAX_FACT_ITEMS:
                normalized.append(f"...(+{len(facts) - cls.MAX_FACT_ITEMS} more facts)")
                break
            normalized.append(cls._summarize_value(key, value))
        return normalized

    @classmethod
    def _normalize_current_slide(cls, current_slide: Dict[str, Any]) -> List[str]:
        if not current_slide:
            return []

        normalized: List[str] = []
        for idx, key in enumerate(sorted(current_slide.keys())):
            if idx >= cls.MAX_FACT_ITEMS:
                normalized.append(f"...(+{len(current_slide) - cls.MAX_FACT_ITEMS} more current values)")
                break
            normalized.append(cls._summarize_value(key, current_slide[key]))
        return normalized

    @classmethod
    def _normalize_instructions(cls, instructions: List[str]) -> List[str]:
        return [
            cls._truncate(item, cls.MAX_INSTRUCTION_CHARS)
            for item in instructions
            if (item or "").strip()
        ][:2]

    @classmethod
    def _build_lines(
        cls,
        *,
        scene: str,
        template_id: str,
        slide_key: str,
        slide_title: Optional[str],
        context_policy: Optional[str],
        focus_options: Optional[List[str]],
        ai_tokens: List[str],
        ai_instructions: List[str],
        facts: Dict[str, Any],
        user_prompt: Optional[str] = None,
        current_slide_content: Optional[Dict[str, Any]] = None,
    ) -> str:
        lines = [
            f"scene: {scene}",
            f"template: {template_id}",
            f"slide_key: {slide_key}",
        ]
        if slide_title:
            lines.append(f"slide_title: {slide_title}")
        if context_policy:
            lines.append(f"context_policy: {context_policy}")
        if focus_options:
            lines.append(f"focus: {', '.join(focus_options)}")
        if ai_tokens:
            lines.append(f"ai_tokens: {', '.join(ai_tokens)}")

        task_summary = cls._normalize_instructions(ai_instructions)
        if task_summary:
            lines.append("task_summary:")
            lines.extend(f"- {item}" for item in task_summary)

        normalized_facts = cls._normalize_facts(facts)
        if normalized_facts:
            lines.append("facts:")
            lines.extend(f"- {item}" for item in normalized_facts)

        if current_slide_content:
            current_lines = cls._normalize_current_slide(current_slide_content)
            if current_lines:
                lines.append("current_slide:")
                lines.extend(f"- {item}" for item in current_lines)

        if user_prompt:
            lines.append(f"user_prompt: {cls._truncate(user_prompt, cls.MAX_USER_PROMPT_CHARS)}")

        return "\n".join(lines).strip()

    @classmethod
    def build_generation_query(
        cls,
        template_id: str,
        task: GenerationRetrievalTask,
    ) -> str:
        return cls._build_lines(
            scene="generate",
            template_id=template_id,
            slide_key=task.slide_key,
            slide_title=task.slide_title,
            context_policy=task.context_policy,
            focus_options=task.focus_options,
            ai_tokens=task.ai_tokens,
            ai_instructions=task.ai_instructions,
            facts=task.facts,
        )

    @classmethod
    def build_rewrite_query(
        cls,
        template_id: str,
        task: RewriteRetrievalTask,
    ) -> str:
        return cls._build_lines(
            scene="rewrite",
            template_id=template_id,
            slide_key=task.slide_key,
            slide_title=None,
            context_policy="local_only",
            focus_options=None,
            ai_tokens=task.ai_tokens,
            ai_instructions=task.ai_instructions,
            facts=task.facts,
            user_prompt=task.user_prompt,
            current_slide_content=task.current_slide_content,
        )


class RAGService:
    """RAG indexing and retrieval service with lazy dependency loading."""

    SUPPORTED_SUFFIXES = {".pdf", ".docx", ".md", ".markdown", ".txt"}

    def __init__(self):
        self._lock = threading.Lock()
        self._embedder = None
        self._reranker = None
        self._reranker_status: Optional[str] = None
        self._qdrant_client = None
        self._qmodels = None
        self._embedding_dim: Optional[int] = None
        config.RAG_DIR.mkdir(parents=True, exist_ok=True)

    @property
    def enabled(self) -> bool:
        return bool(config.settings.rag_enabled)

    def _check_enabled(self) -> None:
        if not self.enabled:
            raise ValueError("RAG is disabled. Set RAG_ENABLED=true to use RAG features.")

    def _load_dependencies(self) -> None:
        if self._embedder is not None and self._qdrant_client is not None and self._qmodels is not None:
            return

        with self._lock:
            if self._embedder is None:
                try:
                    from sentence_transformers import SentenceTransformer
                except Exception as e:
                    raise RuntimeError(
                        "sentence-transformers is not available. Install backend requirements first."
                    ) from e

                model_ref = self._resolve_embed_model_ref(config.settings.rag_embed_model)
                self._embedder = SentenceTransformer(
                    model_ref,
                    device="cpu",
                    trust_remote_code=False,
                    local_files_only=config.settings.rag_hf_local_files_only,
                )

            if self._qdrant_client is None or self._qmodels is None:
                try:
                    from qdrant_client import QdrantClient
                    from qdrant_client.http import models as qmodels
                except Exception as e:
                    raise RuntimeError("qdrant-client is not available. Install backend requirements first.") from e

                if config.settings.rag_qdrant_url:
                    self._qdrant_client = QdrantClient(
                        url=config.settings.rag_qdrant_url,
                        api_key=config.settings.rag_qdrant_api_key or None,
                    )
                else:
                    local_path = Path(config.settings.rag_qdrant_path).resolve()
                    local_path.mkdir(parents=True, exist_ok=True)
                    self._qdrant_client = QdrantClient(path=str(local_path))
                self._qmodels = qmodels

            if self._embedding_dim is None:
                probe = self._encode_texts(["embedding dimension probe"])
                if not probe or not probe[0]:
                    raise RuntimeError("Failed to initialize embedding model.")
                self._embedding_dim = len(probe[0])

    @staticmethod
    def _resolve_embed_model_ref(model_ref: str) -> str:
        """Resolve local model path when configured as a relative path.

        Priority:
        1) absolute path if exists
        2) path relative to current working directory
        3) path relative to repository root
        4) raw model_ref (treated as huggingface repo id)
        """
        if not model_ref:
            return model_ref

        candidate = Path(model_ref)
        if candidate.is_absolute() and candidate.exists():
            return str(candidate)

        cwd_path = Path.cwd() / candidate
        if cwd_path.exists():
            return str(cwd_path.resolve())

        repo_path = config.REPO_ROOT_DIR / candidate
        if repo_path.exists():
            return str(repo_path.resolve())

        return model_ref

    def _resolve_rerank_model_ref(self) -> str:
        return self._resolve_embed_model_ref(config.settings.rag_rerank_model)

    def _local_reranker_is_complete(self, model_ref: str) -> bool:
        model_path = Path(model_ref)
        if not model_path.exists():
            return False
        if not model_path.is_dir():
            return True
        return any((model_path / name).exists() for name in _LOCAL_RERANK_WEIGHT_FILES)

    def _load_reranker(self):
        if not config.settings.rag_enable_rerank:
            self._reranker_status = "disabled"
            return None

        if self._reranker is not None:
            self._reranker_status = "ready"
            return self._reranker
        if self._reranker_status == "unavailable":
            return None

        with self._lock:
            if self._reranker is not None:
                self._reranker_status = "ready"
                return self._reranker
            if self._reranker_status == "unavailable":
                return None

            model_ref = self._resolve_rerank_model_ref()
            if config.settings.rag_hf_local_files_only and not self._local_reranker_is_complete(model_ref):
                self._reranker_status = "unavailable"
                logger.warning(
                    "RAG reranker skipped: local model missing weights at %s (expected one of %s)",
                    model_ref,
                    ", ".join(_LOCAL_RERANK_WEIGHT_FILES),
                )
                return None

            try:
                from sentence_transformers import CrossEncoder

                self._reranker = CrossEncoder(
                    model_ref,
                    trust_remote_code=False,
                    local_files_only=config.settings.rag_hf_local_files_only,
                )
                self._reranker_status = "ready"
            except Exception as e:
                self._reranker_status = "unavailable"
                logger.warning("Failed to initialize RAG reranker: %s", e)
                self._reranker = None
            return self._reranker

    def _encode_texts(self, texts: List[str]) -> List[List[float]]:
        vectors = self._embedder.encode(
            texts,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
        return vectors.tolist()

    def _ensure_collection(self, reset_collection: bool = False) -> None:
        self._load_dependencies()
        assert self._qdrant_client is not None
        assert self._qmodels is not None
        assert self._embedding_dim is not None

        collection = config.settings.rag_qdrant_collection
        qmodels = self._qmodels

        if reset_collection:
            try:
                self._qdrant_client.delete_collection(collection_name=collection)
            except Exception:
                pass

        try:
            self._qdrant_client.get_collection(collection_name=collection)
            return
        except Exception:
            pass

        self._qdrant_client.create_collection(
            collection_name=collection,
            vectors_config=qmodels.VectorParams(
                size=self._embedding_dim,
                distance=qmodels.Distance.COSINE,
            ),
        )

    def _read_meta(self) -> Dict[str, Any]:
        meta_path = config.RAG_META_FILE
        if not meta_path.exists():
            return {}
        try:
            return json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def _write_meta(self, payload: Dict[str, Any]) -> None:
        meta_path = config.RAG_META_FILE
        meta_path.parent.mkdir(parents=True, exist_ok=True)
        meta_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def _extract_docx_text(self, path: Path) -> str:
        try:
            with ZipFile(path, "r") as zf:
                raw = zf.read("word/document.xml")
        except Exception:
            return ""

        try:
            root = etree.fromstring(raw)
            ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
            nodes = root.xpath(".//w:t", namespaces=ns)
            texts = [node.text for node in nodes if node.text]
            return "\n".join(texts)
        except Exception:
            return ""

    def _split_text(self, text: str, page_no: Optional[int]) -> List[Dict[str, Any]]:
        return self._chunk_text(
            text,
            page_no=page_no,
            metadata={},
        )

    def _chunk_text(
        self,
        text: str,
        *,
        page_no: Optional[int],
        metadata: Dict[str, Any],
    ) -> List[Dict[str, Any]]:
        cleaned = _clean_whitespace(text)
        if not cleaned:
            return []

        chunk_tokens = max(120, int(config.settings.rag_chunk_size_tokens))
        overlap_tokens = max(0, int(config.settings.rag_chunk_overlap_tokens))
        chars_per_token = _estimate_chars_per_token()
        chunk_chars = chunk_tokens * chars_per_token
        overlap_chars = min(overlap_tokens * chars_per_token, max(0, chunk_chars - 10))

        chunks: List[Dict[str, Any]] = []
        start = 0
        chunk_order = 0
        while start < len(cleaned):
            end = min(len(cleaned), start + chunk_chars)
            part = cleaned[start:end].strip()
            if part:
                chunks.append({
                    'text': part,
                    'page_no': page_no,
                    'chunk_order': chunk_order,
                    **metadata,
                })
                chunk_order += 1
            if end >= len(cleaned):
                break
            start = max(0, end - overlap_chars)
        return chunks

    @staticmethod
    def _parse_rag_marker(line: str) -> Optional[Dict[str, str]]:
        match = re.match(r'\s*<!--\s*rag:(.*?)-->\s*$', line)
        if not match:
            return None

        attrs: Dict[str, str] = {}
        for key, value in re.findall(r'(\w+)=([^\s]+)', match.group(1)):
            attrs[key] = value.strip()
        return attrs or None

    @staticmethod
    def _heading_title(raw_line: str) -> str:
        return re.sub(r'^#+\s*', '', raw_line).strip()

    def _merge_small_markdown_sections(self, sections: List[MarkdownSection]) -> List[MarkdownSection]:
        if not sections:
            return []

        min_chars = max(20, int(config.settings.rag_section_min_chars))
        merged: List[MarkdownSection] = []
        idx = 0
        while idx < len(sections):
            section = sections[idx]
            text = section.text.strip()
            if len(_clean_whitespace(text)) < min_chars and idx + 1 < len(sections):
                nxt = sections[idx + 1]
                if nxt.section_scope == section.section_scope and nxt.slide_key == section.slide_key:
                    merged.append(
                        MarkdownSection(
                            text=(
                                f"{section.section_title}\n{text}\n\n"
                                f"{nxt.section_title}\n{nxt.text.strip()}"
                            ).strip(),
                            section_scope=section.section_scope,
                            slide_key=section.slide_key,
                            section_title=f"{section.section_title} + {nxt.section_title}",
                            heading_path=f"{section.heading_path} -> {nxt.heading_path}",
                            page_no=section.page_no,
                        )
                    )
                    idx += 2
                    continue
            merged.append(section)
            idx += 1
        return merged

    def _extract_markdown_sections(self, path: Path) -> List[MarkdownSection]:
        try:
            raw = path.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            raw = path.read_text(encoding='utf-8', errors='ignore')
        except Exception as e:
            logger.warning('Failed to read markdown file %s: %s', path, e)
            return []

        scope = 'document'
        slide_key = '__all__'
        heading_stack: List[str] = []
        current: Optional[MarkdownSection] = None
        sections: List[MarkdownSection] = []

        def flush() -> None:
            nonlocal current
            if current is None:
                return
            text_value = current.text.strip()
            if text_value:
                current.text = text_value
                sections.append(current)
            current = None

        for line in raw.splitlines():
            marker = self._parse_rag_marker(line)
            if marker is not None:
                flush()
                scope = marker.get('scope', scope or 'document')
                slide_key = marker.get('slide_key', '__common__' if scope == 'common' else '__all__')
                continue

            heading_match = re.match(r'^(#{2,3})\s+(.*)$', line)
            if heading_match:
                flush()
                level = len(heading_match.group(1))
                title = self._heading_title(line)
                stack_depth = max(0, level - 2)
                heading_stack[:] = heading_stack[:stack_depth]
                heading_stack.append(title)
                current = MarkdownSection(
                    text='',
                    section_scope=scope,
                    slide_key='__common__' if scope == 'common' else slide_key,
                    section_title=title,
                    heading_path=' / '.join(heading_stack),
                    page_no=None,
                )
                continue

            if current is None:
                continue
            current.text += (line + "\n")

        flush()
        return self._merge_small_markdown_sections(sections)

    def _split_markdown_section(self, section: MarkdownSection) -> List[Dict[str, Any]]:
        chunk_tokens = max(120, int(config.settings.rag_chunk_size_tokens))
        overlap_tokens = max(0, int(config.settings.rag_chunk_overlap_tokens))
        chars_per_token = _estimate_chars_per_token()
        chunk_chars = chunk_tokens * chars_per_token
        overlap_chars = min(overlap_tokens * chars_per_token, max(0, chunk_chars - 10))
        blocks = [block.strip() for block in re.split(r"\n\s*\n", section.text) if block.strip()]
        if not blocks:
            return []

        chunks: List[str] = []
        current = ''
        for block in blocks:
            block_text = _clean_whitespace(block)
            if not block_text:
                continue
            candidate = f"{current}\n\n{block_text}".strip() if current else block_text
            if current and len(candidate) > chunk_chars:
                chunks.append(current)
                current = block_text
                continue
            if len(block_text) > chunk_chars:
                if current:
                    chunks.append(current)
                    current = ''
                oversized_parts = self._chunk_text(
                    block_text,
                    page_no=section.page_no,
                    metadata={},
                )
                chunks.extend([item['text'] for item in oversized_parts])
                continue
            current = candidate
        if current:
            chunks.append(current)

        normalized_chunks: List[Dict[str, Any]] = []
        for idx, chunk_text in enumerate(chunks):
            if idx > 0 and overlap_chars > 0:
                overlap_prefix = chunks[idx - 1][-overlap_chars:].strip()
                if overlap_prefix and not chunk_text.startswith(overlap_prefix):
                    chunk_text = f"{overlap_prefix}\n{chunk_text}".strip()
            normalized_chunks.append(
                {
                    'text': chunk_text,
                    'page_no': section.page_no,
                    'chunk_order': idx,
                    'slide_key': section.slide_key,
                    'section_scope': section.section_scope,
                    'section_title': section.section_title,
                    'heading_path': section.heading_path,
                }
            )
        return normalized_chunks

    def _extract_chunks_from_file(self, path: Path) -> List[Dict[str, Any]]:
        suffix = path.suffix.lower()
        if suffix == '.pdf':
            chunks: List[Dict[str, Any]] = []
            try:
                doc = fitz.open(path)
                for i in range(doc.page_count):
                    page_text = doc.load_page(i).get_text('text')
                    chunks.extend(
                        self._chunk_text(
                            page_text,
                            page_no=i + 1,
                            metadata={
                                'slide_key': '__all__',
                                'section_scope': 'document',
                                'section_title': path.stem,
                                'heading_path': path.stem,
                            },
                        )
                    )
                doc.close()
            except Exception as e:
                logger.warning('Failed to parse PDF %s: %s', path, e)
            return chunks

        if suffix == '.docx':
            return self._chunk_text(
                self._extract_docx_text(path),
                page_no=None,
                metadata={
                    'slide_key': '__all__',
                    'section_scope': 'document',
                    'section_title': path.stem,
                    'heading_path': path.stem,
                },
            )

        if suffix in {'.md', '.markdown'}:
            chunks: List[Dict[str, Any]] = []
            for section in self._extract_markdown_sections(path):
                chunks.extend(self._split_markdown_section(section))
            return chunks

        try:
            raw = path.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            raw = path.read_text(encoding='utf-8', errors='ignore')
        except Exception as e:
            logger.warning('Failed to read text file %s: %s', path, e)
            return []
        return self._chunk_text(
            raw,
            page_no=None,
            metadata={
                'slide_key': '__all__',
                'section_scope': 'document',
                'section_title': path.stem,
                'heading_path': path.stem,
            },
        )

    def _iter_source_files(self, source_dir: Path) -> Iterable[Path]:
        for path in sorted(source_dir.rglob("*")):
            if not path.is_file():
                continue
            if path.suffix.lower() in self.SUPPORTED_SUFFIXES:
                yield path

    @staticmethod
    def _get_nested_raw(raw: Dict[str, Any], path: str) -> Any:
        if not path:
            return None
        current: Any = raw
        for part in path.split("."):
            if isinstance(current, dict):
                current = current.get(part)
            elif isinstance(current, list) and part.isdigit():
                idx = int(part)
                current = current[idx] if 0 <= idx < len(current) else None
            else:
                return None
            if current is None:
                return None
        return current

    def _dump_query_markdown(
        self,
        *,
        session_id: Optional[str],
        scene: str,
        template_id: str,
        query_entries: List[Dict[str, Any]],
    ) -> None:
        """Persist built RAG query text into session directory for auditing/debugging."""
        if not session_id or not query_entries:
            return
        try:
            session_dir = config.SESSIONS_DIR / session_id
            session_dir.mkdir(parents=True, exist_ok=True)
            ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
            filename = f"rag_query_{_sanitize_filename(scene)}_{ts}.md"
            path = session_dir / filename

            lines: List[str] = [
                "# RAG Query Dump",
                "",
                "## Metadata",
                f"- scene: `{scene}`",
                f"- template_id: `{template_id}`",
                f"- session_id: `{session_id}`",
                f"- query_count: `{len(query_entries)}`",
                "",
            ]
            for idx, item in enumerate(query_entries, start=1):
                slide_key = item.get("slide_key")
                lines.append(f"## Query {idx}")
                if slide_key:
                    lines.append(f"- slide_key: `{slide_key}`")
                if item.get("query_chars") is not None:
                    lines.append(f"- query_chars: `{item.get('query_chars')}`")
                if item.get("query_mode"):
                    lines.append(f"- query_mode: `{item.get('query_mode')}`")
                lines.extend([
                    "",
                    "```text",
                    item.get("query_text", ""),
                    "```",
                    "",
                ])

            path.write_text("\n".join(lines), encoding="utf-8")
            logger.info("RAG query markdown dumped: %s", path)
        except Exception as e:
            logger.warning("Failed to dump RAG query markdown for session %s: %s", session_id, e)

    def _dump_retrieval_markdown(
        self,
        *,
        session_id: Optional[str],
        scene: str,
        template_id: str,
        retrieval_result: RetrievalResult,
    ) -> None:
        """Persist retrieval output into session directory for auditing/debugging."""
        if not session_id:
            return
        try:
            session_dir = config.SESSIONS_DIR / session_id
            session_dir.mkdir(parents=True, exist_ok=True)
            ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
            filename = f"rag_retrieval_{_sanitize_filename(scene)}_{ts}.md"
            path = session_dir / filename

            def _json(obj: Any) -> str:
                return json.dumps(obj, ensure_ascii=False, indent=2)

            lines: List[str] = [
                "# RAG Retrieval Dump",
                "",
                "## Metadata",
                f"- scene: `{scene}`",
                f"- template_id: `{template_id}`",
                f"- session_id: `{session_id}`",
                f"- rag_used: `{bool(retrieval_result.rag_used)}`",
                f"- hits_count: `{len(retrieval_result.hits or [])}`",
                f"- trace_count: `{len(retrieval_result.retrieval_trace or [])}`",
                "",
                "## Context",
                "```text",
                retrieval_result.context or "",
                "```",
                "",
                "## Context By Slide",
                "```json",
                _json(retrieval_result.context_by_slide or {}),
                "```",
                "",
                "## Retrieval Stats",
                "```json",
                _json(retrieval_result.retrieval_stats or {}),
                "```",
                "",
                "## Retrieval Trace",
                "```json",
                _json(retrieval_result.retrieval_trace or []),
                "```",
                "",
                "## Hits",
                "```json",
                _json(retrieval_result.hits or []),
                "```",
                "",
            ]
            path.write_text("\n".join(lines), encoding="utf-8")
            logger.info("RAG retrieval markdown dumped: %s", path)
        except Exception as e:
            logger.warning("Failed to dump RAG retrieval markdown for session %s: %s", session_id, e)

    def _upsert_records(self, records: List[Dict[str, Any]]) -> None:
        self._load_dependencies()
        assert self._qdrant_client is not None
        assert self._qmodels is not None
        qmodels = self._qmodels

        if not records:
            return

        texts = [item["text"] for item in records]
        vectors = self._encode_texts(texts)
        points = [
            qmodels.PointStruct(
                id=item["point_id"],
                vector=vector,
                payload={
                    "chunk_id": item["chunk_id"],
                    "text": item["text"],
                    "source_file": item["source_file"],
                    "page_no": item["page_no"],
                    "chunk_order": item["chunk_order"],
                    "tenant_id": item["tenant_id"],
                    "template_id": item["template_id"],
                    "doc_type": item["doc_type"],
                    "slide_key": item["slide_key"],
                    "section_scope": item["section_scope"],
                    "section_title": item["section_title"],
                    "heading_path": item["heading_path"],
                    "updated_at": item["updated_at"],
                },
            )
            for item, vector in zip(records, vectors)
        ]

        self._qdrant_client.upsert(
            collection_name=config.settings.rag_qdrant_collection,
            points=points,
            wait=True,
        )

    def build_index(
        self,
        source_dir: Optional[str] = None,
        template_id: Optional[str] = None,
        reset_collection: bool = True,
    ) -> Dict[str, Any]:
        self._check_enabled()
        self._ensure_collection(reset_collection=reset_collection)

        source = Path(source_dir or config.settings.rag_source_dir).resolve()
        if not source.exists() or not source.is_dir():
            raise ValueError(f"RAG source directory not found: {source}")

        tenant_value = "__all__"
        template_value = (template_id or "__all__").strip() or "__all__"
        records: List[Dict[str, Any]] = []
        docs_indexed = 0
        for file_path in self._iter_source_files(source):
            relative = str(file_path.relative_to(source)).replace("\\", "/")
            chunks = self._extract_chunks_from_file(file_path)
            if not chunks:
                continue
            docs_indexed += 1
            for idx, chunk in enumerate(chunks):
                text = chunk["text"]
                hash_input = (
                    f"{tenant_value}|{template_value}|{relative}|{chunk.get('page_no')}|"
                    f"{chunk.get('slide_key')}|{chunk.get('section_scope')}|{chunk.get('heading_path')}|"
                    f"{chunk.get('chunk_order', idx)}|{text}"
                )
                chunk_id = hashlib.sha1(hash_input.encode("utf-8")).hexdigest()
                point_id = str(uuid.UUID(hashlib.md5(hash_input.encode("utf-8")).hexdigest()))
                records.append(
                    {
                        "point_id": point_id,
                        "chunk_id": chunk_id,
                        "text": text,
                        "source_file": relative,
                        "page_no": chunk.get("page_no"),
                        "chunk_order": chunk.get("chunk_order", idx),
                        "tenant_id": tenant_value,
                        "template_id": template_value,
                        "doc_type": file_path.suffix.lower().lstrip("."),
                        "slide_key": chunk.get("slide_key", "__all__"),
                        "section_scope": chunk.get("section_scope", "document"),
                        "section_title": chunk.get("section_title", relative),
                        "heading_path": chunk.get("heading_path", relative),
                        "updated_at": _utc_now_iso(),
                    }
                )

        batch_size = 32
        for i in range(0, len(records), batch_size):
            self._upsert_records(records[i:i + batch_size])

        count = 0
        try:
            assert self._qdrant_client is not None
            count = int(
                self._qdrant_client.count(
                    collection_name=config.settings.rag_qdrant_collection,
                    exact=True,
                ).count
            )
        except Exception:
            count = len(records)

        meta = {
            "rag_enabled": self.enabled,
            "collection": config.settings.rag_qdrant_collection,
            "last_indexed_at": _utc_now_iso(),
            "last_source_dir": str(source),
            "last_tenant_id": tenant_value,
            "last_template_id": template_value,
            "last_reset_collection": reset_collection,
            "indexed_docs": docs_indexed,
            "indexed_chunks_in_last_run": len(records),
            "collection_total_chunks": count,
        }
        self._write_meta(meta)
        return meta

    def update_index(
        self,
        source_dir: Optional[str] = None,
        template_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self.build_index(
            source_dir=source_dir,
            template_id=template_id,
            reset_collection=False,
        )

    def get_status(self) -> Dict[str, Any]:
        meta = self._read_meta()
        base = {
            "rag_enabled": self.enabled,
            "vector_backend": config.settings.rag_vector_backend,
            "collection": config.settings.rag_qdrant_collection,
            "top_k": config.settings.rag_top_k,
            "candidate_top_k": config.settings.rag_candidate_top_k,
            "max_context_chars": config.settings.rag_max_context_chars,
            "max_context_chars_per_slide": config.settings.rag_max_context_chars_per_slide,
            "min_score": config.settings.rag_min_score,
            "embed_model": config.settings.rag_embed_model,
            "rerank_enabled": config.settings.rag_enable_rerank,
            "rerank_model": config.settings.rag_rerank_model,
            "rerank_scenes": sorted(getattr(config.settings, "rag_rerank_scenes", set())),
        }

        if not self.enabled:
            base.update({"ready": False, "reason": "RAG_DISABLED"})
            return {**base, **meta}

        try:
            self._ensure_collection(reset_collection=False)
            assert self._qdrant_client is not None
            count = int(
                self._qdrant_client.count(
                    collection_name=config.settings.rag_qdrant_collection,
                    exact=True,
                ).count
            )
            base.update({"ready": True, "collection_total_chunks": count})
        except Exception as e:
            base.update({"ready": False, "reason": str(e), "collection_total_chunks": 0})

        return {**base, **meta}

    def warm_up(self) -> Dict[str, Any]:
        """Preload RAG dependencies and report timing for startup diagnostics."""
        result: Dict[str, Any] = {
            "rag_enabled": bool(self.enabled),
            "rerank_enabled": bool(config.settings.rag_enable_rerank),
        }

        if not self.enabled:
            result.update({
                "ok": False,
                "skipped": True,
                "reason": "RAG_DISABLED",
                "total_ms": 0,
            })
            return result

        start_total = time.perf_counter()
        try:
            start = time.perf_counter()
            self._load_dependencies()
            result["load_dependencies_ms"] = round((time.perf_counter() - start) * 1000, 2)

            start = time.perf_counter()
            self._ensure_collection(reset_collection=False)
            result["ensure_collection_ms"] = round((time.perf_counter() - start) * 1000, 2)

            if config.settings.rag_enable_rerank:
                start = time.perf_counter()
                reranker = self._load_reranker()
                result["load_reranker_ms"] = round((time.perf_counter() - start) * 1000, 2)
                result["reranker_loaded"] = reranker is not None
                result["reranker_status"] = self._reranker_status
            else:
                result["load_reranker_ms"] = 0
                result["reranker_loaded"] = False
                result["reranker_status"] = "disabled"

            result["ok"] = True
            result["skipped"] = False
            result["total_ms"] = round((time.perf_counter() - start_total) * 1000, 2)
            return result
        except Exception as e:
            result["ok"] = False
            result["skipped"] = False
            result["error"] = str(e)
            result["total_ms"] = round((time.perf_counter() - start_total) * 1000, 2)
            return result

    def _build_query_filter(
        self,
        template_id: Optional[str],
        slide_keys: Optional[List[str]] = None,
        section_scopes: Optional[List[str]] = None,
    ):
        assert self._qmodels is not None
        qmodels = self._qmodels

        must = []
        if template_id:
            must.append(
                qmodels.FieldCondition(
                    key="template_id",
                    match=qmodels.MatchAny(any=[template_id, "__all__"]),
                )
            )
        if slide_keys:
            must.append(
                qmodels.FieldCondition(
                    key="slide_key",
                    match=qmodels.MatchAny(any=slide_keys),
                )
            )
        if section_scopes:
            must.append(
                qmodels.FieldCondition(
                    key="section_scope",
                    match=qmodels.MatchAny(any=section_scopes),
                )
            )

        if not must:
            return None
        return qmodels.Filter(must=must)

    @staticmethod
    def _serialize_hit(point: Any) -> Dict[str, Any]:
        payload = dict(getattr(point, 'payload', {}) or {})
        dense_score = float(getattr(point, 'score', 0.0))
        return {
            'chunk_id': payload.get('chunk_id') or str(getattr(point, 'id', '')),
            'score': dense_score,
            'dense_score': dense_score,
            'rerank_score': None,
            'source_file': payload.get('source_file'),
            'page_no': payload.get('page_no'),
            'text': payload.get('text', ''),
            'tenant_id': payload.get('tenant_id'),
            'template_id': payload.get('template_id'),
            'doc_type': payload.get('doc_type'),
            'slide_key': payload.get('slide_key', '__all__'),
            'section_scope': payload.get('section_scope', 'document'),
            'section_title': payload.get('section_title'),
            'heading_path': payload.get('heading_path'),
            'chunk_order': payload.get('chunk_order', 0),
        }

    @staticmethod
    def _build_trace_from_hits(hits: List[Dict[str, Any]], scene: str) -> List[Dict[str, Any]]:
        trace: List[Dict[str, Any]] = []
        for item in hits:
            trace.append(
                {
                    'chunk_id': item.get('chunk_id'),
                    'score': item.get('score'),
                    'dense_score': item.get('dense_score'),
                    'rerank_score': item.get('rerank_score'),
                    'source_file': item.get('source_file'),
                    'page_no': item.get('page_no'),
                    'scene': scene,
                    'slide_key': item.get('slide_key'),
                    'section_scope': item.get('section_scope'),
                    'section_title': item.get('section_title'),
                    'heading_path': item.get('heading_path'),
                    'chunk_order': item.get('chunk_order'),
                }
            )
        return trace

    @staticmethod
    def _dedupe_hits(hits: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        seen = set()
        deduped: List[Dict[str, Any]] = []
        for item in hits:
            chunk_id = item.get('chunk_id')
            if chunk_id in seen:
                continue
            seen.add(chunk_id)
            deduped.append(item)
        return deduped

    def _search_dense_hits(
        self,
        *,
        normalized_query: str,
        template_id: Optional[str],
        slide_keys: Optional[List[str]],
        section_scopes: Optional[List[str]],
        candidate_top_k: int,
        min_score: Optional[float],
    ) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
        self._ensure_collection(reset_collection=False)
        assert self._qdrant_client is not None

        vector = self._encode_texts([normalized_query])[0]
        query_filter = self._build_query_filter(
            template_id=template_id,
            slide_keys=slide_keys,
            section_scopes=section_scopes,
        )
        score_threshold = float(config.settings.rag_min_score if min_score is None else min_score)

        if hasattr(self._qdrant_client, 'query_points'):
            response = self._qdrant_client.query_points(
                collection_name=config.settings.rag_qdrant_collection,
                query=vector,
                query_filter=query_filter,
                limit=max(1, candidate_top_k),
                with_payload=True,
                with_vectors=False,
            )
            raw_hits = getattr(response, 'points', []) or []
        else:
            raw_hits = self._qdrant_client.search(
                collection_name=config.settings.rag_qdrant_collection,
                query_vector=vector,
                query_filter=query_filter,
                limit=max(1, candidate_top_k),
                with_payload=True,
                with_vectors=False,
            )

        hits: List[Dict[str, Any]] = []
        raw_count = 0
        dropped_count = 0
        for point in raw_hits:
            raw_count += 1
            item = self._serialize_hit(point)
            if item['dense_score'] < score_threshold:
                dropped_count += 1
                continue
            hits.append(item)

        return hits, {
            'candidate_count': max(1, candidate_top_k),
            'raw_hits': raw_count,
            'dense_kept_hits': len(hits),
            'dropped_hits': dropped_count,
            'min_score': score_threshold,
        }

    def _rerank_hits(
        self,
        *,
        scene: str,
        normalized_query: str,
        hits: List[Dict[str, Any]],
        final_top_k: int,
    ) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
        if not hits:
            return [], {
                'rerank_enabled': False,
                'rerank_degraded_reason': 'no_hits',
            }

        scene_name = (scene or "").strip().lower()
        allowed_scenes = getattr(config.settings, "rag_rerank_scenes", {"diagnostic", "generate", "rewrite"})
        if scene_name and allowed_scenes and scene_name not in allowed_scenes:
            ordered = sorted(hits, key=lambda item: item.get('dense_score', 0.0), reverse=True)
            for item in ordered:
                item['score'] = item.get('dense_score', 0.0)
            return ordered[:final_top_k], {
                'rerank_enabled': False,
                'rerank_degraded_reason': f'disabled_for_scene:{scene_name}',
            }

        reranker = self._load_reranker()
        if reranker is None:
            reason = self._reranker_status or ('disabled' if not config.settings.rag_enable_rerank else 'unavailable')
            ordered = sorted(hits, key=lambda item: item.get('dense_score', 0.0), reverse=True)
            for item in ordered:
                item['score'] = item.get('dense_score', 0.0)
            return ordered[:final_top_k], {
                'rerank_enabled': False,
                'rerank_degraded_reason': reason,
            }

        try:
            pairs = [(normalized_query, item.get('text', '')) for item in hits]
            try:
                scores = reranker.predict(
                    pairs,
                    show_progress_bar=False,
                )
            except TypeError:
                scores = reranker.predict(pairs)
            for item, score in zip(hits, scores):
                rerank_score = float(score)
                item['rerank_score'] = rerank_score
                item['score'] = rerank_score
            ordered = sorted(
                hits,
                key=lambda item: (item.get('rerank_score', float('-inf')), item.get('dense_score', 0.0)),
                reverse=True,
            )
            return ordered[:final_top_k], {
                'rerank_enabled': True,
                'rerank_degraded_reason': None,
            }
        except Exception as e:
            logger.warning('RAG rerank failed, fallback to dense order: %s', e)
            ordered = sorted(hits, key=lambda item: item.get('dense_score', 0.0), reverse=True)
            for item in ordered:
                item['score'] = item.get('dense_score', 0.0)
            return ordered[:final_top_k], {
                'rerank_enabled': False,
                'rerank_degraded_reason': f'rerank_failed:{e}',
            }

    def _search_hits(
        self,
        *,
        query_text: str,
        template_id: Optional[str],
        scene: str,
        slide_keys: Optional[List[str]] = None,
        section_scopes: Optional[List[str]] = None,
        top_k: Optional[int] = None,
        min_score: Optional[float] = None,
    ) -> RetrievalResult:
        if not self.enabled:
            return RetrievalResult(rag_used=False, context='', retrieval_trace=[], hits=[])

        normalized_query = _clean_whitespace(query_text)
        if not normalized_query:
            return RetrievalResult(rag_used=False, context='', retrieval_trace=[], hits=[])

        start_total = time.perf_counter()
        final_top_k = max(1, int(top_k or config.settings.rag_top_k))
        candidate_top_k = max(final_top_k, int(config.settings.rag_candidate_top_k))
        start_dense = time.perf_counter()
        dense_hits, dense_stats = self._search_dense_hits(
            normalized_query=normalized_query,
            template_id=template_id,
            slide_keys=slide_keys,
            section_scopes=section_scopes,
            candidate_top_k=candidate_top_k,
            min_score=min_score,
        )
        dense_ms = round((time.perf_counter() - start_dense) * 1000, 2)

        start_dedupe = time.perf_counter()
        deduped_hits = self._dedupe_hits(dense_hits)
        dedupe_ms = round((time.perf_counter() - start_dedupe) * 1000, 2)

        start_rerank = time.perf_counter()
        final_hits, rerank_stats = self._rerank_hits(
            scene=scene,
            normalized_query=normalized_query,
            hits=deduped_hits,
            final_top_k=final_top_k,
        )
        rerank_ms = round((time.perf_counter() - start_rerank) * 1000, 2)

        start_trace = time.perf_counter()
        trace = self._build_trace_from_hits(final_hits, scene=scene)
        trace_ms = round((time.perf_counter() - start_trace) * 1000, 2)
        total_ms = round((time.perf_counter() - start_total) * 1000, 2)
        stats = {
            'scene': scene,
            'query_chars': len(normalized_query),
            'top_k': final_top_k,
            'candidate_count': dense_stats.get('candidate_count', candidate_top_k),
            'min_score': dense_stats.get('min_score'),
            'raw_hits': dense_stats.get('raw_hits', 0),
            'dense_kept_hits': dense_stats.get('dense_kept_hits', 0),
            'kept_hits': len(final_hits),
            'dropped_hits': dense_stats.get('dropped_hits', 0),
            'top_score': max((item['score'] for item in final_hits), default=0.0),
            'dense_ms': dense_ms,
            'dedupe_ms': dedupe_ms,
            'rerank_ms': rerank_ms,
            'trace_ms': trace_ms,
            'total_ms': total_ms,
            **rerank_stats,
        }
        logger.info(
            "RAG timing | scene=%s | query_chars=%s | dense=%.2fms | dedupe=%.2fms | rerank=%.2fms | trace=%.2fms | total=%.2fms | raw_hits=%s | kept_hits=%s",
            scene,
            len(normalized_query),
            dense_ms,
            dedupe_ms,
            rerank_ms,
            trace_ms,
            total_ms,
            dense_stats.get('raw_hits', 0),
            len(final_hits),
        )
        return RetrievalResult(
            rag_used=bool(final_hits),
            context='',
            retrieval_trace=trace,
            hits=final_hits,
            retrieval_stats=stats,
        )

    @staticmethod
    def _append_unique_text(base: str, extra: str) -> str:
        if not base:
            return extra
        if not extra:
            return base
        overlap_limit = min(120, len(base), len(extra))
        for size in range(overlap_limit, 19, -10):
            if base.endswith(extra[:size]):
                return base + extra[size:]
        return base + "\n" + extra

    def _merge_context_hits(self, hits: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        merged: List[Dict[str, Any]] = []
        for item in hits:
            if merged:
                prev = merged[-1]
                if (
                    prev.get('source_file') == item.get('source_file')
                    and prev.get('heading_path') == item.get('heading_path')
                    and prev.get('slide_key') == item.get('slide_key')
                    and int(item.get('chunk_order') or 0) == int(prev.get('chunk_order') or 0) + 1
                ):
                    prev['text'] = self._append_unique_text(prev.get('text', ''), item.get('text', ''))
                    prev['chunk_order'] = item.get('chunk_order', prev.get('chunk_order'))
                    prev['dense_score'] = max(prev.get('dense_score') or 0.0, item.get('dense_score') or 0.0)
                    if item.get('rerank_score') is not None:
                        current_rerank = prev.get('rerank_score')
                        prev['rerank_score'] = max(current_rerank or float('-inf'), item.get('rerank_score'))
                        prev['score'] = prev['rerank_score']
                    continue
            merged.append(dict(item))
        return merged

    def _build_context(
        self,
        hits: List[Dict[str, Any]],
        max_chars: int,
        context_policy: str = 'auto',
    ) -> str:
        if not hits:
            return ''

        selected_hits = list(hits)
        local_hit_count = sum(1 for item in selected_hits if item.get('section_scope') != 'common')
        if context_policy == 'local_only' and local_hit_count >= 2:
            selected_hits = [item for item in selected_hits if item.get('section_scope') != 'common']

        max_hits = max(1, int(config.settings.rag_final_top_k_per_slide))
        merged_hits = self._merge_context_hits(selected_hits)[:max_hits]
        lines: List[str] = []
        used = 0
        for idx, hit in enumerate(merged_hits, start=1):
            header_parts = [f"[{idx}] source={hit.get('source_file')}"]
            if hit.get('slide_key') and hit.get('slide_key') not in {'__all__', '__common__'}:
                header_parts.append(f"slide={hit.get('slide_key')}")
            if hit.get('section_scope') == 'common':
                header_parts.append('scope=common')
            if hit.get('section_title'):
                header_parts.append(f"section={hit.get('section_title')}")
            if hit.get('page_no') is not None:
                header_parts.append(f"page={hit.get('page_no')}")
            header_parts.append(f"dense={float(hit.get('dense_score') or 0.0):.4f}")
            if hit.get('rerank_score') is not None:
                header_parts.append(f"rerank={float(hit.get('rerank_score')):.4f}")
            prefix = ', '.join(header_parts) + "\n"
            candidate = prefix + (hit.get('text') or '').strip() + "\n"
            if used + len(candidate) > max_chars:
                break
            lines.append(candidate)
            used += len(candidate)
        return "\n".join(lines).strip()

    def query(
        self,
        query_text: str,
        template_id: Optional[str] = None,
        scene: str = 'diagnostic',
        top_k: Optional[int] = None,
        min_score: Optional[float] = None,
        slide_keys: Optional[List[str]] = None,
        section_scopes: Optional[List[str]] = None,
        context_policy: str = 'auto',
    ) -> RetrievalResult:
        result = self._search_hits(
            query_text=query_text,
            template_id=template_id,
            scene=scene,
            slide_keys=slide_keys,
            section_scopes=section_scopes,
            top_k=top_k,
            min_score=min_score,
        )
        result.context = self._build_context(
            result.hits,
            max_chars=config.settings.rag_max_context_chars,
            context_policy=context_policy,
        )
        result.rag_used = bool(result.hits)
        return result

    def _tenant_snapshot(self, tenant_input: TenantInput, max_chars: int = 1800) -> str:
        raw = json.dumps(tenant_input.raw, ensure_ascii=False)
        return raw[:max_chars]

    def _build_generation_tasks(
        self,
        tenant_input: TenantInput,
        template_descriptor: Any,
        focus_options: Optional[List[str]] = None,
    ) -> List[GenerationRetrievalTask]:
        tasks: List[GenerationRetrievalTask] = []
        raw = tenant_input.raw or {}
        focus = [item.strip() for item in (focus_options or []) if (item or "").strip()]

        for slide in getattr(template_descriptor, "slides", []):
            ai_placeholders = [ph for ph in slide.placeholders if getattr(ph, "ai_generate", False)]
            if not ai_placeholders:
                continue

            facts: Dict[str, Any] = {}
            for placeholder in slide.placeholders:
                source = getattr(placeholder, "source", None)
                if not source:
                    continue
                value = self._get_nested_raw(raw, source)
                if value is None:
                    continue
                facts[source] = value

            tasks.append(
                GenerationRetrievalTask(
                    slide_key=slide.slide_key,
                    slide_title=getattr(slide, "title", slide.slide_key),
                    ai_tokens=[placeholder.token for placeholder in ai_placeholders],
                    ai_instructions=[
                        (getattr(placeholder, "ai_instruction", "") or "").strip()
                        for placeholder in ai_placeholders
                        if (getattr(placeholder, "ai_instruction", "") or "").strip()
                    ],
                    facts=facts,
                    focus_options=focus,
                    context_policy=(getattr(slide, "context_policy", "auto") or "auto"),
                )
            )
        return tasks

    @staticmethod
    def _join_context_by_slide(
        context_by_slide: Dict[str, str],
        slide_order: Sequence[str],
    ) -> str:
        if not context_by_slide:
            return ""
        chunks: List[str] = []
        for slide_key in slide_order:
            context = (context_by_slide.get(slide_key) or "").strip()
            if not context:
                continue
            chunks.append(f"## slide={slide_key}\n{context}")
        return "\n\n".join(chunks).strip()

    def _retrieve_task_result(
        self,
        *,
        query_text: str,
        template_id: str,
        slide_key: str,
        scene: str,
        context_policy: str,
    ) -> RetrievalResult:
        start_total = time.perf_counter()
        final_top_k = max(1, int(config.settings.rag_final_top_k_per_slide))
        start_local = time.perf_counter()
        local_result = self._search_hits(
            query_text=query_text,
            template_id=template_id,
            scene=scene,
            slide_keys=[slide_key],
            top_k=final_top_k,
        )
        local_ms = round((time.perf_counter() - start_local) * 1000, 2)
        final_hits = list(local_result.hits)
        seen_chunk_ids = {item.get("chunk_id") for item in final_hits}
        common_hits: List[Dict[str, Any]] = []
        common_result: Optional[RetrievalResult] = None

        need_common = max(0, final_top_k - len(final_hits))
        common_ms = 0.0
        if need_common > 0:
            common_limit = min(max(1, int(config.settings.rag_common_fallback_top_k)), need_common)
            start_common = time.perf_counter()
            common_result = self._search_hits(
                query_text=query_text,
                template_id=template_id,
                scene=scene,
                section_scopes=["common"],
                top_k=common_limit,
            )
            common_ms = round((time.perf_counter() - start_common) * 1000, 2)
            for item in common_result.hits:
                if item.get("chunk_id") in seen_chunk_ids:
                    continue
                common_hits.append(item)
                seen_chunk_ids.add(item.get("chunk_id"))
                if len(common_hits) >= need_common:
                    break
            final_hits.extend(common_hits)

        final_hits = final_hits[:final_top_k]
        start_context = time.perf_counter()
        context = self._build_context(
            final_hits,
            max_chars=max(200, int(config.settings.rag_max_context_chars_per_slide)),
            context_policy=context_policy,
        )
        context_ms = round((time.perf_counter() - start_context) * 1000, 2)
        total_ms = round((time.perf_counter() - start_total) * 1000, 2)
        retrieval_stats = {
            "scene": scene,
            "query_chars": len(_clean_whitespace(query_text)),
            "mode": "slide_local",
            "context_policy": context_policy,
            "top_k": final_top_k,
            "candidate_count": int(local_result.retrieval_stats.get("candidate_count", 0))
            + int((common_result.retrieval_stats or {}).get("candidate_count", 0) if common_result else 0),
            "raw_hits": int(local_result.retrieval_stats.get("raw_hits", 0))
            + int((common_result.retrieval_stats or {}).get("raw_hits", 0) if common_result else 0),
            "dense_kept_hits": int(local_result.retrieval_stats.get("dense_kept_hits", 0))
            + int((common_result.retrieval_stats or {}).get("dense_kept_hits", 0) if common_result else 0),
            "kept_hits": len(final_hits),
            "local_hits": len(local_result.hits),
            "common_fallback_hits": len(common_hits),
            "rerank_enabled": bool(local_result.retrieval_stats.get("rerank_enabled"))
            or bool((common_result.retrieval_stats or {}).get("rerank_enabled") if common_result else False),
            "rerank_degraded_reason": local_result.retrieval_stats.get("rerank_degraded_reason")
            or ((common_result.retrieval_stats or {}).get("rerank_degraded_reason") if common_result else None),
            "top_score": max((item.get("score", 0.0) for item in final_hits), default=0.0),
            "local_search_ms": local_ms,
            "common_search_ms": common_ms,
            "context_build_ms": context_ms,
            "total_ms": total_ms,
        }
        logger.info(
            "RAG slide timing | scene=%s | slide=%s | local=%.2fms | common=%.2fms | context=%.2fms | total=%.2fms | hits=%s",
            scene,
            slide_key,
            local_ms,
            common_ms,
            context_ms,
            total_ms,
            len(final_hits),
        )
        retrieval_trace = self._build_trace_from_hits(final_hits, scene=scene)
        return RetrievalResult(
            rag_used=bool(final_hits),
            context=context,
            retrieval_trace=retrieval_trace,
            hits=final_hits,
            retrieval_stats=retrieval_stats,
        )

    def _retrieve_by_generation_tasks(
        self,
        template_id: str,
        tasks: List[GenerationRetrievalTask],
        session_id: Optional[str] = None,
    ) -> RetrievalResult:
        if not tasks:
            return RetrievalResult(rag_used=False)

        start_total = time.perf_counter()
        context_by_slide: Dict[str, str] = {}
        retrieval_trace: List[Dict[str, Any]] = []
        all_hits: List[Dict[str, Any]] = []
        per_slide_stats: List[Dict[str, Any]] = []
        query_entries: List[Dict[str, Any]] = []
        max_chars_per_slide = max(200, int(config.settings.rag_max_context_chars_per_slide))

        for task in tasks:
            query_text = QueryBuilderV2.build_generation_query(template_id=template_id, task=task)
            query_entries.append(
                {
                    "slide_key": task.slide_key,
                    "query_text": query_text,
                    "query_chars": len(query_text),
                    "query_mode": "compact_text",
                }
            )
            result = self._retrieve_task_result(
                query_text=query_text,
                template_id=template_id,
                slide_key=task.slide_key,
                scene="generate",
                context_policy=task.context_policy,
            )
            slide_context = self._build_context(
                result.hits,
                max_chars=max_chars_per_slide,
                context_policy=task.context_policy,
            )
            if slide_context:
                context_by_slide[task.slide_key] = slide_context

            query_preview = query_text[:220]
            per_slide_stats.append(
                {
                    "slide_key": task.slide_key,
                    "query_chars": len(query_text),
                    **(result.retrieval_stats or {}),
                }
            )

            for trace_item in result.retrieval_trace:
                retrieval_trace.append(
                    {
                        **trace_item,
                        "slide_key": task.slide_key,
                        "query_preview": query_preview,
                    }
                )

            for hit in result.hits:
                all_hits.append({**hit, "slide_key": task.slide_key})

        ordered_keys = [task.slide_key for task in tasks]
        context = self._join_context_by_slide(context_by_slide, ordered_keys)
        retrieval_stats = {
            "mode": "generation_tasks",
            "slides_total": len(tasks),
            "slides_with_hits": len(context_by_slide),
            "per_slide": per_slide_stats,
            "total_ms": round((time.perf_counter() - start_total) * 1000, 2),
        }
        logger.info(
            "RAG generation timing | slides=%s | slides_with_hits=%s | total=%.2fms",
            retrieval_stats["slides_total"],
            retrieval_stats["slides_with_hits"],
            float(retrieval_stats["total_ms"]),
        )
        self._dump_query_markdown(
            session_id=session_id,
            scene="generate",
            template_id=template_id,
            query_entries=query_entries,
        )
        retrieval_result = RetrievalResult(
            rag_used=bool(context_by_slide),
            context=context,
            retrieval_trace=retrieval_trace,
            hits=all_hits,
            context_by_slide=context_by_slide,
            retrieval_stats=retrieval_stats,
        )
        self._dump_retrieval_markdown(
            session_id=session_id,
            scene="generate",
            template_id=template_id,
            retrieval_result=retrieval_result,
        )
        return retrieval_result

    def retrieve_for_generation(
        self,
        tenant_input: TenantInput,
        input_id: str,
        template_id: str,
        focus_options: Optional[List[str]] = None,
        use_rag: bool = True,
        template_descriptor: Optional[Any] = None,
        session_id: Optional[str] = None,
    ) -> RetrievalResult:
        if not use_rag:
            return RetrievalResult(rag_used=False, context="", retrieval_trace=[], hits=[])
        if not self.enabled:
            return RetrievalResult(rag_used=False, context="", retrieval_trace=[], hits=[])

        start_total = time.perf_counter()
        if template_descriptor is not None:
            tasks = self._build_generation_tasks(
                tenant_input=tenant_input,
                template_descriptor=template_descriptor,
                focus_options=focus_options,
            )
            result = self._retrieve_by_generation_tasks(
                template_id=template_id,
                tasks=tasks,
                session_id=session_id,
            )
            logger.info(
                "RAG retrieve_for_generation timing | mode=generation_tasks | total=%.2fms",
                round((time.perf_counter() - start_total) * 1000, 2),
            )
            return result

        focus_text = ",".join(focus_options or [])
        query_text = (
            f"scene=generate\n"
            f"template={template_id}\n"
            f"focus={focus_text}\n"
            f"tenant_snapshot={self._tenant_snapshot(tenant_input)}"
        )
        self._dump_query_markdown(
            session_id=session_id,
            scene="generate",
            template_id=template_id,
            query_entries=[
                {
                    "query_text": query_text,
                    "query_chars": len(query_text),
                    "query_mode": "compact_text",
                }
            ],
        )
        retrieval_result = self.query(
            query_text=query_text,
            template_id=template_id,
            scene="generate",
        )
        self._dump_retrieval_markdown(
            session_id=session_id,
            scene="generate",
            template_id=template_id,
            retrieval_result=retrieval_result,
        )
        logger.info(
            "RAG retrieve_for_generation timing | mode=compact_query | total=%.2fms",
            round((time.perf_counter() - start_total) * 1000, 2),
        )
        return retrieval_result

    def retrieve_for_rewrite(
        self,
        tenant_input: TenantInput,
        input_id: str,
        template_id: str,
        slide_key: str,
        user_prompt: str,
        current_slide_content: Optional[Dict[str, Any]] = None,
        use_rag: bool = True,
        template_descriptor: Optional[Any] = None,
        target_tokens: Optional[List[str]] = None,
        structured_slide_data: Optional[Dict[str, Any]] = None,
        session_id: Optional[str] = None,
    ) -> RetrievalResult:
        if not use_rag:
            return RetrievalResult(rag_used=False, context="", retrieval_trace=[], hits=[])
        if not self.enabled:
            return RetrievalResult(rag_used=False, context="", retrieval_trace=[], hits=[])

        start_total = time.perf_counter()
        if template_descriptor is not None:
            target_slide = next(
                (slide for slide in getattr(template_descriptor, "slides", []) if slide.slide_key == slide_key),
                None,
            )
            if target_slide is None:
                return RetrievalResult(rag_used=False)

            ai_placeholders = [ph for ph in target_slide.placeholders if getattr(ph, "ai_generate", False)]
            if target_tokens:
                requested = set(target_tokens)
                ai_placeholders = [ph for ph in ai_placeholders if ph.token in requested]

            ai_tokens = [ph.token for ph in ai_placeholders]
            ai_instructions = [
                (getattr(ph, "ai_instruction", "") or "").strip()
                for ph in ai_placeholders
                if (getattr(ph, "ai_instruction", "") or "").strip()
            ]

            facts = dict(structured_slide_data or {})
            if not facts:
                raw = tenant_input.raw or {}
                for placeholder in target_slide.placeholders:
                    source = getattr(placeholder, "source", None)
                    if not source:
                        continue
                    value = self._get_nested_raw(raw, source)
                    if value is None:
                        continue
                    facts[source] = value

            task = RewriteRetrievalTask(
                slide_key=slide_key,
                ai_tokens=ai_tokens,
                ai_instructions=ai_instructions,
                user_prompt=user_prompt,
                facts=facts,
                current_slide_content=dict(current_slide_content or {}),
            )
            query_text = QueryBuilderV2.build_rewrite_query(
                template_id=template_id,
                task=task,
            )
            self._dump_query_markdown(
                session_id=session_id,
                scene="rewrite",
                template_id=template_id,
                query_entries=[
                    {
                        "slide_key": slide_key,
                        "query_text": query_text,
                        "query_chars": len(query_text),
                        "query_mode": "compact_text",
                    }
                ],
            )
            result = self._retrieve_task_result(
                query_text=query_text,
                template_id=template_id,
                slide_key=slide_key,
                scene="rewrite",
                context_policy=(getattr(target_slide, "context_policy", "auto") or "auto"),
            )
            context = self._build_context(
                result.hits,
                max_chars=max(200, int(config.settings.rag_max_context_chars_per_slide)),
                context_policy=(getattr(target_slide, "context_policy", "auto") or "auto"),
            )
            context_by_slide = {slide_key: context} if context else {}
            retrieval_stats = {
                "mode": "rewrite_task",
                "slide_key": slide_key,
                "query_chars": len(query_text),
                **(result.retrieval_stats or {}),
            }
            retrieval_trace = [
                {
                    **trace_item,
                    "slide_key": slide_key,
                    "query_preview": query_text[:220],
                }
                for trace_item in result.retrieval_trace
            ]
            hits = [{**hit, "slide_key": slide_key} for hit in result.hits]
            retrieval_result = RetrievalResult(
                rag_used=bool(context),
                context=context,
                retrieval_trace=retrieval_trace,
                hits=hits,
                context_by_slide=context_by_slide,
                retrieval_stats=retrieval_stats,
            )
            self._dump_retrieval_markdown(
                session_id=session_id,
                scene="rewrite",
                template_id=template_id,
                retrieval_result=retrieval_result,
            )
            logger.info(
                "RAG retrieve_for_rewrite timing | mode=rewrite_task | slide=%s | total=%.2fms",
                slide_key,
                round((time.perf_counter() - start_total) * 1000, 2),
            )
            return retrieval_result

        current_text = json.dumps(current_slide_content or {}, ensure_ascii=False)
        query_text = (
            f"scene=rewrite\n"
            f"template={template_id}\n"
            f"slide_key={slide_key}\n"
            f"user_prompt={user_prompt}\n"
            f"current_slide={current_text[:1000]}\n"
            f"tenant_snapshot={self._tenant_snapshot(tenant_input, max_chars=1200)}"
        )
        self._dump_query_markdown(
            session_id=session_id,
            scene="rewrite",
            template_id=template_id,
            query_entries=[
                    {
                        "slide_key": slide_key,
                        "query_text": query_text,
                        "query_chars": len(query_text),
                        "query_mode": "compact_text",
                    }
                ],
            )
        retrieval_result = self.query(
            query_text=query_text,
            template_id=template_id,
            scene="rewrite",
        )
        self._dump_retrieval_markdown(
            session_id=session_id,
            scene="rewrite",
            template_id=template_id,
            retrieval_result=retrieval_result,
        )
        logger.info(
            "RAG retrieve_for_rewrite timing | mode=compact_query | slide=%s | total=%.2fms",
            slide_key,
            round((time.perf_counter() - start_total) * 1000, 2),
        )
        return retrieval_result


_shared_rag_service: Optional[RAGService] = None
_shared_rag_lock = threading.Lock()


def get_rag_service() -> RAGService:
    global _shared_rag_service
    if _shared_rag_service is not None:
        return _shared_rag_service
    with _shared_rag_lock:
        if _shared_rag_service is None:
            _shared_rag_service = RAGService()
    return _shared_rag_service
