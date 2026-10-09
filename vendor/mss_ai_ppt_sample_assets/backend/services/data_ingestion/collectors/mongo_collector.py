from __future__ import annotations

from datetime import datetime
import json
import logging
from pathlib import Path
from typing import Any, Dict

from pymongo import MongoClient

from .... import config
from ..models import MongoCollectionConfig, MongoIngestionRequest
from ..transformers import enrich_event_docs

logger = logging.getLogger(__name__)
_EVENT_MANAGE_SUB_TYPE_DISPLAY: Dict[str, str] | None = None

ALARM_EVENT_STATUS_DISPLAY: Dict[str, str] = {
    "inited": "未处置",
    "finished": "已完成",
    "reject_ignore": "已忽略（驳回）",
    "rejected": "已驳回",
    "disposal": "处置中",
    "link_event": "已关联告警",
    "relate_event": "生成事件",
    "ignore": "已忽略",
    "white": "已加白",
    "auto_event": "生成事件（自动）",
    "auto_ignore": "已忽略（自动）",
}

ATTACK_STATE_DISPLAY: Dict[int, str] = {
    0: "judge（待研判）",
    1: "fail（失败）",
    2: "succ（成功）",
    3: "compromised（失陷）",
    4: "anomaly（异常）",
    5: "attempt（尝试）",
}

ATTACK_DIRECTION_DISPLAY: Dict[int, str] = {
    0: "未知",
    1: "内-外",
    2: "外-内",
    3: "内-内",
    4: "外-外",
}

ALARM_SERVICE_STATUS_DISPLAY: Dict[int, str] = {
    0: "服务内（7*24H）",
    1: "服务外",
    3: "服务内（5*8H）",
    -1: "全部服务",
}

PUSH_STATUS_DISPLAY: Dict[int, str] = {
    1: "已通告",
    -1: "未通告",
}

REJECT_REASON_DISPLAY: Dict[str, str] = {
    "1": "业务触发",
    "2": "技术误报",
    "3": "接受风险",
    "4": "误推送",
    "5": "正报延迟",
}

EVENT_EVENT_STATUS_DISPLAY: Dict[str, str] = {
    "inited": "未处置",
    "disposal": "处置中",
    "suspend": "已暂停",
    "finished": "已完成",
    "accept_risk": "接受风险",
    "protected": "已防护",
    "announced": "已通告",
    "rejected": "已驳回",
}

EVENT_SERVICE_STATUS_DISPLAY: Dict[int, str] = {
    0: "服务内（7*24H）",
    1: "服务外",
    3: "服务内（5*8H）",
    -1: "全部服务",
}

ASSET_TYPE_DISPLAY: Dict[str, str] = {
    "server": "服务器",
    "safety_equipment": "安全设备",
    "net_equipment": "网络设备",
    "endpoint": "终端",
    "iot_equipment": "物联网设备",
    "unknown": "其他/未知",
    "firewall": "防火墙",
    "VPN": "VPN",
    "WAF": "WAF",
    "IDPS": "IDPS",
    "honeypot": "蜜罐",
    "scanner": "扫描器",
    "DNS": "DNS",
    "proxy_server": "代理服务器",
    "fortress_machine": "堡垒机",
}

ASSET_SERVICE_STATUS_DISPLAY: Dict[int, str] = {
    1: "服务内 7×24",
    3: "服务内 5×8",
    0: "服务外",
}

ASSET_LEVEL_DISPLAY: Dict[str, str] = {
    "1": "核心",
    "2": "重要",
    "3": "一般",
}

EVENT_GRADING_TAG_DISPLAY: Dict[int, str] = {
    0: "重大事件",
    1: "重要事件",
    2: "一般事件",
    3: "重要威胁",
    4: "一般威胁",
    5: "其他",
}

