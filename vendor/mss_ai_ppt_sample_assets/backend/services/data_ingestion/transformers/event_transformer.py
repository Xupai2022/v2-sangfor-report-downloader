from __future__ import annotations

from datetime import datetime
from typing import Any

LATEST_THREAT_TYPE = "最新威胁"
RECOGNITION_DURATION_FIELD = "识别时长"
ACCESS_DURATION_FIELD = "访问时长"
CONTAINMENT_DURATION_FIELD = "遏制时间"
DISPOSAL_DURATION_FIELD = "处置时长"
CLOSED_LOOP_DURATION_FIELD = "闭环时长"


def enrich_event_docs(event_docs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Append derived event features needed by downstream processing."""
    return [enrich_event_doc(event_doc) for event_doc in event_docs]


def enrich_event_doc(event_doc: dict[str, Any]) -> dict[str, Any]:
    enriched = dict(event_doc)
    enriched[RECOGNITION_DURATION_FIELD] = _calc_recognition_duration_minutes(event_doc)
    enriched[ACCESS_DURATION_FIELD] = _calc_access_duration_minutes(event_doc)
    enriched[CONTAINMENT_DURATION_FIELD] = _calc_containment_duration_minutes(event_doc)
    enriched[DISPOSAL_DURATION_FIELD] = _calc_disposal_duration_minutes(event_doc)
    enriched[CLOSED_LOOP_DURATION_FIELD] = _calc_closed_loop_duration_minutes(event_doc)
    return enriched


def _calc_recognition_duration_minutes(event_doc: dict[str, Any]) -> float | str:
    if _is_latest_threat(event_doc.get("event_grading_tag")):
        return ""

    create_time = event_doc.get("create_time")
    checkout_time = event_doc.get("checkout_time")
    if not isinstance(create_time, datetime) or not isinstance(checkout_time, datetime):
        return ""

    duration_minutes = (create_time - checkout_time).total_seconds() / 60
    return round(duration_minutes, 2)


def _calc_access_duration_minutes(event_doc: dict[str, Any]) -> float | str:
    if _is_latest_threat(event_doc.get("event_grading_tag")):
        return ""

    create_time = event_doc.get("create_time")
    access_time = _pick_first_datetime(
        event_doc.get("wechat_push_time"),
        event_doc.get("dispose_time"),
        event_doc.get("latest_time"),
    )
    if not isinstance(create_time, datetime) or access_time is None:
        return ""

    duration_minutes = (access_time - create_time).total_seconds() / 60
    return round(duration_minutes, 2)


def _calc_containment_duration_minutes(event_doc: dict[str, Any]) -> float | str:
    if _is_latest_threat(event_doc.get("event_grading_tag")):
        return ""

    create_time = event_doc.get("create_time")
    wechat_push_time = event_doc.get("wechat_push_time")
    if not isinstance(create_time, datetime) or not isinstance(wechat_push_time, datetime):
        return ""

    duration_minutes = (wechat_push_time - create_time).total_seconds() / 60
    return round(duration_minutes, 2)


def _calc_disposal_duration_minutes(event_doc: dict[str, Any]) -> float | str:
    if _is_latest_threat(event_doc.get("event_grading_tag")):
        return ""

    create_time = event_doc.get("create_time")
    disposal_time = _pick_first_datetime(
        event_doc.get("contain_time"),
        event_doc.get("latest_time"),
    )
    if not isinstance(create_time, datetime) or disposal_time is None:
        return ""

    duration_minutes = (disposal_time - create_time).total_seconds() / 60
    return round(duration_minutes, 2)


def _calc_closed_loop_duration_minutes(event_doc: dict[str, Any]) -> float | str:
    if _is_latest_threat(event_doc.get("event_grading_tag")):
        return ""

    create_time = event_doc.get("create_time")
    closed_loop_time = _pick_first_datetime(
        event_doc.get("finished_time"),
        event_doc.get("latest_time"),
    )
    if not isinstance(create_time, datetime) or closed_loop_time is None:
        return ""

    duration_minutes = (closed_loop_time - create_time).total_seconds() / 60
    return round(duration_minutes, 2)


def _is_latest_threat(event_grading_tag: Any) -> bool:
    if not isinstance(event_grading_tag, str):
        return False
    return LATEST_THREAT_TYPE in event_grading_tag


def _pick_first_datetime(*values: Any) -> datetime | None:
    for value in values:
        if isinstance(value, datetime):
            return value
    return None
