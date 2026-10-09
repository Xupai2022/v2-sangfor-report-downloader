"""Inputs API endpoints - Input data management and Excel upload."""

from fastapi import APIRouter, HTTPException, status, UploadFile, File, Form
from fastapi.responses import JSONResponse
from typing import Optional
import logging

from ...services.report_service import ReportService
from ...schemas.responses import SuccessResponse
from ...exceptions import (
    InputNotFoundError,
    FileValidationError,
    DataValidationError,
    MSSAIException
)
from ...modules.excel_handler import ExcelHandler
from ... import config

logger = logging.getLogger(__name__)

router = APIRouter()
service = ReportService()
excel_handler = ExcelHandler(max_size_mb=200, chunk_size=8192)


@router.get(
    "",
    response_model=SuccessResponse,
    summary="List Input Sources",
    description="""
    Retrieve a list of all available input data sources.

    ## Response
    Returns an array of input source metadata including:
    - input_id: Unique identifier
    - description: Input data description
    - file: Source file name
    - metadata: Additional metadata (tenant, period, etc.)

    ## Use Cases
    - Browse available input datasets
    - Select input source for report generation
    - Validate input data exists before generation
    """,
    responses={
        200: {
            "description": "List of available input sources",
            "content": {
                "application/json": {
                    "example": {
                        "data": [
                            {
                                "id": "tenant_acme_2025-12",
                                "file": "tenant_acme_2025-12.json",
                                "description": "ACME Corp Security Data - December 2025",
                                "tenant": "acme",
                                "period": "2025-12"
                            },
                            {
                                "id": "tenant_globex_2025-12",
                                "file": "tenant_globex_2025-12.json",
                                "description": "Globex Security Data - December 2025",
                                "tenant": "globex",
                                "period": "2025-12"
                            }
                        ]
                    }
                }
            }
        }
    }
)
async def list_inputs():
    """List all available input data sources."""
    try:
        inputs = service.list_inputs()
        logger.info(f"Listed {len(inputs)} input sources")
        return SuccessResponse(data=inputs)
    except Exception as e:
        logger.exception(f"Failed to list inputs: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get(
    "/{input_id}",
    response_model=SuccessResponse,
    summary="Get Input Source Details",
    description="""
    Retrieve detailed information about a specific input data source.

    ## Response
    Returns:
    - Metadata (id, description, file, tenant, period)
    - Data preview (sample of the actual input data)
    - Statistics (alerts count, incidents count, vulnerabilities count, etc.)

    ## Use Cases
    - Preview input data before report generation
    - Validate data structure and completeness
    - Understand data content for template selection
    """,
    responses={
        200: {
            "description": "Input source details retrieved successfully",
            "content": {
                "application/json": {
                    "example": {
                        "data": {
                            "id": "tenant_acme_2025-12",
                            "description": "ACME Corp Security Data - December 2025",
                            "file": "tenant_acme_2025-12.json",
                            "metadata": {
                                "tenant": "acme",
                                "period": "2025-12"
                            },
                            "statistics": {
                                "alerts_total": 1234,
                                "incidents_total": 56,
                                "vulnerabilities_total": 789
                            },
                            "preview": {
                                "alerts": {"total": 1234, "critical": 23},
                                "incidents": {"total": 56, "high": 12}
                            }
                        }
                    }
                }
            }
        },
        404: {"description": "Input source not found"}
    }
)
async def get_input(input_id: str):
    """Get detailed information about a specific input source."""
    try:
        # Get input metadata from catalog
        inputs = service.list_inputs()
        input_meta = next((i for i in inputs if i.get("id") == input_id), None)

        if not input_meta:
            raise InputNotFoundError(f"Input source '{input_id}' not found")

        # Load actual input data
        input_data = service.input_repo.load(input_id)

        # Build response with metadata and preview
        response_data = {
            "id": input_id,
            "description": input_meta.get("description"),
            "file": input_meta.get("file"),
            "metadata": {
                k: v for k, v in input_meta.items()
                if k not in ["id", "file", "description"]
            }
        }

        # Add data preview (first level of data structure)
        if input_data and hasattr(input_data, 'raw_data'):
            preview = {}
            for key, value in input_data.raw_data.items():
                if isinstance(value, dict):
                    # Show dict keys
                    preview[key] = {k: "..." for k in list(value.keys())[:5]}
                elif isinstance(value, list):
                    # Show list length
                    preview[key] = f"[{len(value)} items]"
                else:
                    # Show scalar values
                    preview[key] = value
            response_data["preview"] = preview

            # Add statistics if available
            stats = {}
            if "alerts" in input_data.raw_data and isinstance(input_data.raw_data["alerts"], dict):
                if "total" in input_data.raw_data["alerts"]:
                    stats["alerts_total"] = input_data.raw_data["alerts"]["total"]
            if "incidents" in input_data.raw_data and isinstance(input_data.raw_data["incidents"], dict):
                if "total" in input_data.raw_data["incidents"]:
                    stats["incidents_total"] = input_data.raw_data["incidents"]["total"]
            if "vulnerabilities" in input_data.raw_data and isinstance(input_data.raw_data["vulnerabilities"], dict):
                if "total" in input_data.raw_data["vulnerabilities"]:
                    stats["vulnerabilities_total"] = input_data.raw_data["vulnerabilities"]["total"]

            if stats:
                response_data["statistics"] = stats

        logger.info(f"Retrieved input details: {input_id}")
        return SuccessResponse(data=response_data)

    except InputNotFoundError as e:
        logger.error(f"Input not found: {e}")
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception(f"Failed to get input details: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post(
    "/excel",
    status_code=status.HTTP_201_CREATED,
    summary="Upload Excel File",
    description="""
    Upload an Excel file (.xlsx) and parse it to JSON format for report generation.

    ## Security Features
    - Only accepts .xlsx format (no macros)
    - File size limit: 200MB
    - MIME type validation
    - Session isolation storage

    ## Processing Flow
    1. Validate file format and size
    2. Parse Excel to JSON structure
    3. Create isolated session directory
    4. Save both Excel file and parsed JSON

    ## Response
    Returns:
    - session_id: Unique session identifier for report generation
    - filename: Original uploaded filename
    - preview: Sample of parsed data
    - files: Saved file paths (excel, json)
    - next_steps: Instructions for using the session_id

    ## Next Steps
    Use the returned `session_id` with POST /api/v1/reports to generate a report.
    """,
    responses={
        201: {
            "description": "Excel file uploaded and parsed successfully",
            "content": {
                "application/json": {
                    "example": {
                        "data": {
                            "session_id": "session_1769760502379_rh3o0q4ja",
                            "filename": "security_data.xlsx",
                            "sheet_count": 3,
                            "row_count": 150,
                            "preview": {
                                "alerts": {"total": 1234},
                                "incidents": {"total": 56}
                            },
                            "files": {
                                "excel": "uploaded.xlsx",
                                "json": "input.json"
                            },
                            "next_steps": {
                                "description": "Use this session_id to call POST /api/v1/reports",
                                "example_request": {
                                    "method": "POST",
                                    "endpoint": "/api/v1/reports",
                                    "body": {
                                        "input_id": "custom",
                                        "template_id": "mss_classic_ops",
                                        "session_id": "session_1769760502379_rh3o0q4ja",
                                        "use_rag": True,
                                        "focus_options": ["vulnerability"]
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        400: {
            "description": "Invalid file format or validation error",
            "content": {
                "application/json": {
                    "example": {
                        "error": {
                            "code": "FILE_VALIDATION_ERROR",
                            "message": "Invalid file format. Only .xlsx files are allowed.",
                            "details": {"allowed_extensions": [".xlsx"]}
                        }
                    }
                }
            }
        }
    }
)
async def upload_excel(
    file: UploadFile = File(...),
    template_id: Optional[str] = Form(None),
):
    """Upload Excel file and parse to JSON."""
    logger.info(
        "📥 Upload request: filename=%s, content_type=%s, template_id=%s",
        file.filename,
        file.content_type,
        template_id,
    )

    try:
        # Generate session
        session_id = service.session_manager.generate_session_id()
        session_dir = config.SESSIONS_DIR / session_id

        # Read file content
        file_content = await file.read()

        # Process upload using ExcelHandler
        input_data = await excel_handler.process_upload(
            file_content=file_content,
            filename=file.filename,
            content_type=file.content_type,
            session_dir=session_dir,
            template_id=template_id,
        )

        # Generate response with file info
        file_info = excel_handler.get_file_info(input_data, len(file_content))

        response_data = {
            "session_id": session_id,
            "filename": file.filename,
            **file_info,
            "files": {
                "excel": "uploaded.xlsx",
                "json": "input.json"
            },
            "next_steps": {
                "description": "Use this session_id to call POST /api/v1/reports",
                "example_request": {
                    "method": "POST",
                    "endpoint": "/api/v1/reports",
                    "body": {
                        "input_id": "custom",
                        "template_id": "mss_classic_ops",
                        "session_id": session_id,
                        "use_rag": True,
                        "focus_options": ["vulnerability"]
                    }
                }
            }
        }

        logger.info(f"Excel uploaded successfully: session_id={session_id}")
        return SuccessResponse(data=response_data)

    except FileValidationError as e:
        logger.error(f"File validation error: {e}")
        raise HTTPException(status_code=400, detail=e.to_dict())
    except DataValidationError as e:
        logger.error(f"Data validation error: {e}")
        raise HTTPException(status_code=400, detail=e.to_dict())
    except MSSAIException as e:
        logger.error(f"Excel upload error: {e}")
        raise HTTPException(status_code=500, detail=e.to_dict())
    except Exception as e:
        logger.exception("Unexpected error during Excel upload")
        raise HTTPException(status_code=500, detail={
            "error": "INTERNAL_ERROR",
            "message": f"服务器内部错误: {str(e)}"
        })