EVENT_MANAGE_TYPE_DISPLAY: Dict[str, str] = {
    "INTRANET_THREAT": "内部威胁",
    "MANAGEMENT": "管理要求",
    "ACTIVE_INVOLVEMENT": "主动投入",
    "SERVICE_SPREAD": "服务蔓延",
    "UNDECLARED_THREAT": "未公开威胁",
    "INTERNET_THREAT": "外部威胁",
    "VULNERABILITY": "脆弱性",
    "CUSTOMER_FEEDBACK": "用户反馈",
    "STRATEGY_OPTIMIZE": "策略调优",
    "EMERGENCY_RESPONSE": "应急工单",
    "STRATEGY_SERVICE": "策略工单",
    "OTHER": "其他",
    "CONSULTANT": "咨询问题",
    "PRODUCTION": "产品问题",
    "94": "脆弱性风险",
    "214": "访问风险",
    "201": "服务探测",
    "215": "主机探测",
    "90": "网站攻击",
    "203": "后门通信",
    "204": "账号爆破",
    "205": "攻击利用",
    "96": "邮件攻击",
    "10": "Dos攻击",
    "207": "黑链",
    "30": "漏洞攻击",
    "208": "黑客工具",
    "213": "数据库攻击利用",
    "40": "访问恶意文件",
    "209": "感染病毒",
    "212": "行为异常",
    "216": "流量异常",
    "217": "登录异常",
    "218": "终端行为异常",
    "219": "容器异常",
}

ALARM_PROJECTION: Dict[str, int] = {
    "alarm_name": 1,
    "asset": 1,
    "manage_type_name": 1,
    "manage_sub_type_name": 1,
    "event_status": 1,
    "first_time": 1,
    "latest_time": 1,
    "service_status": 1,
    "create_time": 1,
    "attack_state": 1,
    "attack_direction": 1,
    "current_operate_time": 1,
    "rejected_event_id": 1,
    "current_operator": 1,
    "reject_reason": 1,
    "_id": 0,
}

EVENT_PROJECTION: Dict[str, int] = {
    "create_time": 1,
    "manage_type": 1,
    "manage_sub_type": 1,
    "event_grading_tag": 1,
    "host_ip": 1,
    "event_status": 1,
    "service_status": 1,
    "latest_time": 1,
    "checkout_time": 1,
    "dispose_time": 1,
    "contain_time": 1,
    "finished_time": 1,
    "incidence": 1,
    "update_protected_time": 1,
    "update_announced_time": 1,
    "update_accept_risk_time": 1,
    "push_status": 1,
    "wechat_push_time": 1,
    "_id": 0,
}

ALARM_OUTPUT_FIELDS = (
    "alarm_name",
    "asset",
    "type",
    "event_status",
    "first_time",
    "latest_time",
    "service_status",
    "create_time",
    "attack_state",
    "attack_direction",
    "current_operate_time",
    "rejected_event_id",
    "current_operator",
    "reject_reason",
)
EVENT_OUTPUT_FIELDS = (
    "event_grading_tag", 
    "create_time",
    "type",
    "host_ip",
    "内网外网资产",
    "event_status",
    "service_status",
    "latest_time",
    "checkout_time",
    "dispose_time",
    "contain_time",
    "finished_time",
    "incidence",
    "update_protected_time",
    "update_announced_time",
    "update_accept_risk_time",
    "push_status",
    "wechat_push_time",
)
ASSET_OUTPUT_FIELDS = (
    "business_name",
    "asset",
    "level",
    "is_service",
    "asset_type",
    "security_domain",
)


