from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

DEFAULT_ZAI_API_KEY = "1c277f409e7c4a9eacb93d53b5c78162.DUGAUnC2odc4xajG"
DEFAULT_MODEL = "glm-4.7"
DEFAULT_EXCEL_PATH = r"C:\Users\xupai\Desktop\支撑数据.xlsx"

def _normalize_cell(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def _extract_sheet_text(sheet) -> Tuple[str, int]:
    lines: List[str] = []
    non_empty_cells = 0
    rows_seen = 0

    for row in sheet.iter_rows(values_only=True):
        rows_seen += 1
        cells = [_normalize_cell(cell) for cell in row]
        filtered = [cell for cell in cells if cell]
        if filtered:
            non_empty_cells += len(filtered)
            lines.append("\t".join(filtered))

    if not lines:
        return "", 0

    text = "## " + str(sheet.title) + "\n" + "\n".join(lines)
    return text, non_empty_cells


def extract_excel_text(path: Path) -> Tuple[str, List[Tuple[str, int, str]]]:
    try:
        from openpyxl import load_workbook
    except Exception as exc:  # pragma: no cover - runtime dependency
        raise RuntimeError(
            "openpyxl is required to read .xlsx files. Install it via: pip install openpyxl"
        ) from exc

    print("Loading workbook...")
    workbook = load_workbook(path, data_only=True, read_only=True)
    print(f"Workbook loaded. Sheets: {len(workbook.worksheets)}")
    sheet_texts: List[Tuple[str, int, str]] = []

    if len(workbook.worksheets) < 2:
        raise RuntimeError("Workbook has fewer than 2 sheets; cannot select the second sheet.")

    sheet = workbook.worksheets[1]
    print(f"Extracting text from sheet: {sheet.title}")
    text, non_empty_cells = _extract_sheet_text(sheet)
    if text:
        print(
            f"  -> Non-empty cells: {non_empty_cells}, characters: {len(text)}"
        )
        sheet_texts.append((sheet.title, non_empty_cells, text))
    else:
        print("  -> Skipped (no text)")

    full_text = "\n\n".join(text for _, _, text in sheet_texts)
    print(f"Extraction complete. Total characters: {len(full_text)}")
    return full_text, sheet_texts


def _load_tokenizer(model: str):
    try:
        import tiktoken  # type: ignore
    except Exception:
        return None

    try:
        encoding = tiktoken.encoding_for_model(model)
        encoding_name = encoding.name
    except Exception:
        encoding = tiktoken.get_encoding("cl100k_base")
        encoding_name = "cl100k_base"

    return encoding, encoding_name


def estimate_tokens(text: str, model: str) -> Tuple[int, str]:
    if not text:
        return 0, "empty"

    tokenizer = _load_tokenizer(model)
    if tokenizer:
        encoding, encoding_name = tokenizer
        return len(encoding.encode(text)), f"tiktoken:{encoding_name}"

    # Heuristic: mixed Chinese/English ~2 chars per token
    return len(text) // 2, "heuristic:chars/2"


def estimate_tokens_via_zai(
    text: str,
    model: str,
    api_key: str,
    api_base: str,
    timeout: int,
    max_chars: int,
) -> Tuple[int, int, str]:
    if not text:
        return 0, 0, "zai:empty"

    try:
        import requests  # type: ignore
    except Exception as exc:  # pragma: no cover - runtime dependency
        raise RuntimeError(
            "requests is required to call Z.ai tokenizer API. Install it via: pip install requests"
        ) from exc

    url = api_base.rstrip("/") + "/api/paas/v4/tokenizer"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    chunks = _chunk_text(text, max_chars)
    total_prompt_tokens = 0
    total_tokens = 0

    for idx, chunk in enumerate(chunks, start=1):
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": chunk}],
        }
        print(
            f"Calling Z.ai tokenizer API: chunk={idx}/{len(chunks)}, model={model}, chars={len(chunk)}"
        )
        response = requests.post(url, headers=headers, json=payload, timeout=timeout)
        response.raise_for_status()
        data = response.json()
        usage = data.get("usage", {})
        prompt_tokens = int(usage.get("prompt_tokens", 0))
        total = int(usage.get("total_tokens", prompt_tokens))
        print(
            f"  -> chunk result: prompt_tokens={prompt_tokens}, total_tokens={total}"
        )
        total_prompt_tokens += prompt_tokens
        total_tokens += total

    print(
        f"Z.ai tokenizer API total: prompt_tokens={total_prompt_tokens}, total_tokens={total_tokens}"
    )
    return total_prompt_tokens, total_tokens, "zai:tokenizer_api"


