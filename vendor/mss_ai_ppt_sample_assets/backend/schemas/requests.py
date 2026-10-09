"""Unified request models for API endpoints."""

from pydantic import BaseModel, Field, validator
from typing import Optional, List, Dict, Any, Literal, ClassVar, Set


class CreateReportRequest(BaseModel):
    """Request model for creating a new report."""
    ALLOWED_FOCUS_OPTIONS: ClassVar[Set[str]] = {
        "vulnerability",
        "alert",
        "business_protection",
    }
    # Accept common aliases (Chinese/English/display text)
    # and normalize everything to stable internal keys above.
    FOCUS_OPTION_ALIASES: ClassVar[Dict[str, str]] = {
        "vulnerability": "vulnerability",
        "alert": "alert",
        "business_protection": "business_protection",
        "漏洞优先": "vulnerability",
        "告警优先": "alert",
        "业务保护": "business_protection",
        "vulnerability priority": "vulnerability",
        "alert priority": "alert",
        "business protection": "business_protection",
        "vulnerability focus": "vulnerability",
        "alert focus": "alert",
    }

    input_id: str = Field(..., description="Input data ID", example="tenant_acme_2025-11")
    template_id: str = Field(..., description="Template ID", example="mss_executive_v2")
    use_mock: bool = Field(False, description="Use mock mode (skip AI generation)")
    use_rag: bool = Field(True, description="Enable RAG retrieval for this request")
    focus_options: List[str] = Field(
        ...,
        min_items=1,
        description=(
            "Required report focus options (supports multi-select). "
            "Each item can be either option key "
            "('vulnerability'/'alert'/'business_protection') "
            "or a preference title ('漏洞优先'/'告警优先'/'业务保护')."
        ),
    )
    session_id: Optional[str] = Field(None, description="Optional session ID")
    client_id: Optional[str] = Field(None, description="Optional WebSocket client ID")
    idempotency_key: Optional[str] = Field(
        None,
        description="Idempotency key to prevent duplicate processing of the same request"
    )
    force_new_task: bool = Field(
        False,
        description="Force create a brand-new task and supersede any currently running browser task"
    )

    class Config:
        json_schema_extra = {
            "example": {
                "input_id": "tenant_acme_2025-11",
                "template_id": "mss_executive_v2",
                "use_mock": False,
                "use_rag": True,
                "focus_options": ["vulnerability", "alert"],
                "idempotency_key": "user123-request456"
            }
        }

    @validator("focus_options", pre=True)
    def validate_focus_options(cls, v):
        """Normalize focus options list (trim, dedupe, drop empty)."""
        if v is None:
            raise ValueError("focus_options is required and must contain at least one option")
        if not isinstance(v, list):
            raise ValueError("focus_options must be a list of strings")

        normalized: List[str] = []
        seen = set()
        for item in v:
            if not isinstance(item, str):
                raise ValueError("focus_options must contain only strings")
            option = item.strip()
            if not option or option in seen:
                continue
            canonical = cls.FOCUS_OPTION_ALIASES.get(option)
            if canonical is None:
                canonical = cls.FOCUS_OPTION_ALIASES.get(option.lower())
            if canonical in cls.ALLOWED_FOCUS_OPTIONS:
                if canonical in seen:
                    continue
                seen.add(canonical)
                normalized.append(canonical)
            else:
                raise ValueError(f"Unsupported focus option: {option}")
        if not normalized:
            raise ValueError("focus_options must contain at least one valid option")
        return normalized

class SlideUpdate(BaseModel):
    """Single slide update information."""
    slide_key: str = Field(..., description="Slide identifier", example="cover")
    new_content: Dict[str, Any] = Field(..., description="New content for placeholders")

    class Config:
        json_schema_extra = {
            "example": {
                "slide_key": "cover",
                "new_content": {
                    "TITLE": "Updated Title",
                    "SUBTITLE": "New Subtitle"
                }
            }
        }


