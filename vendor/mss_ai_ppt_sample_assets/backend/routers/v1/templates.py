"""Templates API endpoints - Template catalog and metadata retrieval."""

from fastapi import APIRouter, HTTPException
from typing import Optional
import logging

from ...services.report_service import ReportService
from ...schemas.responses import SuccessResponse
from ...modules import TemplateNotFoundError

logger = logging.getLogger(__name__)

router = APIRouter()
service = ReportService()


@router.get(
    "",
    response_model=SuccessResponse,
    summary="List Templates",
    description="""
    Retrieve a list of all available report templates.

    ## Filtering Options
    - `audience`: Filter by target audience (e.g., "management", "technical")
    - `language`: Filter by template language (e.g., "zh-CN", "en-US")

    ## Response
    Returns an array of template metadata including:
    - template_id: Unique identifier
    - name: Display name
    - version: Template version (e.g., "v2")
    - audience: Target audience
    - language: Template language
    - slides_count: Number of slides
    - description: Template description
    """,
    responses={
        200: {
            "description": "List of available templates",
            "content": {
                "application/json": {
                    "example": {
                        "data": [
                            {
                                "template_id": "mss_executive_v2",
                                "name": "MSS Executive Report V2",
                                "version": "v2",
                                "audience": "management",
                                "language": "zh-CN",
                                "slides_count": 8,
                                "description": "Management-oriented security report"
                            },
                            {
                                "template_id": "mss_technical_v2",
                                "name": "MSS Technical Report V2",
                                "version": "v2",
                                "audience": "technical",
                                "language": "zh-CN",
                                "slides_count": 10,
                                "description": "Technical security analysis report"
                            }
                        ]
                    }
                }
            }
        }
    }
)
async def list_templates(
    audience: Optional[str] = None,
    language: Optional[str] = None
):
    """List all available templates with optional filtering."""
    try:
        templates = service.template_repo.list_templates()

        # Apply filters if provided
        if audience:
            templates = [t for t in templates if t.get("audience") == audience]
        if language:
            templates = [t for t in templates if t.get("language") == language]

        logger.info(f"Listed {len(templates)} templates (audience={audience}, language={language})")
        return SuccessResponse(data=templates)
    except Exception as e:
        logger.exception(f"Failed to list templates: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get(
    "/{template_id}/slides",
    response_model=SuccessResponse,
    summary="Get Template Slides",
    description="Return slide metadata (slide_no, slide_key, title) for a template."
)
async def get_template_slides(template_id: str):
    """Get slide metadata for a specific template."""
    try:
        descriptor = service.template_repo.get_descriptor_v2(template_id)
        slides = [
            {
                "slide_no": s.slide_no,
                "slide_key": s.slide_key,
                "title": s.title,
                "ai_rewrite_tokens": [ph.token for ph in s.placeholders if ph.ai_generate],
                "placeholder_cn_names": {
                    ph.token: ph.cn_name for ph in s.placeholders if ph.cn_name
                },
            }
            for s in descriptor.slides
        ]
        return SuccessResponse(data=slides)
    except TemplateNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception(f"Failed to get template slides: {e}")
        raise HTTPException(status_code=500, detail=str(e))
