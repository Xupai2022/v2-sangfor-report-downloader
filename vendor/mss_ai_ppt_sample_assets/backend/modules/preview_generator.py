from __future__ import annotations

import os
import shutil
import subprocess
import time
import logging
import uuid
from pathlib import Path
from typing import Dict, List, Tuple

from mss_ai_ppt_sample_assets.backend import config


class PreviewGenerationError(Exception):
    pass


INVALID_FS_CHARS = [":", "*", "?", "\"", "<", ">", "|"]

logger = logging.getLogger(__name__)


def sanitize_job_id(job_id: str) -> str:
    sanitized = job_id
    for ch in INVALID_FS_CHARS:
        sanitized = sanitized.replace(ch, "_")
    sanitized = sanitized.replace("\\", "_").replace("/", "_")
    return sanitized


def _sort_slide_paths(paths: List[Path]) -> List[Path]:
    def _slide_no(path: Path) -> int:
        try:
            return int(path.stem.replace("slide", ""))
        except Exception:
            return 10**9

    return sorted(paths, key=_slide_no)


class PPTPreviewGenerator:
    """Convert PPTX to slide images using LibreOffice and PyMuPDF.

    Pipeline: PPTX → LibreOffice → PDF → PyMuPDF → PNG images
    """

    def __init__(
        self,
        base_dir: Path = config.PREVIEWS_DIR,
        cleanup_days: int = 7,
        cleanup_interval_seconds: int = 600,
    ):
        """
        Initialize the preview generator.

        Args:
            base_dir: Base directory for storing previews
            cleanup_days: Number of days to keep previews (default: 7)
                         Set to 0 to disable automatic cleanup
        """
        self.base_dir = base_dir
        self.cleanup_days = cleanup_days
        self.cleanup_interval_seconds = max(0, int(cleanup_interval_seconds))
        self._last_cleanup_at: float = 0.0
        self._soffice_path: str | None = None
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def _find_soffice(self) -> str:
        """Locate the soffice executable."""
        if self._soffice_path:
            return self._soffice_path

        soffice_candidates = []
        env_path = os.getenv("LIBREOFFICE_PATH")
        if env_path:
            soffice_candidates.append(Path(env_path))

        # Common default installation paths on Windows
        soffice_candidates.extend(
            [
                Path(r"C:\Program Files\LibreOffice\program\soffice.exe"),
                Path(r"C:\Program Files (x86)\LibreOffice\program\soffice.exe"),
                Path(r"C:\Program Files\OpenOffice 4\program\soffice.exe"),
            ]
        )

        for cand in soffice_candidates:
            if cand.is_file():
                self._soffice_path = str(cand)
                return self._soffice_path

        self._soffice_path = shutil.which("soffice") or "soffice"
        return self._soffice_path

    def _maybe_cleanup_old_previews(self) -> None:
        """Run cleanup at a bounded cadence to avoid per-request full scans."""
        if self.cleanup_days <= 0:
            return
        if self.cleanup_interval_seconds <= 0:
            self._cleanup_old_previews()
            return

        now = time.monotonic()
        if self._last_cleanup_at and (now - self._last_cleanup_at) < self.cleanup_interval_seconds:
            return

        self._cleanup_old_previews()
        self._last_cleanup_at = now

    def _cleanup_old_previews(self) -> None:
        """
        Clean up preview directories older than cleanup_days.

        This method is automatically called when generating new previews.
        It removes directories whose last modification time exceeds the threshold.
        """
        if self.cleanup_days <= 0:
            return  # Cleanup disabled

        cutoff_time = time.time() - (self.cleanup_days * 24 * 60 * 60)

        try:
            for item in self.base_dir.iterdir():
                if not item.is_dir():
                    continue
                # Preserve static template preview assets used by pre-config UI.
                if item.name.startswith("template_"):
                    continue

                # Check directory modification time (last access/creation)
                dir_mtime = item.stat().st_mtime

                if dir_mtime < cutoff_time:
                    try:
                        shutil.rmtree(item)
                        # Optional: log cleanup (you can enable logging if needed)
                        # import logging
                        # logging.info(f"Cleaned up old preview: {item.name}")
                    except Exception:
                        # Ignore errors for individual directories (might be in use)
                        pass
        except Exception:
            # Ignore cleanup errors to not block preview generation
            pass

    def _pptx_to_pdf(self, ppt_path: Path, output_dir: Path) -> Path:
        """
        Use LibreOffice in headless mode to convert PPTX to PDF.

        Requires LibreOffice with `soffice` CLI available.
        """
        soffice = self._find_soffice()
        output_dir.mkdir(parents=True, exist_ok=True)

        try:
            subprocess.run(
                [
                    soffice,
                    "--headless",
                    "--nologo",
                    "--nofirststartwizard",
                    "--convert-to",
                    "pdf",
                    "--outdir",
                    str(output_dir),
                    str(ppt_path),
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
        except Exception as exc:
            raise PreviewGenerationError(
                "LibreOffice (`soffice`) is required for PPTX to PDF conversion. "
                "Please install LibreOffice and, if needed, set environment variable "
                "LIBREOFFICE_PATH to the full path of soffice.exe."
            ) from exc

        pdf_files = sorted(output_dir.glob("*.pdf"))
        if not pdf_files:
            raise PreviewGenerationError("No PDF generated from LibreOffice export")
        return pdf_files[0]

    def _pptx_to_pdf_with_timings(
        self, ppt_path: Path, output_dir: Path
    ) -> Tuple[Path, Dict[str, float]]:
        start = time.perf_counter()
        pdf_path = self._pptx_to_pdf(ppt_path, output_dir)
        duration_ms = (time.perf_counter() - start) * 1000
        logger.info(f"PPTX->PDF in {duration_ms:.0f}ms ({ppt_path.name})")
        return pdf_path, {"pptx_to_pdf_ms": duration_ms}

    def _pdf_to_images(self, pdf_path: Path, output_dir: Path) -> List[Path]:
        """
        Convert PDF to PNG images using PyMuPDF (fitz).

        Uses a zoom factor of 2.0 for 144 DPI output quality.
        """
        output_dir.mkdir(parents=True, exist_ok=True)

        try:
            import fitz  # PyMuPDF
        except ImportError as exc:
            raise PreviewGenerationError(
                "PyMuPDF (pymupdf) is required for PDF to PNG conversion. "
                "Install it with: pip install pymupdf"
            ) from exc

        try:
            doc = fitz.open(str(pdf_path))
            result: List[Path] = []
            
            mat = fitz.Matrix(1.2, 1.2)

            for i, page in enumerate(doc):
                pix = page.get_pixmap(matrix=mat)
                target = output_dir / f"slide{i+1}.png"
                pix.save(str(target))
                result.append(target)

            doc.close()

            if not result:
                raise PreviewGenerationError("No images generated from PDF")

            # Sort by numeric slide number to ensure correct order
            # (slide1.png, slide2.png, ..., slide10.png instead of dictionary order)
            return _sort_slide_paths(result)

        except Exception as exc:
            raise PreviewGenerationError(
                f"Failed to convert PDF to images using PyMuPDF: {exc}"
            ) from exc

    def _pdf_to_images_with_timings(
        self, pdf_path: Path, output_dir: Path
    ) -> Tuple[List[Path], Dict[str, float]]:
        start = time.perf_counter()
        images = self._pdf_to_images(pdf_path, output_dir)
        duration_ms = (time.perf_counter() - start) * 1000
        logger.info(f"PDF->images in {duration_ms:.0f}ms ({len(images)} pages)")
        return images, {"pdf_to_images_ms": duration_ms}

    def _make_staging_dir(self, job_dir: str) -> Path:
        staging_root = self.base_dir / ".staging"
        staging_root.mkdir(parents=True, exist_ok=True)
        return staging_root / f"{job_dir}_{uuid.uuid4().hex}"

    def _copy_tree_contents(self, src_dir: Path, dst_dir: Path) -> List[Path]:
        dst_dir.mkdir(parents=True, exist_ok=True)
        incoming_files = {
            path.relative_to(src_dir)
            for path in src_dir.rglob("*")
            if path.is_file()
        }

        for path in src_dir.rglob("*"):
            rel = path.relative_to(src_dir)
            target = dst_dir / rel
            if path.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)

        for path in sorted(dst_dir.rglob("*"), key=lambda item: len(item.parts), reverse=True):
            if path.is_file() and path.relative_to(dst_dir) not in incoming_files:
                try:
                    path.unlink()
                except Exception:
                    pass
            elif path.is_dir():
                try:
                    path.rmdir()
                except Exception:
                    pass

        return _sort_slide_paths(list(dst_dir.glob("slide*.png")))

    def _publish_staged_previews(self, staging_dir: Path, output_dir: Path) -> List[Path]:
        backup_dir: Path | None = None
        try:
            if output_dir.exists():
                backup_dir = output_dir.with_name(f"{output_dir.name}.bak_{uuid.uuid4().hex}")
                output_dir.replace(backup_dir)
            staging_dir.replace(output_dir)
            if backup_dir:
                shutil.rmtree(backup_dir, ignore_errors=True)
            return _sort_slide_paths(list(output_dir.glob("slide*.png")))
        except Exception as exc:
            logger.warning(
                "Atomic preview publish failed for %s, falling back to in-place copy: %s",
                output_dir.name,
                exc,
            )
            if backup_dir and not output_dir.exists() and backup_dir.exists():
                try:
                    backup_dir.replace(output_dir)
                except Exception:
                    pass
            published = self._copy_tree_contents(staging_dir, output_dir)
            shutil.rmtree(staging_dir, ignore_errors=True)
            if backup_dir and backup_dir.exists():
                shutil.rmtree(backup_dir, ignore_errors=True)
            return published

    def to_images(self, ppt_path: Path, job_id: str) -> List[Path]:
        """
        Convert PPTX to PNG images.

        Pipeline: PPTX → LibreOffice → PDF → PyMuPDF → PNG

        This method also triggers automatic cleanup of old previews
        if cleanup_days > 0.
        """
        # Cleanup old previews at bounded cadence.
        self._maybe_cleanup_old_previews()

        if not ppt_path.exists():
            raise PreviewGenerationError(f"PPT file not found: {ppt_path}")

        job_dir = sanitize_job_id(job_id)
        output_dir = self.base_dir / job_dir
        staging_dir = self._make_staging_dir(job_dir)
        if staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)

        # Step 1: PPTX → PDF (LibreOffice)
        pdf_path = self._pptx_to_pdf(ppt_path, staging_dir)

        # Step 2: PDF → PNG (PyMuPDF)
        self._pdf_to_images(pdf_path, staging_dir)

        return self._publish_staged_previews(staging_dir, output_dir)

    def to_images_with_timings(
        self, ppt_path: Path, job_id: str
    ) -> Tuple[List[Path], Dict[str, float]]:
        """Convert PPTX to PNG images and return timing breakdown.

        Returns:
            (images, timings_ms)
        """
        # Cleanup old previews at bounded cadence.
        self._maybe_cleanup_old_previews()

        if not ppt_path.exists():
            raise PreviewGenerationError(f"PPT file not found: {ppt_path}")

        job_dir = sanitize_job_id(job_id)
        output_dir = self.base_dir / job_dir
        staging_dir = self._make_staging_dir(job_dir)
        if staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)

        total_start = time.perf_counter()
        pdf_path, t1 = self._pptx_to_pdf_with_timings(ppt_path, staging_dir)
        _images, t2 = self._pdf_to_images_with_timings(pdf_path, staging_dir)
        images = self._publish_staged_previews(staging_dir, output_dir)
        total_ms = (time.perf_counter() - total_start) * 1000

        timings: Dict[str, float] = {}
        timings.update(t1)
        timings.update(t2)
        timings["pptx_to_images_total_ms"] = total_ms
        return images, timings

    def get_pdf_path(self, ppt_path: Path, job_id: str) -> Path:
        """
        Get or generate PDF file for a PPT file.

        If PDF already exists in preview directory, return it.
        Otherwise, generate it using LibreOffice.

        Returns:
            Path to the PDF file
        """
        if not ppt_path.exists():
            raise PreviewGenerationError(f"PPT file not found: {ppt_path}")

        job_dir = sanitize_job_id(job_id)
        output_dir = self.base_dir / job_dir
        output_dir.mkdir(parents=True, exist_ok=True)

        # Check if PDF already exists
        pdf_files = sorted(output_dir.glob("*.pdf"))
        if pdf_files:
            return pdf_files[0]

        # Generate PDF if not exists
        pdf_path, _timings = self._pptx_to_pdf_with_timings(ppt_path, output_dir)
        return pdf_path
