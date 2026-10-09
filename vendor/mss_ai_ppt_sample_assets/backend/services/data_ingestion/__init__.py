"""Data ingestion package for non-Excel source collection."""

from .models import MongoCollectionConfig, MongoIngestionRequest

__all__ = ["MongoCollectionConfig", "MongoIngestionRequest"]
