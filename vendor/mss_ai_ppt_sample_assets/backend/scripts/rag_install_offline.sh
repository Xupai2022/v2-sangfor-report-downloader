#!/usr/bin/env bash
set -euo pipefail

# Offline install helper for intranet Linux deployment.
# Usage:
#   ./rag_install_offline.sh /path/to/offline_assets /path/to/backend/requirements.txt

ASSET_DIR="${1:-./offline_assets}"
REQ_FILE="${2:-./mss_ai_ppt_sample_assets/backend/requirements.txt}"

WHEELHOUSE_DIR="${ASSET_DIR}/wheelhouse"
MODEL_DIR="${ASSET_DIR}/models"

if [[ ! -d "${WHEELHOUSE_DIR}" ]]; then
  echo "[error] wheelhouse not found: ${WHEELHOUSE_DIR}"
  exit 1
fi

if [[ ! -f "${REQ_FILE}" ]]; then
  echo "[error] requirements file not found: ${REQ_FILE}"
  exit 1
fi

echo "[step] installing python dependencies from local wheelhouse"
python3 -m pip install --no-index --find-links "${WHEELHOUSE_DIR}" -r "${REQ_FILE}"

echo "[step] configuring offline huggingface behavior"
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export SENTENCE_TRANSFORMERS_HOME="${MODEL_DIR}"
echo "[info] SENTENCE_TRANSFORMERS_HOME=${SENTENCE_TRANSFORMERS_HOME}"

if [[ -f "${ASSET_DIR}/qdrant.tar" ]]; then
  echo "[step] loading qdrant docker image"
  docker image load -i "${ASSET_DIR}/qdrant.tar"
  echo "[hint] run qdrant with:"
  echo "  docker run -d --name qdrant -p 6333:6333 -v /data/qdrant:/qdrant/storage qdrant/qdrant:latest"
else
  echo "[warn] qdrant.tar not found. If you do not use docker, deploy qdrant binary + systemd manually."
fi

echo "[done] offline installation completed"
