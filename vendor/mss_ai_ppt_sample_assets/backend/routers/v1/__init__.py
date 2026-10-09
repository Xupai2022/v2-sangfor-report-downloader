"""V1 API routers."""

from fastapi import APIRouter
from .reports import router as reports_router
from .templates import router as templates_router
from .inputs import router as inputs_router
from .sessions import router as sessions_router
from .system import router as system_router
from .jobs import router as jobs_router
from .admin import router as admin_router
from .ratings import router as ratings_router
from .rag import router as rag_router

# Create v1 router with prefix
v1_router = APIRouter(prefix="/api/v1")

# Register all sub-routers
v1_router.include_router(reports_router, prefix="/reports", tags=["Reports"])
v1_router.include_router(templates_router, prefix="/templates", tags=["Templates"])
v1_router.include_router(inputs_router, prefix="/inputs", tags=["Inputs"])
v1_router.include_router(sessions_router, prefix="/sessions", tags=["Sessions"])
v1_router.include_router(system_router, prefix="/system", tags=["System"])
v1_router.include_router(jobs_router, prefix="/jobs", tags=["Jobs"])
v1_router.include_router(admin_router, prefix="/admin", tags=["Admin"])
v1_router.include_router(ratings_router, prefix="/ratings", tags=["Ratings"])
v1_router.include_router(rag_router, prefix="/rag", tags=["RAG"])

__all__ = ["v1_router"]