class SOARMongoCollector:
    """Collect raw alarm/event documents from the SOAR MongoDB source."""

    def __init__(
        self,
        mongo_uri: str | None = None,
        collections: MongoCollectionConfig | None = None,
        connect_timeout_ms: int | None = None,
    ) -> None:
        self.mongo_uri = (mongo_uri or config.settings.soar_mongo_uri or "").strip()
        if not self.mongo_uri:
            raise ValueError(
                "SOAR MongoDB connection is not configured. "
                "Set SOAR_MONGO_URI or the split SOAR_MONGO_* environment variables."
            )
        self.collections = collections or MongoCollectionConfig(
            database_name=config.settings.soar_mongo_database,
            alarm_collection=config.settings.soar_mongo_alarm_collection,
            event_collection=config.settings.soar_mongo_event_collection,
            asset_collection=config.settings.soar_mongo_asset_collection,
            business_collection=config.settings.soar_mongo_business_collection,
        )
        self.connect_timeout_ms = int(
            connect_timeout_ms or config.settings.soar_mongo_connect_timeout_ms
        )
        self.asset_batch_size = max(1, int(config.settings.soar_mongo_asset_batch_size))

    def collect(self, request: MongoIngestionRequest) -> Dict[str, Any]:
        query = {
            "company_id": request.company_id,
            "create_time": {
                "$gte": request.start_time,
                "$lte": request.end_time,
            },
        }

        logger.info(
            "Collecting SOAR Mongo data | db=%s company_id=%s start=%s end=%s",
            self.collections.database_name,
            request.company_id,
            request.start_time.isoformat(),
            request.end_time.isoformat(),
        )

        client = MongoClient(
            self.mongo_uri,
            serverSelectionTimeoutMS=self.connect_timeout_ms,
            connectTimeoutMS=self.connect_timeout_ms,
        )
        try:
            database = client[self.collections.database_name]
            alarm_docs = [
                _transform_alarm_doc(doc)
                for doc in database[self.collections.alarm_collection].find(
                    query, ALARM_PROJECTION
                )
            ]
            event_docs = list(
                _transform_event_doc(doc)
                for doc in database[self.collections.event_collection].find(
                    query, EVENT_PROJECTION
                )
            )
            event_docs = enrich_event_docs(event_docs)
            _attach_event_asset_security_domains(
                event_docs,
                database=database,
                company_id=request.company_id,
                asset_collection=self.collections.asset_collection,
                batch_size=self.asset_batch_size,
            )
            asset_docs = list(self._collect_asset_docs(database, request))
        finally:
            client.close()

        return {
            "meta": {
                "company_id": request.company_id,
                "start_time": _serialize_datetime(request.start_time),
                "end_time": _serialize_datetime(request.end_time),
                "database_name": self.collections.database_name,
                "alarm_collection": self.collections.alarm_collection,
                "event_collection": self.collections.event_collection,
                "asset_collection": self.collections.asset_collection,
                "business_collection": self.collections.business_collection,
                "alarm_count": len(alarm_docs),
                "event_count": len(event_docs),
                "asset_count": len(asset_docs),
                "extracted_at": _serialize_datetime(datetime.utcnow()),
            },
            "alarm": alarm_docs,
            "event": event_docs,
            "asset": asset_docs,
        }

    def _collect_asset_docs(self, database, request: MongoIngestionRequest):
        cursor = database[self.collections.asset_collection].aggregate(
            _build_asset_pipeline(request.company_id, self.collections.business_collection),
            allowDiskUse=True,
            batchSize=self.asset_batch_size,
        )
        for doc in cursor:
            yield _transform_asset_doc(doc)


def _serialize_datetime(value: datetime) -> str:
    if value.tzinfo is None:
        return value.isoformat() + "Z"
    return value.isoformat()


def _transform_alarm_doc(doc: Dict[str, Any]) -> Dict[str, Any]:
    transformed = {field: doc.get(field) for field in ALARM_OUTPUT_FIELDS}
    transformed["type"] = _build_type_display(
        doc.get("manage_type_name"),
        doc.get("manage_sub_type_name"),
        separator=">",
    )
    transformed["event_status"] = ALARM_EVENT_STATUS_DISPLAY.get(
        doc.get("event_status"),
        doc.get("event_status"),
    )
    transformed["attack_state"] = ATTACK_STATE_DISPLAY.get(
        doc.get("attack_state"),
        doc.get("attack_state"),
    )
    transformed["attack_direction"] = ATTACK_DIRECTION_DISPLAY.get(
        doc.get("attack_direction"),
        doc.get("attack_direction"),
    )
    transformed["service_status"] = ALARM_SERVICE_STATUS_DISPLAY.get(
        doc.get("service_status"),
        doc.get("service_status"),
    )
    transformed["reject_reason"] = REJECT_REASON_DISPLAY.get(
        _stringify_enum_key(doc.get("reject_reason")),
        doc.get("reject_reason"),
    )

    return transformed


