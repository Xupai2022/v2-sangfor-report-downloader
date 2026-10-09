"""RAG management and diagnostic endpoints."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from ...schemas.requests import (
    RAGBuildIndexRequest,
    RAGUpdateIndexRequest,
    RAGQueryRequest,
)
from ...schemas.responses import SuccessResponse
from ...services.rag_service import get_rag_service

logger = logging.getLogger(__name__)

router = APIRouter()
service = get_rag_service()


@router.post(
    "/index/build",
    response_model=SuccessResponse,
    summary="Build RAG Index",
    description="Build or rebuild the RAG vector index from a batch document directory.",
)
async def build_index(req: RAGBuildIndexRequest):
    try:
        result = service.build_index(
            source_dir=req.source_dir,
            template_id=req.template_id,
            reset_collection=req.reset_collection,
        )
        return SuccessResponse(data=result)
    except ValueError as e:
        logger.error("RAG build request invalid: %s", e)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("RAG build failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post(
    "/index/update",
    response_model=SuccessResponse,
    summary="Update RAG Index",
    description="Incrementally update the RAG vector index from a document directory.",
)
async def update_index(req: RAGUpdateIndexRequest):
    try:
        result = service.update_index(
            source_dir=req.source_dir,
            template_id=req.template_id,
        )
        return SuccessResponse(data=result)
    except ValueError as e:
        logger.error("RAG update request invalid: %s", e)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("RAG update failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get(
    "/index/status",
    response_model=SuccessResponse,
    summary="Get RAG Index Status",
    description="Get current RAG configuration and index statistics.",
)
async def get_index_status():
    try:
        result = service.get_status()
        return SuccessResponse(data=result)
    except Exception as e:
        logger.exception("RAG status check failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post(
    "/query",
    response_model=SuccessResponse,
    summary="RAG Diagnostic Query",
    description="Run retrieval-only query against knowledge index without calling LLM.",
)
async def rag_query(req: RAGQueryRequest):
    try:
        result = service.query(
            query_text=req.query_text,
            template_id=req.template_id,
            scene=req.scene,
            top_k=req.top_k,
        )
        return SuccessResponse(
            data={
                "rag_used": result.rag_used,
                "context": result.context,
                "retrieval_trace": result.retrieval_trace,
                "hits": result.hits,
            }
        )
    except ValueError as e:
        logger.error("RAG query request invalid: %s", e)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("RAG query failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
