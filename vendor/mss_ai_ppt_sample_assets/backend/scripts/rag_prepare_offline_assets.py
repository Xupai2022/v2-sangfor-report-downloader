#!/usr/bin/env python3
"""Prepare offline assets for RAG deployment in intranet Linux environments."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


def run(cmd: list[str]) -> None:
    print(f"[run] {' '.join(cmd)}")
    subprocess.run(cmd, check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare offline wheelhouse/model/docker assets for RAG.")
    parser.add_argument(
        "--output-dir",
        default="offline_assets",
        help="Output directory for offline artifacts",
    )
    parser.add_argument(
        "--requirements",
        default="mss_ai_ppt_sample_assets/backend/requirements.txt",
        help="Requirements file path",
    )
    parser.add_argument(
        "--embed-model",
        default="BAAI/bge-small-zh-v1.5",
        help="Embedding model for RAG",
    )
    parser.add_argument(
        "--rerank-model",
        default="BAAI/bge-reranker-base",
        help="Reranker model for RAG",
    )
    parser.add_argument(
        "--include-docker-image",
        action="store_true",
        help="Export qdrant docker image tar",
    )
    parser.add_argument(
        "--qdrant-image",
        default="qdrant/qdrant:latest",
        help="Qdrant docker image tag",
    )
    args = parser.parse_args()

    out_dir = Path(args.output_dir).resolve()
    wheelhouse_dir = out_dir / "wheelhouse"
    model_dir = out_dir / "models"
    embed_model_cache_dir = model_dir / args.embed_model.replace("/", "__")
    rerank_model_cache_dir = model_dir / args.rerank_model.replace("/", "__")
    wheelhouse_dir.mkdir(parents=True, exist_ok=True)
    embed_model_cache_dir.mkdir(parents=True, exist_ok=True)
    rerank_model_cache_dir.mkdir(parents=True, exist_ok=True)

    requirements = Path(args.requirements).resolve()
    if not requirements.exists():
        raise FileNotFoundError(f"requirements file not found: {requirements}")

    run(
        [
            sys.executable,
            "-m",
            "pip",
            "download",
            "-r",
            str(requirements),
            "-d",
            str(wheelhouse_dir),
        ]
    )

    try:
        from huggingface_hub import snapshot_download
    except Exception as e:
        raise RuntimeError(
            "huggingface_hub is required. Install dependencies first: pip install -r requirements.txt"
        ) from e

    print(f"[info] downloading model snapshot: {args.embed_model}")
    snapshot_download(
        repo_id=args.embed_model,
        local_dir=str(embed_model_cache_dir),
        local_dir_use_symlinks=False,
    )

    print(f"[info] downloading reranker snapshot: {args.rerank_model}")
    snapshot_download(
        repo_id=args.rerank_model,
        local_dir=str(rerank_model_cache_dir),
        local_dir_use_symlinks=False,
    )

    if args.include_docker_image:
        image_tar = out_dir / "qdrant.tar"
        run(["docker", "pull", args.qdrant_image])
        run(["docker", "image", "save", "-o", str(image_tar), args.qdrant_image])

    example_env = out_dir / "rag.env.example"
    example_env.write_text(
        "\n".join(
            [
                "RAG_ENABLED=true",
                "RAG_VECTOR_BACKEND=qdrant",
                "RAG_QDRANT_URL=http://127.0.0.1:6333",
                "RAG_QDRANT_COLLECTION=kb_chunks",
                f"RAG_EMBED_MODEL={args.embed_model}",
                "RAG_ENABLE_RERANK=true",
                f"RAG_RERANK_MODEL={args.rerank_model}",
                f"RAG_TOP_K=8",
                f"RAG_MAX_CONTEXT_CHARS=4000",
                "RAG_HF_LOCAL_FILES_ONLY=true",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    # Copy requirements for intranet installation convenience.
    shutil.copy2(requirements, out_dir / "requirements.txt")
    print(f"[done] offline assets prepared at: {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