def _transform_event_doc(doc: Dict[str, Any]) -> Dict[str, Any]:
    transformed = {field: doc.get(field) for field in EVENT_OUTPUT_FIELDS}
    manage_type_display = EVENT_MANAGE_TYPE_DISPLAY.get(
        _stringify_enum_key(doc.get("manage_type")),
        doc.get("manage_type"),
    )
    manage_sub_type_display = _get_event_manage_sub_type_display().get(
        _stringify_enum_key(doc.get("manage_sub_type")),
        doc.get("manage_sub_type"),
    )
    transformed["type"] = _build_type_display(
        manage_type_display,
        manage_sub_type_display,
        separator="->",
    )
    transformed["event_status"] = EVENT_EVENT_STATUS_DISPLAY.get(
        doc.get("event_status"),
        doc.get("event_status"),
    )
    transformed["event_grading_tag"] = EVENT_GRADING_TAG_DISPLAY.get(
        doc.get("event_grading_tag"),
        doc.get("event_grading_tag"),
    )
    transformed["service_status"] = EVENT_SERVICE_STATUS_DISPLAY.get(
        doc.get("service_status"),
        doc.get("service_status"),
    )
    transformed["push_status"] = PUSH_STATUS_DISPLAY.get(
        doc.get("push_status"),
        doc.get("push_status"),
    )
    return transformed


def _attach_event_asset_security_domains(
    event_docs: list[Dict[str, Any]],
    *,
    database,
    company_id: str,
    asset_collection: str,
    batch_size: int,
) -> None:
    host_ips = _collect_event_host_ips(event_docs)
    if not host_ips:
        return

    security_domain_by_ip = _load_asset_security_domain_map(
        database=database,
        company_id=company_id,
        asset_collection=asset_collection,
        host_ips=host_ips,
        batch_size=batch_size,
    )

    for event_doc in event_docs:
        event_doc["内网外网资产"] = _resolve_event_security_domain(
            event_doc.get("host_ip"),
            security_domain_by_ip,
        )


def _transform_asset_doc(doc: Dict[str, Any]) -> Dict[str, Any]:
    transformed = {field: doc.get(field) for field in ASSET_OUTPUT_FIELDS}
    transformed["asset_type"] = ASSET_TYPE_DISPLAY.get(
        _stringify_enum_key(doc.get("asset_type")),
        doc.get("asset_type"),
    )
    transformed["is_service"] = ASSET_SERVICE_STATUS_DISPLAY.get(
        doc.get("is_service"),
        doc.get("is_service"),
    )
    transformed["level"] = ASSET_LEVEL_DISPLAY.get(
        _stringify_enum_key(doc.get("level")),
        doc.get("level"),
    )
    return transformed


def _collect_event_host_ips(event_docs: list[Dict[str, Any]]) -> list[str]:
    seen: set[str] = set()
    host_ips: list[str] = []
    for event_doc in event_docs:
        for host_ip in _extract_host_ip_candidates(event_doc.get("host_ip")):
            if host_ip in seen:
                continue
            seen.add(host_ip)
            host_ips.append(host_ip)
    return host_ips


def _load_asset_security_domain_map(
    *,
    database,
    company_id: str,
    asset_collection: str,
    host_ips: list[str],
    batch_size: int,
) -> Dict[str, str]:
    security_domain_by_ip: Dict[str, str] = {}

    for ip_batch in _chunked(host_ips, batch_size):
        cursor = database[asset_collection].find(
            {
                "company_id": company_id,
                "is_deleted": 0,
                "asset": {"$in": ip_batch},
            },
            {
                "_id": 0,
                "asset": 1,
                "security_domain": 1,
            },
            batch_size=batch_size,
        )

        for doc in cursor:
            asset_ip = doc.get("asset")
            if asset_ip in (None, ""):
                continue

            security_domain = doc.get("security_domain") or ""
            existing = security_domain_by_ip.get(asset_ip)
            if existing:
                continue
            security_domain_by_ip[str(asset_ip)] = security_domain

    return security_domain_by_ip


