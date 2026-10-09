from __future__ import annotations

import argparse
from datetime import date, datetime, time, timedelta, timezone
import json
from pathlib import Path
from typing import Any

from openpyxl import Workbook

from mss_ai_ppt_sample_assets.backend import config

BEIJING_TZ = timezone(timedelta(hours=8))
DEFAULT_OUTPUT_STEM = "soar_raw_export"
DEFAULT_OUTPUT_DIR = Path("mss_ai_ppt_sample_assets/backend/outputs")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export raw alarm/event data from the SOAR MongoDB source."
    )
    parser.add_argument(
        "--company-id",
        default=config.settings.soar_default_company_id,
        help="SOAR company_id filter",
    )
    parser.add_argument(
        "--date-range",
        default=config.settings.soar_default_date_range,
        help="Beijing date range in the form YYYY-MM-DD~YYYY-MM-DD",
    )
    parser.add_argument(
        "--start-time",
        help="Optional override for inclusive start time in ISO-8601 format",
    )
    parser.add_argument(
        "--end-time",
        help="Optional override for inclusive end time in ISO-8601 format",
    )
    parser.add_argument(
        "--output-dir",
        default=str(DEFAULT_OUTPUT_DIR),
        help="Output directory for the exported JSON and XLSX files",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    from mss_ai_ppt_sample_assets.backend.services.data_ingestion.collectors import (
        SOARMongoCollector,
    )
    from mss_ai_ppt_sample_assets.backend.services.data_ingestion.models import (
        MongoIngestionRequest,
    )

    start_time, end_time = _resolve_time_range(args.date_range, args.start_time, args.end_time)
    request = MongoIngestionRequest(company_id=args.company_id, start_time=start_time, end_time=end_time)
    collector = SOARMongoCollector()
    payload = collector.collect(request)

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    json_output_path, xlsx_output_path = _write_default_outputs(payload, output_dir)

    print(f"alarm_count={payload['meta']['alarm_count']}")
    print(f"event_count={payload['meta']['event_count']}")
    print(f"asset_count={payload['meta']['asset_count']}")
    print(f"company_id={args.company_id}")
    print(f"start_time={request.start_time.isoformat()}")
    print(f"end_time={request.end_time.isoformat()}")
    print(f"json_output={json_output_path}")
    print(f"xlsx_output={xlsx_output_path}")


def _resolve_time_range(
    date_range: str | None,
    start_time: str | None,
    end_time: str | None,
) -> tuple[datetime, datetime]:
    if start_time or end_time:
        if not (start_time and end_time):
            raise ValueError("start_time and end_time must be provided together")
        return _parse_datetime(start_time), _parse_datetime(end_time)

    if not date_range:
        raise ValueError("date_range is required when start_time/end_time are not provided")

    return _parse_beijing_date_range(date_range)


def _parse_beijing_date_range(date_range: str) -> tuple[datetime, datetime]:
    try:
        start_raw, end_raw = [part.strip() for part in date_range.split("~", 1)]
        start_day = datetime.strptime(start_raw, "%Y-%m-%d").date()
        end_day = datetime.strptime(end_raw, "%Y-%m-%d").date()
    except ValueError as exc:
        raise ValueError(
            "date_range must be in the form YYYY-MM-DD~YYYY-MM-DD"
        ) from exc

    if end_day < start_day:
        raise ValueError("date_range end day must be greater than or equal to start day")

    start_dt = datetime.combine(start_day, time.min, tzinfo=BEIJING_TZ)
    end_dt = datetime.combine(end_day, time.max, tzinfo=BEIJING_TZ)
    return start_dt, end_dt


def _parse_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=BEIJING_TZ)
    return parsed.astimezone(BEIJING_TZ)


def _json_default(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def _write_output(payload: dict[str, Any], output_path: Path) -> None:
    suffix = output_path.suffix.lower()
    if suffix == ".json":
        output_path.write_text(
            json.dumps(payload, default=_json_default, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return

    if suffix == ".xlsx":
        _write_xlsx_output(payload, output_path)
        return

    raise ValueError("output file extension must be .json or .xlsx")


def _write_default_outputs(payload: dict[str, Any], output_dir: Path) -> tuple[Path, Path]:
    json_output_path = output_dir / f"{DEFAULT_OUTPUT_STEM}.json"
    xlsx_output_path = output_dir / f"{DEFAULT_OUTPUT_STEM}.xlsx"
    _write_output(payload, json_output_path)
    _write_output(payload, xlsx_output_path)
    return json_output_path, xlsx_output_path


def _write_xlsx_output(payload: dict[str, Any], output_path: Path) -> None:
    workbook = Workbook(write_only=True)

    _write_sheet(workbook, "告警表", payload.get("alarm", []))
    _write_sheet(workbook, "事件表", payload.get("event", []))
    _write_sheet(workbook, "资产表", payload.get("asset", []))
    workbook.save(output_path)


def _write_sheet(workbook: Workbook, title: str, rows: list[dict[str, Any]]) -> None:
    sheet = workbook.create_sheet(title=title)
    headers = _collect_headers(rows)
    if not headers:
        return

    sheet.append(headers)
    for row in rows:
        sheet.append([_excel_cell_value(row.get(header)) for header in headers])


def _collect_headers(rows: list[dict[str, Any]]) -> list[str]:
    headers: list[str] = []
    seen: set[str] = set()
    for row in rows:
        for key in row.keys():
            if key in seen:
                continue
            seen.add(key)
            headers.append(key)
    return headers


def _excel_cell_value(value: Any):
    if isinstance(value, (datetime, date)):
        return value.isoformat(sep=" ")
    if isinstance(value, (list, dict)):
        return json.dumps(value, default=_json_default, ensure_ascii=False)
    return value


if __name__ == "__main__":
    main()
