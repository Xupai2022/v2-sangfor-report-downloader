from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field, field_validator


class MongoCollectionConfig(BaseModel):
    """Mongo collection names used by the SOAR data collector."""

    database_name: str = Field(..., description="Mongo database name")
    alarm_collection: str = Field(..., description="Alarm collection name")
    event_collection: str = Field(..., description="Event collection name")
    asset_collection: str = Field(..., description="Asset collection name")
    business_collection: str = Field(..., description="Business collection name，与asset关联")


class MongoIngestionRequest(BaseModel):
    """Minimal query contract for extracting raw alarm/event data."""

    company_id: str = Field(..., description="Tenant company identifier")
    start_time: datetime = Field(..., description="Inclusive range start")
    end_time: datetime = Field(..., description="Inclusive range end")

    @field_validator("company_id")
    @classmethod
    def validate_company_id(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("company_id must not be empty")
        return value

    @field_validator("end_time")
    @classmethod
    def validate_time_range(cls, value: datetime, info) -> datetime:
        start_time = info.data.get("start_time")
        if start_time and value < start_time:
            raise ValueError("end_time must be greater than or equal to start_time")
        return value