def _resolve_event_security_domain(host_ip_value: Any, security_domain_by_ip: Dict[str, str]) -> str:
    domains: list[str] = []
    seen: set[str] = set()
    for host_ip in _extract_host_ip_candidates(host_ip_value):
        security_domain = security_domain_by_ip.get(host_ip)
        if security_domain in (None, "") or security_domain in seen:
            continue
        seen.add(security_domain)
        domains.append(security_domain)
    return "、".join(domains)


def _extract_host_ip_candidates(value: Any) -> list[str]:
    if value in (None, ""):
        return []

    if isinstance(value, str):
        return _split_host_ip_text(value)

    if isinstance(value, (list, tuple, set)):
        candidates: list[str] = []
        for item in value:
            candidates.extend(_extract_host_ip_candidates(item))
        return candidates

    return [str(value).strip()] if str(value).strip() else []


def _split_host_ip_text(value: str) -> list[str]:
    normalized = value
    for delimiter in ("，", ";", "；", "/", "|", "\n", "\t"):
        normalized = normalized.replace(delimiter, ",")
    normalized = " ".join(normalized.split())
    if " " in normalized:
        normalized = normalized.replace(" ", ",")

    results: list[str] = []
    seen: set[str] = set()
    for item in normalized.split(","):
        candidate = item.strip()
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        results.append(candidate)
    return results


def _chunked(values: list[str], chunk_size: int):
    for start in range(0, len(values), chunk_size):
        yield values[start : start + chunk_size]


def _build_asset_pipeline(company_id: str, business_collection: str) -> list[Dict[str, Any]]:
    return [
        {
            "$match": {
                "is_deleted": 0,
                "company_id": company_id,
            }
        },
        {
            "$lookup": {
                "from": business_collection,
                "localField": "business_id",
                "foreignField": "_id",
                "as": "business",
            }
        },
        {
            "$unwind": {
                "path": "$business",
                "preserveNullAndEmptyArrays": True,
            }
        },
        {
            "$project": {
                "_id": 0,
                "business_name": {"$ifNull": ["$business.business_name", ""]},
                "asset": "$asset",
                "level": {"$ifNull": ["$business.level", ""]},
                "is_service": "$is_service",
                "asset_type": "$asset_type",
                "security_domain": {"$ifNull": ["$security_domain", ""]},
            }
        },
    ]


def _stringify_enum_key(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)


def _get_event_manage_sub_type_display() -> Dict[str, str]:
    global _EVENT_MANAGE_SUB_TYPE_DISPLAY
    if _EVENT_MANAGE_SUB_TYPE_DISPLAY is not None:
        return _EVENT_MANAGE_SUB_TYPE_DISPLAY

    mapping_file = Path(config.settings.soar_manage_sub_type_map_file)
    if not mapping_file.exists():
        logger.warning("manage_sub_type mapping file not found: %s", mapping_file)
        _EVENT_MANAGE_SUB_TYPE_DISPLAY = {}
        return _EVENT_MANAGE_SUB_TYPE_DISPLAY

    try:
        payload = json.loads(mapping_file.read_text(encoding="utf-8"))
        items = payload.get("data", {}).get("manage_sub_type", [])
        _EVENT_MANAGE_SUB_TYPE_DISPLAY = {
            str(item.get("value")): item.get("name")
            for item in items
            if item.get("value") is not None and item.get("name") is not None
        }
    except Exception as exc:
        logger.warning("Failed to load manage_sub_type mapping file %s: %s", mapping_file, exc)
        _EVENT_MANAGE_SUB_TYPE_DISPLAY = {}

    return _EVENT_MANAGE_SUB_TYPE_DISPLAY


def _build_type_display(primary: Any, secondary: Any, separator: str) -> str:
    primary_text = None if primary in (None, "") else str(primary)
    secondary_text = None if secondary in (None, "") else str(secondary)

    if primary_text and secondary_text:
        return f"{primary_text}{separator}{secondary_text}"
    return primary_text or secondary_text