class UpdateSlidesRequest(BaseModel):
    """Request model for batch updating slides."""
    slides: List[SlideUpdate] = Field(..., description="List of slide updates")
    client_id: Optional[str] = Field(None, description="Optional WebSocket client ID")

    class Config:
        json_schema_extra = {
            "example": {
                "slides": [
                    {
                        "slide_key": "cover",
                        "new_content": {"TITLE": "Updated Title"}
                    },
                    {
                        "slide_key": "summary",
                        "new_content": {"SUMMARY_TEXT": "New summary"}
                    }
                ]
            }
        }


class AISlideRewriteRequest(BaseModel):
    """Request model for AI rewrite of a single slide."""
    slide_key: str = Field(..., description="Slide identifier", example="summary")
    user_prompt: str = Field(
        ...,
        min_length=1,
        max_length=2000,
        description="User preference/instruction for AI rewrite of the selected slide"
    )
    target_tokens: Optional[List[str]] = Field(
        None,
        description=(
            "Optional AI placeholder tokens to rewrite. "
            "If omitted or empty, backend rewrites all ai_generate=true tokens on the slide."
        ),
    )
    use_rag: bool = Field(
        True,
        description="Deprecated for AI rewrite. Kept for compatibility and ignored by backend."
    )
    client_id: Optional[str] = Field(None, description="Optional WebSocket client ID")

    @validator("user_prompt")
    def validate_user_prompt(cls, v: str):
        """Validate user prompt is not empty after trimming."""
        if not v or not v.strip():
            raise ValueError("user_prompt cannot be empty")
        return v.strip()

    @validator("target_tokens", pre=True)
    def validate_target_tokens(cls, v):
        """Normalize target token list (trim, dedupe, drop empty)."""
        if v is None:
            return None
        if not isinstance(v, list):
            raise ValueError("target_tokens must be a list of strings")

        normalized: List[str] = []
        seen = set()
        for item in v:
            if not isinstance(item, str):
                raise ValueError("target_tokens must contain only strings")
            token = item.strip()
            if not token or token in seen:
                continue
            seen.add(token)
            normalized.append(token)
        return normalized

    class Config:
        json_schema_extra = {
            "example": {
                "slide_key": "summary",
                "user_prompt": "请聚焦本月高风险告警的业务影响，语气偏管理层，并给出三条可执行建议。",
                "target_tokens": ["business_continuity_assurance_conclusion", "user_trust_assurance_conclusion"],
                "use_rag": True
            }
        }


class RAGBuildIndexRequest(BaseModel):
    """Request model for full RAG index build."""
    source_dir: Optional[str] = Field(None, description="Source directory containing documents")
    template_id: Optional[str] = Field(None, description="Optional template identifier")
    reset_collection: bool = Field(True, description="Recreate collection before indexing")


class RAGUpdateIndexRequest(BaseModel):
    """Request model for incremental RAG index update."""
    source_dir: Optional[str] = Field(None, description="Source directory containing documents")
    template_id: Optional[str] = Field(None, description="Optional template identifier")


class RAGQueryRequest(BaseModel):
    """Diagnostic RAG query request."""
    query_text: str = Field(..., min_length=1, description="Search query text")
    template_id: Optional[str] = Field(None, description="Optional template identifier for metadata filter")
    scene: Literal["diagnostic", "generate", "rewrite"] = Field("diagnostic", description="Query scene")
    top_k: Optional[int] = Field(None, ge=1, le=50, description="Number of retrieval results")

class SubmitRatingRequest(BaseModel):
    """User rating submission request."""
    rating: Literal["liked", "disliked"] = Field(
        ...,
        description="Rating value: 'liked' (thumbs up) or 'disliked' (thumbs down)"
    )
    comment: Optional[str] = Field(
        None,
        max_length=500,
        description="Comment explaining the rating (required for disliked)"
    )

    @validator('comment')
    def validate_comment_for_disliked(cls, v, values):
        """Validate that disliked ratings have a comment."""
        rating = values.get('rating')
        if rating == 'disliked':
            if not v or len(v.strip()) < 10:
                raise ValueError('Comment is required for thumbs down (minimum 10 characters)')
        return v

    class Config:
        json_schema_extra = {
            "example": {
                "rating": "disliked",
                "comment": "The chart colors are hard to read and data formatting needs improvement."
            }
        }