def _chunk_text(text: str, max_chars: int) -> List[str]:
    if max_chars <= 0:
        return [text]

    lines = text.splitlines(keepends=True)
    chunks: List[str] = []
    buffer: List[str] = []
    buffer_len = 0

    for line in lines:
        line_len = len(line)
        if buffer_len + line_len > max_chars and buffer:
            chunks.append("".join(buffer))
            buffer = []
            buffer_len = 0
        buffer.append(line)
        buffer_len += line_len

    if buffer:
        chunks.append("".join(buffer))

    return chunks


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Estimate prompt tokens from an Excel file by extracting all text."
    )
    parser.add_argument(
        "--file",
        default=DEFAULT_EXCEL_PATH,
        help="Path to .xlsx file",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help="Model name for tokenizer selection",
    )
    parser.add_argument(
        "--use-zai-tokenizer",
        action="store_true",
        default=True,
        help="Use Z.ai tokenizer API for exact token count (default: enabled)",
    )
    parser.add_argument(
        "--no-zai-tokenizer",
        action="store_false",
        dest="use_zai_tokenizer",
        help="Disable Z.ai tokenizer API and use local estimation",
    )
    parser.add_argument(
        "--zai-api-key",
        help="Z.ai API key (or set ZAI_API_KEY env var)",
    )
    parser.add_argument(
        "--zai-api-base",
        default="https://api.z.ai",
        help="Z.ai API base URL",
    )
    parser.add_argument(
        "--zai-timeout",
        type=int,
        default=30,
        help="Z.ai tokenizer API timeout (seconds)",
    )
    parser.add_argument(
        "--zai-max-chars",
        type=int,
        default=200000,
        help="Max characters per tokenizer API call (default: 200000)",
    )
    parser.add_argument(
        "--per-sheet",
        action="store_true",
        help="Print per-sheet token counts",
    )
    parser.add_argument(
        "--save-text",
        help="Optional path to save extracted text",
    )

    args = parser.parse_args(list(argv) if argv is not None else None)
    path = Path(args.file).expanduser()

    if not path.exists():
        print(f"File not found: {path}", file=sys.stderr)
        return 1

    try:
        print(f"Input file: {path}")
        full_text, sheet_texts = extract_excel_text(path)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1

    total_tokens = 0
    total_tokens_all = 0
    tokenizer_label = ""
    if args.use_zai_tokenizer:
        print("Tokenizer mode: Z.ai API")
        api_key = args.zai_api_key or os.environ.get("ZAI_API_KEY") or DEFAULT_ZAI_API_KEY
        if not api_key:
            print("Missing Z.ai API key. Use --zai-api-key or set ZAI_API_KEY.", file=sys.stderr)
            return 1
        try:
            total_tokens, total_tokens_all, tokenizer_label = estimate_tokens_via_zai(
                full_text,
                args.model,
                api_key,
                args.zai_api_base,
                args.zai_timeout,
                args.zai_max_chars,
            )
        except Exception as exc:
            print(str(exc), file=sys.stderr)
            return 1
    else:
        print("Tokenizer mode: local estimation")
        total_tokens, tokenizer_label = estimate_tokens(full_text, args.model)
    total_chars = len(full_text)
    total_cells = sum(cell_count for _, cell_count, _ in sheet_texts)

    print(f"File: {path}")
    print(f"Sheets with text: {len(sheet_texts)}")
    print(f"Non-empty cells: {total_cells}")
    print(f"Total characters: {total_chars}")
    print(f"Tokenizer: {tokenizer_label}")
    print(f"Estimated tokens (total): {total_tokens}")
    if args.use_zai_tokenizer:
        print(f"Reported total_tokens (API): {total_tokens_all}")

    if args.per_sheet and sheet_texts:
        print("")
        print("Per-sheet estimates:")
        for sheet_name, cell_count, sheet_text in sheet_texts:
            if args.use_zai_tokenizer:
                try:
                    sheet_prompt_tokens, sheet_total_tokens, _ = estimate_tokens_via_zai(
                        sheet_text,
                        args.model,
                        api_key,
                        args.zai_api_base,
                        args.zai_timeout,
                        args.zai_max_chars,
                    )
                except Exception as exc:
                    print(f"- {sheet_name}: error: {exc}")
                    continue
                print(
                    f"- {sheet_name}: {sheet_prompt_tokens} prompt tokens, "
                    f"{sheet_total_tokens} total tokens, {cell_count} cells, {len(sheet_text)} chars"
                )
            else:
                sheet_tokens, _ = estimate_tokens(sheet_text, args.model)
                print(f"- {sheet_name}: {sheet_tokens} tokens, {cell_count} cells, {len(sheet_text)} chars")

    if args.save_text:
        output_path = Path(args.save_text).expanduser()
        output_path.write_text(full_text, encoding="utf-8")
        print(f"\nSaved extracted text to: {output_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
