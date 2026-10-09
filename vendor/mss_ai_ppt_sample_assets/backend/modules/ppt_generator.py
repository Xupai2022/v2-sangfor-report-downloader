from __future__ import annotations

import logging
from copy import deepcopy
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple

from mss_ai_ppt_sample_assets.backend.models.slidespec import SlideSpecV2
from mss_ai_ppt_sample_assets.backend.modules.template_loader import TemplateRepository

logger = logging.getLogger(__name__)


# Professional color palettes for charts and tables
class ChartColors:
    """Professional color schemes for charts and tables.

    Color palette based on professional security report style:
    - Primary: #0A4275 (deep professional blue)
    - Accent: #3182CE (lighter blue)
    - Text: #333333 (dark gray)
    """

    # Primary palette (professional blue-based)
    PRIMARY = [
        (10, 66, 117),    # #0A4275 - Deep Professional Blue
        (49, 130, 206),   # #3182CE - Accent Blue
        (99, 179, 237),   # #63B3ED - Light Blue
        (144, 205, 244),  # #90CDF4 - Pale Blue
    ]

    # Severity palette (for security data)
    SEVERITY = {
        'critical': (220, 38, 38),   # #DC2626 - Red
        'high': (234, 88, 12),       # #EA580C - Orange
        'medium': (234, 179, 8),     # #EAB308 - Yellow
        'low': (34, 197, 94),        # #22C55E - Green
        'info': (148, 163, 184),     # #94A3B8 - Gray
    }

    # Multi-series palette (vibrant, distinguishable)
    MULTI_SERIES = [
        (10, 66, 117),    # #0A4275 - Deep Blue
        (34, 197, 94),    # #22C55E - Green
        (234, 179, 8),    # #EAB308 - Yellow/Amber
        (168, 85, 247),   # #A855F7 - Purple
        (236, 72, 153),   # #EC4899 - Pink
        (20, 184, 166),   # #14B8A6 - Teal
    ]

    # Table styles - Professional blue header
    TABLE_HEADER_BG = (10, 66, 117)        # #0A4275 - Deep Blue
    TABLE_HEADER_TEXT = (255, 255, 255)    # White
    TABLE_ROW_ALT = (237, 242, 247)        # #EDF2F7 - Light Gray (alternating)
    TABLE_ROW_NORMAL = (255, 255, 255)     # White
    TABLE_BORDER = (226, 232, 240)         # #E2E8F0 - Section border

    # Text colors
    TEXT_LIGHT_THEME = (51, 51, 51)        # #333333 for light backgrounds


class PPTGeneratorV2:
    """Fill PPTX template placeholders with V2 slidespec content.

    V2 simplification: slidespec.placeholders directly maps token -> value,
    no need to traverse render_map paths.
    """

    _CRITICAL_ASSURANCE_FESTIVAL_PARAGRAPHS: List[Tuple[str, str]] = [
        ("mid_autumn_festival", "中秋节值守保障"),
        ("national_day", "国庆值守保障"),
        ("new_years_day", "元旦节值守保障"),
        ("spring_festival", "春节值守保障"),
        ("qingming_festival", "清明节值守保障"),
        ("labor_day", "五一值守保障"),
        ("dragon_boat_festival", "端午节值守保障"),
    ]

    def __init__(self, template_repo: TemplateRepository):
        self.template_repo = template_repo
        try:
            from pptx import Presentation
            from pptx.util import Inches, Pt, Emu
            from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION, XL_LABEL_POSITION
            from pptx.chart.data import CategoryChartData
            from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
            from pptx.dml.color import RGBColor

            self._Presentation = Presentation
            self._Inches = Inches
            self._Pt = Pt
            self._Emu = Emu
            self._XL_CHART_TYPE = XL_CHART_TYPE
            self._XL_LEGEND_POSITION = XL_LEGEND_POSITION
            self._XL_LABEL_POSITION = XL_LABEL_POSITION
            self._CategoryChartData = CategoryChartData
            self._PP_ALIGN = PP_ALIGN
            self._MSO_ANCHOR = MSO_ANCHOR
            self._RGBColor = RGBColor
        except ImportError as exc:
            raise RuntimeError(
                "python-pptx is required for PPT rendering. Please install via requirements.txt."
            ) from exc

        # Chart renderer function mapping (new architecture)
        self._chart_renderers = {
            'P11_bar': self._render_p11_bar,
            'P11_line': self._render_p11_line,
            'P11_pie': self._render_p11_pie,
            'P13_pie': self._render_p13_pie,
            'P14_pie': self._render_p14_pie,
            'P15_pie_1': self._render_p15_pie_1,
            'P15_pie_2': self._render_p15_pie_2,
            'P15_line': self._render_p15_line,
            'P15_bar': self._render_p15_bar,
            'P16_combo': self._render_p16_combo,
            'P26_line': self._render_p26_line,
            'P27_bar': self._render_p11_bar,
            'P27_line': self._render_p11_line,
            'P27_pie': self._render_p11_pie,
            'P28_pie_1': self._render_p15_pie_1,
            'P28_pie_2': self._render_p15_pie_2,
            'P28_bar': self._render_p15_bar,
            'P28_line': self._render_p15_line,
            'P29_pie': self._render_p14_pie,
            'P29_line': self._render_p26_line,
            'P30_combo': self._render_p16_combo,
            # Add more specific chart types here
        }

    def _replace_tokens_in_paragraph(
        self,
        paragraph,
        placeholder_pairs: List[Tuple[str, str]]
    ) -> Tuple[bool, str]:
        """Replace placeholders in a paragraph while preserving run-level styling."""
        if not placeholder_pairs:
            return False, paragraph.text or ""

        runs = list(paragraph.runs)
        if not runs:
            paragraph_text = paragraph.text or ""
            replaced_text = paragraph_text
            for placeholder, replacement in placeholder_pairs:
                if placeholder in replaced_text:
                    replaced_text = replaced_text.replace(placeholder, replacement)

            if replaced_text == paragraph_text:
                return False, paragraph_text

            paragraph.text = replaced_text
            return True, replaced_text

        run_texts = [run.text or "" for run in runs]
        paragraph_text = "".join(run_texts)
        if not paragraph_text:
            return False, paragraph_text

        if not any(placeholder in paragraph_text for placeholder, _ in placeholder_pairs):
            return False, paragraph_text

        # Map each source character to the run index it came from.
        char_run_indices: List[int] = []
        for run_idx, run_text in enumerate(run_texts):
            char_run_indices.extend([run_idx] * len(run_text))

        # Keep a copy of each run's XML style (<a:rPr>) for accurate style cloning.
        run_styles = [deepcopy(run._r.rPr) if run._r.rPr is not None else None for run in runs]

        segments: List[Tuple[str, int]] = []
        changed = False
        i = 0
        while i < len(paragraph_text):
            matched = False
            for placeholder, replacement in placeholder_pairs:
                if paragraph_text.startswith(placeholder, i):
                    changed = True
                    matched = True
                    style_idx = char_run_indices[i] if char_run_indices else 0
                    if replacement:
                        if segments and segments[-1][1] == style_idx:
                            prev_text, _ = segments[-1]
                            segments[-1] = (prev_text + replacement, style_idx)
                        else:
                            segments.append((replacement, style_idx))
                    i += len(placeholder)
                    break

            if matched:
                continue

            style_idx = char_run_indices[i] if char_run_indices else 0
            ch = paragraph_text[i]
            if segments and segments[-1][1] == style_idx:
                prev_text, _ = segments[-1]
                segments[-1] = (prev_text + ch, style_idx)
            else:
                segments.append((ch, style_idx))
            i += 1

        if not changed:
            return False, paragraph_text

        paragraph.clear()

        if not segments:
            empty_run = paragraph.add_run()
            if run_styles and run_styles[0] is not None:
                if empty_run._r.rPr is not None:
                    empty_run._r.remove(empty_run._r.rPr)
                empty_run._r.insert(0, deepcopy(run_styles[0]))
            return True, ""

        for text, style_idx in segments:
            new_run = paragraph.add_run()
            new_run.text = text
            style_xml = run_styles[style_idx] if style_idx < len(run_styles) else None
            if style_xml is not None:
                if new_run._r.rPr is not None:
                    new_run._r.remove(new_run._r.rPr)
                new_run._r.insert(0, deepcopy(style_xml))

        replaced_text = "".join(text for text, _ in segments)
        return True, replaced_text

    def _replace_tokens_in_shape(self, shape, mapping: Dict[str, str]) -> None:
        """Replace {{TOKEN}} placeholders in shape text."""
        if not mapping:
            return

        placeholder_pairs: List[Tuple[str, str]] = []
        for token, value in mapping.items():
            placeholder = f"{{{{{token}}}}}"
            replacement = "" if value is None else str(value)
            placeholder_pairs.append((placeholder, replacement))
        placeholder_pairs.sort(key=lambda x: len(x[0]), reverse=True)

        # Group shapes do not expose text directly; recurse into child shapes.
        if shape.shape_type == 6:  # GROUP
            for sub_shape in shape.shapes:
                self._replace_tokens_in_shape(sub_shape, mapping)
            return

        if getattr(shape, "has_table", False):
            for row in shape.table.rows:
                for cell in row.cells:
                    for paragraph in cell.text_frame.paragraphs:
                        self._replace_tokens_in_paragraph(paragraph, placeholder_pairs)
            return

        if not shape.has_text_frame:
            return

        for paragraph in shape.text_frame.paragraphs:
            changed, replaced_text = self._replace_tokens_in_paragraph(paragraph, placeholder_pairs)
            if not changed:
                continue

            # Apply formatting for long/multiline generated content.
            if '\n' in replaced_text or len(replaced_text) > 50:
                paragraph.line_spacing = 1.25
                paragraph.space_after = self._Pt(6)
                if shape.text_frame.word_wrap is None:
                    shape.text_frame.word_wrap = True

    @staticmethod
    def _normalize_placeholder_text(text: str) -> str:
        """Normalize placeholder text like {{TOKEN}} or {{{TOKEN}}} to TOKEN."""
        normalized = (text or "").strip()
        normalized = normalized.strip("{}").strip()
        return normalized

    def _iter_slide_shapes(self, shapes, parent_left=0, parent_top=0):
        """Yield shapes recursively with absolute position for group contents."""
        for shape in shapes:
            abs_left = parent_left + getattr(shape, "left", 0)
            abs_top = parent_top + getattr(shape, "top", 0)
            yield shape, abs_left, abs_top
            if shape.shape_type == 6:  # GROUP
                try:
                    yield from self._iter_slide_shapes(shape.shapes, abs_left, abs_top)
                except Exception as exc:
                    logger.debug(f"Skipping group traversal due to error: {exc}")

    def _find_placeholder_shape(self, slide, token: str):
        """Find the specific placeholder shape for a chart token on a slide."""
        normalized_token = self._normalize_placeholder_text(token)
        for shape, abs_left, abs_top in self._iter_slide_shapes(slide.shapes):
            try:
                if not getattr(shape, "has_text_frame", False):
                    continue
                full_text = "".join(
                    run.text
                    for paragraph in shape.text_frame.paragraphs
                    for run in paragraph.runs
                ).strip()
                if self._normalize_placeholder_text(full_text) == normalized_token:
                    return shape, (abs_left, abs_top)
            except Exception:
                continue
        return None, None

    def _find_nearest_chart(self, slide, placeholder_position, allowed_chart_types):
        """Find the nearest chart matching one of the allowed chart types."""
        chart = None
        chart_shape = None
        min_distance = float("inf")

        for shape, abs_left, abs_top in self._iter_slide_shapes(slide.shapes):
            try:
                if not shape.has_chart:
                    continue
                temp_chart = shape.chart
                if temp_chart.chart_type not in allowed_chart_types:
                    continue

                if placeholder_position:
                    distance = (
                        (abs_left - placeholder_position[0]) ** 2
                        + (abs_top - placeholder_position[1]) ** 2
                    ) ** 0.5
                    if distance < min_distance:
                        min_distance = distance
                        chart = temp_chart
                        chart_shape = shape
                elif chart is None:
                    chart = temp_chart
                    chart_shape = shape
            except Exception as exc:
                logger.debug(f"Skipping chart lookup due to error: {exc}")
                continue

        return chart_shape, chart

    def _cleanup_critical_assurance_festival_paragraphs(self, slide, mapping: Dict[str, str]) -> None:
        """Remove title/value paragraph pairs for empty festival duty copy on P16."""
        empty_tokens = {
            token
            for token, _ in self._CRITICAL_ASSURANCE_FESTIVAL_PARAGRAPHS
            if (mapping.get(token) or "").strip() == ""
        }
        if not empty_tokens:
            return

        for shape, _, _ in self._iter_slide_shapes(slide.shapes):
            if not getattr(shape, "has_text_frame", False):
                continue

            paragraphs = list(shape.text_frame.paragraphs)
            if not paragraphs:
                continue

            paragraph_texts = [(paragraph.text or "").strip() for paragraph in paragraphs]
            if not any(
                title in paragraph_texts
                for _, title in self._CRITICAL_ASSURANCE_FESTIVAL_PARAGRAPHS
            ):
                continue

            remove_indices = set()
            for token, title in self._CRITICAL_ASSURANCE_FESTIVAL_PARAGRAPHS:
                if token not in empty_tokens:
                    continue
                try:
                    title_idx = paragraph_texts.index(title)
                except ValueError:
                    continue

                value_idx = title_idx + 1
                if value_idx >= len(paragraphs):
                    continue
                if paragraph_texts[value_idx]:
                    continue

                remove_indices.add(title_idx)
                remove_indices.add(value_idx)

            if not remove_indices:
                return

            for idx in sorted(remove_indices, reverse=True):
                paragraph = paragraphs[idx]
                paragraph._p.getparent().remove(paragraph._p)
            return

    def _render_native_table(
        self,
        slide,
        table_data: Dict[str, Any],
        position: Optional[Dict[str, float]] = None
    ) -> None:
        """Render a professional-styled native PowerPoint table.

        Args:
            slide: pptx slide object
            table_data: Dict with 'headers' (list) and 'rows' (list of lists)
            position: Dict with 'left', 'top', 'width', 'height' in inches
        """
        if not table_data or 'headers' not in table_data or 'rows' not in table_data:
            logger.warning("Invalid table data format")
            return

        headers = table_data['headers']
        rows = table_data['rows']

        if not headers or not rows:
            logger.warning("Empty table data")
            return

        # Default position if not specified
        if position is None:
            position = {'left': 0.8, 'top': 2.5, 'width': 8.5, 'height': 3.0}

        # Calculate dimensions
        num_rows = len(rows) + 1  # +1 for header
        num_cols = len(headers)

        # Create table
        left = self._Inches(position.get('left', 0.8))
        top = self._Inches(position.get('top', 2.5))
        width = self._Inches(position.get('width', 8.5))
        height = self._Inches(position.get('height', 3.0))

        table_shape = slide.shapes.add_table(num_rows, num_cols, left, top, width, height)
        table = table_shape.table

        # Calculate column widths based on header lengths and content
        col_widths = table_data.get('col_widths', None)
        if col_widths:
            total_width = sum(col_widths)
            for col_idx, cw in enumerate(col_widths):
                table.columns[col_idx].width = self._Inches(cw * position.get('width', 8.5) / total_width)

        # Style headers (professional deep blue with white text)
        header_bg = ChartColors.TABLE_HEADER_BG
        header_text = ChartColors.TABLE_HEADER_TEXT

        for col_idx, header in enumerate(headers):
            cell = table.rows[0].cells[col_idx]
            cell.text = str(header)

            # Header background
            cell.fill.solid()
            cell.fill.fore_color.rgb = self._RGBColor(*header_bg)

            # Header text styling
            paragraph = cell.text_frame.paragraphs[0]
            paragraph.font.bold = True
            paragraph.font.size = self._Pt(11)
            paragraph.font.color.rgb = self._RGBColor(*header_text)
            paragraph.font.name = "微软雅黑"
            paragraph.alignment = self._PP_ALIGN.CENTER

            # Vertical alignment
            cell.vertical_anchor = self._MSO_ANCHOR.MIDDLE

        # Style data rows with alternating colors
        for row_idx, row_data in enumerate(rows):
            # Alternating row colors for better readability
            if row_idx % 2 == 0:
                row_bg = ChartColors.TABLE_ROW_NORMAL
            else:
                row_bg = ChartColors.TABLE_ROW_ALT

            for col_idx, cell_value in enumerate(row_data):
                if col_idx < num_cols:
                    cell = table.rows[row_idx + 1].cells[col_idx]

                    # Format cell value
                    display_value = str(cell_value) if cell_value is not None else ""
                    cell.text = display_value

                    # Row background
                    cell.fill.solid()
                    cell.fill.fore_color.rgb = self._RGBColor(*row_bg)

                    # Data cell text styling
                    paragraph = cell.text_frame.paragraphs[0]
                    paragraph.font.size = self._Pt(10)
                    paragraph.font.name = "微软雅黑"
                    paragraph.font.color.rgb = self._RGBColor(30, 41, 59)  # Slate-800

                    # Center numeric columns, left-align text
                    if isinstance(cell_value, (int, float)) or (isinstance(cell_value, str) and cell_value.replace('.', '').replace('%', '').isdigit()):
                        paragraph.alignment = self._PP_ALIGN.CENTER
                    else:
                        paragraph.alignment = self._PP_ALIGN.LEFT

                    # Vertical alignment
                    cell.vertical_anchor = self._MSO_ANCHOR.MIDDLE

        logger.info(f"Rendered professional table: {num_rows} rows x {num_cols} cols")

    def _render_bar_chart(
        self,
        slide,
        chart_data: Dict[str, Any],
        position: Optional[Dict[str, float]] = None
    ) -> None:
        """Render a professional bar/column chart with enhanced styling.

        Args:
            slide: pptx slide object
            chart_data: Dict with 'categories' (list), 'series' (list of dicts with 'name' and 'values')
            position: Dict with 'left', 'top', 'width', 'height' in inches
        """
        if not chart_data or 'categories' not in chart_data or 'series' not in chart_data:
            logger.warning("Invalid bar chart data format")
            return

        categories = chart_data['categories']
        series_list = chart_data['series']

        if not categories or not series_list:
            logger.warning("Empty bar chart data")
            return

        # Default position if not specified
        if position is None:
            position = {'left': 0.8, 'top': 2.0, 'width': 8.5, 'height': 4.5}

        # Create chart data
        chart_data_obj = self._CategoryChartData()
        chart_data_obj.categories = categories

        for series in series_list:
            series_name = series.get('name', 'Series')
            series_values = series.get('values', [])
            chart_data_obj.add_series(series_name, series_values)

        # Add chart to slide
        left = self._Inches(position.get('left', 0.8))
        top = self._Inches(position.get('top', 2.0))
        width = self._Inches(position.get('width', 8.5))
        height = self._Inches(position.get('height', 4.5))

        chart_shape = slide.shapes.add_chart(
            self._XL_CHART_TYPE.COLUMN_CLUSTERED,
            left, top, width, height,
            chart_data_obj
        )
        chart = chart_shape.chart

        text_color = ChartColors.TEXT_LIGHT_THEME
        axis_text_color = (71, 85, 105)  # Slate-500

        # Enhanced styling
        # Set chart title if provided
        if 'title' in chart_data and chart_data['title']:
            chart.has_title = True
            chart.chart_title.text_frame.text = chart_data['title']
            chart.chart_title.text_frame.paragraphs[0].font.size = self._Pt(14)
            chart.chart_title.text_frame.paragraphs[0].font.bold = True
            chart.chart_title.text_frame.paragraphs[0].font.color.rgb = self._RGBColor(*text_color)

        # Style the series with professional colors
        for idx, series in enumerate(chart.series):
            color = ChartColors.MULTI_SERIES[idx % len(ChartColors.MULTI_SERIES)]
            series.format.fill.solid()
            series.format.fill.fore_color.rgb = self._RGBColor(*color)

            # Add data labels
            series.has_data_labels = True
            data_labels = series.data_labels
            data_labels.font.size = self._Pt(9)
            data_labels.font.color.rgb = self._RGBColor(*text_color)
            data_labels.number_format = '#,##0'

        # Configure legend
        chart.has_legend = len(series_list) > 1
        if chart.has_legend:
            chart.legend.position = self._XL_LEGEND_POSITION.BOTTOM
            chart.legend.include_in_layout = False
            chart.legend.font.size = self._Pt(10)
            chart.legend.font.color.rgb = self._RGBColor(*text_color)

        # Style category axis
        category_axis = chart.category_axis
        category_axis.tick_labels.font.size = self._Pt(10)
        category_axis.tick_labels.font.color.rgb = self._RGBColor(*axis_text_color)

        # Style value axis
        value_axis = chart.value_axis
        value_axis.tick_labels.font.size = self._Pt(9)
        value_axis.tick_labels.font.color.rgb = self._RGBColor(*axis_text_color)
        value_axis.has_major_gridlines = True

        logger.info(f"Rendered professional bar chart with {len(categories)} categories and {len(series_list)} series")

    def _render_pie_chart(
        self,
        slide,
        chart_data: Dict[str, Any],
        position: Optional[Dict[str, float]] = None
    ) -> None:
        """Render a professional pie chart with enhanced styling.

        Args:
            slide: pptx slide object
            chart_data: Dict with 'categories' (list) and 'values' (list)
            position: Dict with 'left', 'top', 'width', 'height' in inches
        """
        if not chart_data or 'categories' not in chart_data or 'values' not in chart_data:
            logger.warning("Invalid pie chart data format")
            return

        categories = chart_data['categories']
        values = chart_data['values']

        if not categories or not values or len(categories) != len(values):
            logger.warning("Invalid or mismatched pie chart data")
            return

        # Default position if not specified
        if position is None:
            position = {'left': 2.0, 'top': 2.0, 'width': 6.0, 'height': 4.5}

        # Create chart data
        chart_data_obj = self._CategoryChartData()
        chart_data_obj.categories = categories
        chart_data_obj.add_series('', values)

        # Add chart to slide
        left = self._Inches(position.get('left', 2.0))
        top = self._Inches(position.get('top', 2.0))
        width = self._Inches(position.get('width', 6.0))
        height = self._Inches(position.get('height', 4.5))

        chart_shape = slide.shapes.add_chart(
            self._XL_CHART_TYPE.PIE,
            left, top, width, height,
            chart_data_obj
        )
        chart = chart_shape.chart

        text_color = ChartColors.TEXT_LIGHT_THEME

        # Enhanced styling
        # Set chart title if provided
        if 'title' in chart_data and chart_data['title']:
            chart.has_title = True
            chart.chart_title.text_frame.text = chart_data['title']
            chart.chart_title.text_frame.paragraphs[0].font.size = self._Pt(14)
            chart.chart_title.text_frame.paragraphs[0].font.bold = True
            chart.chart_title.text_frame.paragraphs[0].font.color.rgb = self._RGBColor(*text_color)

        # Get color scheme - use severity colors if categories match severity levels
        severity_keywords = ['严重', '高危', '中危', '低危', '信息', 'critical', 'high', 'medium', 'low', 'info']
        use_severity_colors = any(kw in str(cat).lower() for cat in categories for kw in severity_keywords)

        # Style pie slices with professional colors
        plot = chart.plots[0]
        for idx, point in enumerate(plot.series[0].points):
            if use_severity_colors:
                # Map category to severity color
                cat_lower = str(categories[idx]).lower()
                if '严重' in cat_lower or 'critical' in cat_lower:
                    color = ChartColors.SEVERITY['critical']
                elif '高危' in cat_lower or 'high' in cat_lower:
                    color = ChartColors.SEVERITY['high']
                elif '中危' in cat_lower or 'medium' in cat_lower:
                    color = ChartColors.SEVERITY['medium']
                elif '低危' in cat_lower or 'low' in cat_lower:
                    color = ChartColors.SEVERITY['low']
                else:
                    color = ChartColors.SEVERITY['info']
            else:
                color = ChartColors.MULTI_SERIES[idx % len(ChartColors.MULTI_SERIES)]

            point.format.fill.solid()
            point.format.fill.fore_color.rgb = self._RGBColor(*color)

        # Add data labels with percentages
        plot.has_data_labels = True
        data_labels = plot.data_labels
        data_labels.show_category_name = True
        data_labels.show_percentage = True
        data_labels.show_value = False
        data_labels.font.size = self._Pt(10)
        data_labels.font.color.rgb = self._RGBColor(*text_color)
        data_labels.number_format = '0.0%'

        # Configure legend
        chart.has_legend = True
        chart.legend.position = self._XL_LEGEND_POSITION.RIGHT
        chart.legend.include_in_layout = False
        chart.legend.font.size = self._Pt(10)
        chart.legend.font.color.rgb = self._RGBColor(*text_color)

        logger.info(f"Rendered professional pie chart with {len(categories)} categories")

    def _render_p11_bar(
        self,
        slide,
        chart_data: Dict[str, Any],
        token: str = None
    ) -> None:
        """Render P11 response time bar chart (处置时间柱状图).

        This function looks for an existing chart in the slide and updates its data,
        preserving the manually configured layout and styling.

        The chart is located by finding the placeholder token, then searching for
        the nearest bar/column chart to that placeholder's position.

        Style specifications:
        - Bar color: RGB(68, 114, 196) - professional blue
        - Data labels on top of each bar (显示具体数值)
        - Legend at top: "平均处置时间（分钟）"
        - Y-axis with smart scaling based on data range
        - No gridlines, clean minimal design

        Args:
            slide: pptx slide object
            chart_data: Dict with 'categories', 'series', 'position'
            token: Token name to locate the placeholder (e.g., "abc")
        """
        if not chart_data or 'categories' not in chart_data or 'series' not in chart_data:
            logger.warning("Invalid P11_bar chart data format")
            return

        categories = chart_data['categories']
        series_list = chart_data['series']

        if not categories or not series_list:
            logger.warning("Empty P11_bar chart data")
            return

        # Find placeholder position first (if token provided)
        placeholder_position = None
        placeholder_shape_to_remove = None

        if token:
            import re
            placeholder_pattern = re.compile(r'\{\{[^}]+\}\}')

            # More flexible pattern: match {{...}} or {{... (missing closing brace)
            
            for shape in slide.shapes:
                try:
                    if hasattr(shape, 'has_text_frame') and shape.has_text_frame:
                        full_text = ''.join(
                            run.text for paragraph in shape.text_frame.paragraphs
                            for run in paragraph.runs
                        ).strip()

                        if placeholder_pattern.fullmatch(full_text):
                            # Found a placeholder, record its position and the shape for removal
                            placeholder_position = (shape.left, shape.top)
                            placeholder_shape_to_remove = shape
                            logger.info(f"Found placeholder '{full_text}' at position ({shape.left}, {shape.top})")
                            break
                except:
                    continue

        # Find existing chart in the slide - look for BAR chart specifically
        # If placeholder was found, find the nearest chart to it
        chart_shape = None
        chart = None
        min_distance = float('inf')

        for shape in slide.shapes:
            try:
                if shape.has_chart:
                    # Try to access the chart to verify it's not an external link
                    try:
                        temp_chart = shape.chart  # Get chart reference immediately
                        # Check if it's a bar/column chart type
                        if temp_chart.chart_type in (
                            self._XL_CHART_TYPE.COLUMN_CLUSTERED,
                            self._XL_CHART_TYPE.COLUMN_STACKED,
                            self._XL_CHART_TYPE.BAR_CLUSTERED,
                            self._XL_CHART_TYPE.BAR_STACKED
                        ):
                            # If we have a placeholder position, find nearest chart
                            if placeholder_position:
                                chart_pos = (shape.left, shape.top)
                                distance = ((chart_pos[0] - placeholder_position[0]) ** 2 +
                                          (chart_pos[1] - placeholder_position[1]) ** 2) ** 0.5

                                if distance < min_distance:
                                    min_distance = distance
                                    chart = temp_chart
                                    chart_shape = shape
                                    logger.info(f"Found bar chart at distance {distance} from placeholder")
                            else:
                                # No placeholder, just use first chart found
                                chart = temp_chart
                                chart_shape = shape
                                logger.info(f"Found bar chart for P11_bar (no placeholder)")
                                break
                    except Exception as chart_error:
                        # This shape has a chart but it's external or inaccessible
                        logger.debug(f"Skipping chart shape with external link: {chart_error}")
                        continue
            except Exception as e:
                # Skip shapes that cause errors when checking has_chart
                logger.debug(f"Skipping shape due to error: {e}")
                continue

        # Try to update chart if found
        if chart_shape and chart:
            try:

                # Create chart data
                chart_data_obj = self._CategoryChartData()
                chart_data_obj.categories = categories

                for series in series_list:
                    series_name = series.get('name', '平均处置时间（分钟）')
                    series_values = series.get('values', [])
                    chart_data_obj.add_series(series_name, series_values)

                # Replace chart data
                chart.replace_data(chart_data_obj)

                # P11-specific styling
                p11_bar_color = (68, 114, 196)  # Professional blue

                # Remove default chart title (we only want the legend)
                chart.has_title = False

                # Style the series
                for series in chart.series:
                    # Apply bar color
                    series.format.fill.solid()
                    series.format.fill.fore_color.rgb = self._RGBColor(*p11_bar_color)

                    # Add data labels on top of bars - MUST show values
                    series.has_data_labels = True
                    data_labels = series.data_labels
                    data_labels.position = self._XL_LABEL_POSITION.OUTSIDE_END
                    data_labels.show_value = True  # Explicitly show values
                    data_labels.font.size = self._Pt(9)  # Smaller font size
                    data_labels.font.color.rgb = self._RGBColor(51, 51, 51)  # Dark gray
                    data_labels.font.name = "微软雅黑"
                    data_labels.number_format = '0.00'  # Show 2 decimal places

                # Configure legend (at top, smaller text)
                chart.has_legend = True
                chart.legend.position = self._XL_LEGEND_POSITION.TOP
                chart.legend.include_in_layout = False
                chart.legend.font.size = self._Pt(10)
                chart.legend.font.name = "微软雅黑"
                chart.legend.font.color.rgb = self._RGBColor(102, 102, 102)  # Gray, less prominent

                # Style category axis (X-axis)
                category_axis = chart.category_axis
                category_axis.tick_labels.font.size = self._Pt(11)
                category_axis.tick_labels.font.name = "微软雅黑"
                category_axis.tick_labels.font.color.rgb = self._RGBColor(51, 51, 51)
                category_axis.has_major_gridlines = False

                # Style value axis (Y-axis) - NO gridlines, NO axis line, show all tick marks
                value_axis = chart.value_axis
                value_axis.tick_labels.font.size = self._Pt(10)
                value_axis.tick_labels.font.name = "微软雅黑"
                value_axis.tick_labels.font.color.rgb = self._RGBColor(102, 102, 102)  # Gray
                value_axis.has_major_gridlines = False  # No gridlines per user requirement

                # Remove Y-axis line (keep only tick labels)
                try:
                    value_axis.format.line.fill.background()
                except:
                    pass  # If this fails, axis line will remain

                # Smart Y-axis configuration based on data range
                # Find max value to determine appropriate scale
                max_value = max(max(s['values']) for s in series_list if s.get('values'))

                # Calculate appropriate major unit (interval between tick marks)
                # Dynamically determine major_unit based on max_value for better readability
                if max_value <= 100:
                    major_unit = 20
                    max_bound = ((max_value // 20) + 1) * 20
                elif max_value <= 500:
                    # For values 100-500: use 100 as interval (show 0, 100, 200, 300, 400, 500)
                    major_unit = 100
                    max_bound = ((int(max_value) // 100) + 2) * 100
                elif max_value <= 1000:
                    # For values 500-1000: use 200 as interval (show 0, 200, 400, 600, 800, 1000)
                    major_unit = 200
                    max_bound = ((int(max_value) // 200) + 1) * 200
                elif max_value <= 5000:
                    # For values 1000-5000: use 500 or 1000 as interval
                    major_unit = 500
                    max_bound = ((int(max_value) // 500) + 1) * 500
                else:
                    # For very large values (>5000): use 1000 as interval
                    major_unit = 1000
                    max_bound = ((int(max_value) // 1000) + 1) * 1000

                value_axis.minimum_scale = 0
                value_axis.maximum_scale = max_bound
                value_axis.major_unit = major_unit

                # Format Y-axis tick labels with 2 decimal places (e.g., 0.00, 100.00, 200.00)
                value_axis.tick_labels.number_format = '0.00'
                value_axis.visible = True  # Ensure axis is visible

                # Try to set tick label spacing to 1 (show every label)
                # PowerPoint defaults to skipping labels to avoid crowding
                # We need to set tickLblSkip in the underlying XML
                try:
                    # Access the underlying chart XML
                    axis_xml = value_axis._element

                    # The namespace for chart elements
                    ns = {'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart'}

                    # Find or create tickLblSkip element
                    tick_lbl_skip = axis_xml.find('.//c:tickLblSkip', ns)

                    if tick_lbl_skip is not None:
                        # Element exists, set to 1 (show all labels)
                        tick_lbl_skip.set('val', '1')
                        logger.info("Set existing tickLblSkip to 1")
                    else:
                        # Element doesn't exist, we need to create it
                        # Find a reference point (scaling element)
                        scaling = axis_xml.find('.//c:scaling', ns)
                        if scaling is not None:
                            from lxml import etree
                            # Create tickLblSkip element
                            tick_lbl_skip = etree.Element(
                                '{http://schemas.openxmlformats.org/drawingml/2006/chart}tickLblSkip',
                                nsmap={'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart'}
                            )
                            tick_lbl_skip.set('val', '1')

                            # Insert after scaling element
                            parent = scaling.getparent()
                            idx = list(parent).index(scaling)
                            parent.insert(idx + 1, tick_lbl_skip)
                            logger.info("Created new tickLblSkip element with val=1")
                except Exception as e:
                    logger.warning(f"Could not set tick label spacing via XML: {e}")

                # Set minor unit to None to avoid label crowding
                try:
                    value_axis.minor_unit = None
                except:
                    pass  # Some versions may not support setting minor_unit to None

                logger.info(f"Updated existing P11_bar chart with {len(categories)} categories")

            except Exception as e:
                logger.error(f"Failed to update P11_bar chart: {e}")
                # Don't return - continue to remove placeholder
        else:
            logger.warning("No existing chart found in slide for P11_bar")

        # Remove the placeholder text box if we found it earlier
        if placeholder_shape_to_remove:
            try:
                sp = placeholder_shape_to_remove.element
                sp.getparent().remove(sp)
                logger.info(f"Successfully removed placeholder text box for P11_bar")
            except Exception as e:
                logger.error(f"Failed to remove placeholder: {e}")

    def _render_p11_pie(
        self,
        slide,
        chart_data: Dict[str, Any],
        token: str = None
    ) -> None:
        """Render P11 donut pie chart (威胁类型分布饼图).

        This function looks for an existing chart in the slide and updates its data,
        preserving the manually configured layout and legend position.

        The chart is located by finding the placeholder token, then searching for
        the nearest pie/doughnut chart to that placeholder's position.

        Style specifications:
        - Donut chart (pie with hole in center)
        - Custom colors: 挖矿(68,114,196), 僵尸网络(49,134,155), 木马(167,104,60),
          账号爆破(178,128,44), 代理工具(229,99,22)
        - Legend on right side with category names
        - Data labels showing percentages
        - Clean, minimal design

        Args:
            slide: pptx slide object
            chart_data: Dict with 'categories', 'values', 'position'
            token: Token name to locate the placeholder (e.g., "P12_PIE_CHART")
        """
        if not chart_data or 'categories' not in chart_data or 'values' not in chart_data:
            logger.warning("Invalid P11_pie chart data format")
            return

        categories = chart_data['categories']
        values = chart_data['values']

        if not categories or not values or len(categories) != len(values):
            logger.warning("Invalid or mismatched P11_pie chart data")
            return

        # Find placeholder position first (if token provided)
        placeholder_position = None
        placeholder_shape_to_remove = None

        if token:
            import re
            # More flexible pattern: match {{...}} or {{... (missing closing brace)
            placeholder_pattern = re.compile(r'\{\{[^}]+\}?\}?')

            for shape in slide.shapes:
                try:
                    if hasattr(shape, 'has_text_frame') and shape.has_text_frame:
                        full_text = ''.join(
                            run.text for paragraph in shape.text_frame.paragraphs
                            for run in paragraph.runs
                        ).strip()

                        if placeholder_pattern.fullmatch(full_text):
                            # Found a placeholder, record its position and the shape for removal
                            placeholder_position = (shape.left, shape.top)
                            placeholder_shape_to_remove = shape
                            logger.info(f"Found placeholder '{full_text}' at position ({shape.left}, {shape.top})")
                            break
                except:
                    continue

        # Find existing chart in the slide - look for PIE/DOUGHNUT chart specifically
        # If placeholder was found, find the nearest chart to it
        chart_shape = None
        chart = None
        min_distance = float('inf')

        for shape in slide.shapes:
            try:
                if shape.has_chart:
                    # Try to access the chart to verify it's not an external link
                    try:
                        temp_chart = shape.chart  # Get chart reference immediately
                        # Check if it's a pie or doughnut chart type
                        if temp_chart.chart_type in (
                            self._XL_CHART_TYPE.PIE,
                            self._XL_CHART_TYPE.DOUGHNUT,
                            self._XL_CHART_TYPE.PIE_EXPLODED,
                            self._XL_CHART_TYPE.DOUGHNUT_EXPLODED
                        ):
                            # If we have a placeholder position, find nearest chart
                            if placeholder_position:
                                chart_pos = (shape.left, shape.top)
                                distance = ((chart_pos[0] - placeholder_position[0]) ** 2 +
                                          (chart_pos[1] - placeholder_position[1]) ** 2) ** 0.5

                                if distance < min_distance:
                                    min_distance = distance
                                    chart = temp_chart
                                    chart_shape = shape
                                    logger.info(f"Found pie chart at distance {distance} from placeholder")
                            else:
                                # No placeholder, just use first chart found
                                chart = temp_chart
                                chart_shape = shape
                                logger.info(f"Found pie/doughnut chart for P11_pie (no placeholder)")
                                break
                    except Exception as chart_error:
                        # This shape has a chart but it's external or inaccessible
                        logger.debug(f"Skipping chart shape with external link: {chart_error}")
                        continue
            except Exception as e:
                # Skip shapes that cause errors when checking has_chart
                logger.debug(f"Skipping shape due to error: {e}")
                continue

        # Try to update chart if found
        if chart_shape and chart:
            try:

                # Update chart data
                chart_data_obj = self._CategoryChartData()
                chart_data_obj.categories = categories
                chart_data_obj.add_series('', values)

                # Replace chart data
                chart.replace_data(chart_data_obj)

                # P12-specific colors (matching the uploaded image - threat type distribution)
                p12_colors = [
                    (68, 114, 196),    # 挖矿 - Blue
                    (49, 134, 155),    # 僵尸网络 - Teal/Cyan
                    (167, 104, 60),    # 木马 - Brown
                    (178, 128, 44),    # 账号爆破 - Olive/Dark Yellow
                    (229, 99, 22),     # 代理工具 - Orange
                ]

                # Style pie slices with custom colors and white borders for separation
                plot = chart.plots[0]
                for idx, point in enumerate(plot.series[0].points):
                    if idx < len(p12_colors):
                        color = p12_colors[idx]
                        point.format.fill.solid()
                        point.format.fill.fore_color.rgb = self._RGBColor(*color)

                        # Add white border between slices for better visual separation
                        line = point.format.line
                        line.color.rgb = self._RGBColor(255, 255, 255)  # White border
                        line.width = self._Pt(2)  # 2pt border width

                # Update data labels with percentages (smaller font)
                plot.has_data_labels = True
                data_labels = plot.data_labels
                data_labels.show_category_name = False
                data_labels.show_percentage = True
                data_labels.show_value = False
                data_labels.font.size = self._Pt(9)  # Smaller font for percentages
                data_labels.font.name = "微软雅黑"
                data_labels.font.color.rgb = self._RGBColor(51, 51, 51)
                data_labels.number_format = '0%'

                # Update legend styling (position should already be set in template)
                if chart.has_legend:
                    chart.legend.font.size = self._Pt(10)
                    chart.legend.font.name = "微软雅黑"
                    chart.legend.font.color.rgb = self._RGBColor(51, 51, 51)

                logger.info(f"Updated existing P11_pie donut chart with {len(categories)} categories")

            except Exception as e:
                logger.error(f"Failed to update chart: {e}")
                # Don't return - continue to remove placeholder
        else:
            logger.warning("No existing chart found in slide for P11_pie")

        # Remove the placeholder text box if we found it earlier
        if placeholder_shape_to_remove:
            try:
                sp = placeholder_shape_to_remove.element
                sp.getparent().remove(sp)
                logger.info(f"Successfully removed placeholder text box for P11_pie")
            except Exception as e:
                logger.error(f"Failed to remove placeholder: {e}")

    def _render_p13_pie(
        self,
        slide,
        chart_data: Dict[str, Any],
        token: str = None
    ) -> None:
        """Render P13 donut pie chart (资产类型分布饼图).

        This function looks for an existing chart in the slide and updates its data,
        preserving the manually configured layout and legend position.

        The chart is located by finding the placeholder token, then searching for
        the nearest pie/doughnut chart to that placeholder's position.

        Style specifications:
        - Donut chart (pie with hole in center)
        - Custom colors: 服务器(72,116,203), 终端(238,130,47), 网络设备(117,189,66),
          安全设备(242,186,2), 物联网设备(48,192,180)
        - Legend on right side with category names
        - Data labels showing percentages
        - Clean, minimal design

        Args:
            slide: pptx slide object
            chart_data: Dict with 'categories', 'values', 'position'
            token: Token name to locate the placeholder (e.g., "SEVERITY_PIE_CHART")
        """
        if not chart_data or 'categories' not in chart_data or 'values' not in chart_data:
            logger.warning("Invalid P13_pie chart data format")
            return

        categories = chart_data['categories']
        values = chart_data['values']

        if not categories or not values or len(categories) != len(values):
            logger.warning("Invalid or mismatched P13_pie chart data")
            return

        # Find placeholder position first (if token provided)
        placeholder_position = None
        placeholder_shape_to_remove = None

        if token:
            import re
            # More flexible pattern: match {{...}} or {{... (missing closing brace)
            placeholder_pattern = re.compile(r'\{\{[^}]+\}?\}?')

            for shape in slide.shapes:
                try:
                    if hasattr(shape, 'has_text_frame') and shape.has_text_frame:
                        full_text = ''.join(
                            run.text for paragraph in shape.text_frame.paragraphs
                            for run in paragraph.runs
                        ).strip()

                        if placeholder_pattern.fullmatch(full_text):
                            # Found a placeholder, record its position and the shape for removal
                            placeholder_position = (shape.left, shape.top)
                            placeholder_shape_to_remove = shape
                            logger.info(f"Found placeholder '{full_text}' at position ({shape.left}, {shape.top})")
                            break
                except:
                    continue

        # Find existing chart in the slide - look for PIE/DOUGHNUT chart specifically
        # If placeholder was found, find the nearest chart to it
        chart_shape = None
        chart = None
        min_distance = float('inf')

        for shape in slide.shapes:
            try:
                if shape.has_chart:
                    # Try to access the chart to verify it's not an external link
                    try:
                        temp_chart = shape.chart  # Get chart reference immediately
                        # Check if it's a pie or doughnut chart type
                        if temp_chart.chart_type in (
                            self._XL_CHART_TYPE.PIE,
                            self._XL_CHART_TYPE.DOUGHNUT,
                            self._XL_CHART_TYPE.PIE_EXPLODED,
                            self._XL_CHART_TYPE.DOUGHNUT_EXPLODED
                        ):
                            # If we have a placeholder position, find nearest chart
                            if placeholder_position:
                                chart_pos = (shape.left, shape.top)
                                distance = ((chart_pos[0] - placeholder_position[0]) ** 2 +
                                          (chart_pos[1] - placeholder_position[1]) ** 2) ** 0.5

                                if distance < min_distance:
                                    min_distance = distance
                                    chart = temp_chart
                                    chart_shape = shape
                                    logger.info(f"Found pie chart at distance {distance} from placeholder")
                            else:
                                # No placeholder, just use first chart found
                                chart = temp_chart
                                chart_shape = shape
                                logger.info(f"Found pie/doughnut chart for P13_pie (no placeholder)")
                                break
                    except Exception as chart_error:
                        # This shape has a chart but it's external or inaccessible
                        logger.debug(f"Skipping chart shape with external link: {chart_error}")
                        continue
            except Exception as e:
                # Skip shapes that cause errors when checking has_chart
                logger.debug(f"Skipping shape due to error: {e}")
                continue

        # Try to update chart if found
        if chart_shape and chart:
            try:

                # Update chart data
                chart_data_obj = self._CategoryChartData()
                chart_data_obj.categories = categories
                chart_data_obj.add_series('', values)

                # Replace chart data
                chart.replace_data(chart_data_obj)

                # P13-specific colors (matching the uploaded image)
                p13_colors = [
                    (72, 116, 203),    # 服务器 - Blue
                    (238, 130, 47),    # 终端 - Orange
                    (117, 189, 66),    # 网络设备 - Green
                    (242, 186, 2),     # 安全设备 - Yellow
                    (48, 192, 180),    # 物联网设备 - Teal
                ]

                # Style pie slices with custom colors and white borders for separation
                plot = chart.plots[0]
                for idx, point in enumerate(plot.series[0].points):
                    if idx < len(p13_colors):
                        color = p13_colors[idx]
                        point.format.fill.solid()
                        point.format.fill.fore_color.rgb = self._RGBColor(*color)

                        # Add white border between slices for better visual separation
                        line = point.format.line
                        line.color.rgb = self._RGBColor(255, 255, 255)  # White border
                        line.width = self._Pt(2)  # 2pt border width

                # Update data labels with percentages (smaller font)
                plot.has_data_labels = True
                data_labels = plot.data_labels
                data_labels.show_category_name = False
                data_labels.show_percentage = True
                data_labels.show_value = False
                data_labels.font.size = self._Pt(9)  # Smaller font for percentages
                data_labels.font.name = "微软雅黑"
                data_labels.font.color.rgb = self._RGBColor(51, 51, 51)
                data_labels.number_format = '0%'

                # Update legend styling (position should already be set in template)
                if chart.has_legend:
                    chart.legend.font.size = self._Pt(10)
                    chart.legend.font.name = "微软雅黑"
                    chart.legend.font.color.rgb = self._RGBColor(51, 51, 51)

                logger.info(f"Updated existing P13_pie donut chart with {len(categories)} categories")

            except Exception as e:
                logger.error(f"Failed to update chart: {e}")
                # Don't return - continue to remove placeholder
        else:
            logger.warning("No existing chart found in slide for P13_pie")

        # Remove the placeholder text box if we found it earlier
        if placeholder_shape_to_remove:
            try:
                sp = placeholder_shape_to_remove.element
                sp.getparent().remove(sp)
                logger.info(f"Successfully removed placeholder text box for P13_pie")
            except Exception as e:
                logger.error(f"Failed to remove placeholder: {e}")

    def _render_p14_pie(
        self,
        slide,
        chart_data: Dict[str, Any],
        token: str = None
    ) -> None:
        """Render P14 donut pie chart (告警严重程度分布饼图 - 高危/中危/低危).

        This function looks for an existing chart in the slide and updates its data,
        preserving the manually configured layout and legend position.

        Style specifications:
        - Donut chart (pie with hole in center)
        - Custom severity colors: 高危(220,38,38 红色), 中危(234,179,8 黄色), 低危(34,197,94 绿色)
        - Legend on right side with category names
        - Data labels showing percentages
        - Clean, minimal design

        Args:
            slide: pptx slide object
            chart_data: Dict with 'categories', 'values', 'position'
            token: Token name to locate the placeholder (e.g., "P14_pie")
        """
        if not chart_data or 'categories' not in chart_data or 'values' not in chart_data:
            logger.warning("Invalid P14_pie chart data format")
            return

        categories = chart_data['categories']
        values = chart_data['values']

        if not categories or not values or len(categories) != len(values):
            logger.warning("Invalid or mismatched P14_pie chart data")
            return

        # Find placeholder position first (if token provided)
        placeholder_position = None
        placeholder_shape_to_remove = None

        if token:
            import re
            # More flexible pattern: match {{...}} or {{... (missing closing brace)
            placeholder_pattern = re.compile(r'\{\{[^}]+\}?\}?')

            for shape in slide.shapes:
                try:
                    if hasattr(shape, 'has_text_frame') and shape.has_text_frame:
                        full_text = ''.join(
                            run.text for paragraph in shape.text_frame.paragraphs
                            for run in paragraph.runs
                        ).strip()

                        if placeholder_pattern.fullmatch(full_text):
                            # Found a placeholder, record its position and the shape for removal
                            placeholder_position = (shape.left, shape.top)
                            placeholder_shape_to_remove = shape
                            logger.info(f"Found placeholder '{full_text}' at position ({shape.left}, {shape.top})")
                            break
                except:
                    continue

        # Find existing chart in the slide - look for PIE/DOUGHNUT chart specifically
        # If placeholder was found, find the nearest chart to it
        chart_shape = None
        chart = None
        min_distance = float('inf')

        for shape in slide.shapes:
            try:
                if shape.has_chart:
                    # Try to access the chart to verify it's not an external link
                    try:
                        temp_chart = shape.chart  # Get chart reference immediately
                        # Check if it's a pie or doughnut chart type
                        if temp_chart.chart_type in (
                            self._XL_CHART_TYPE.PIE,
                            self._XL_CHART_TYPE.DOUGHNUT,
                            self._XL_CHART_TYPE.PIE_EXPLODED,
                            self._XL_CHART_TYPE.DOUGHNUT_EXPLODED
                        ):
                            # If we have a placeholder position, find nearest chart
                            if placeholder_position:
                                chart_pos = (shape.left, shape.top)
                                distance = ((chart_pos[0] - placeholder_position[0]) ** 2 +
                                          (chart_pos[1] - placeholder_position[1]) ** 2) ** 0.5

                                if distance < min_distance:
                                    min_distance = distance
                                    chart = temp_chart
                                    chart_shape = shape
                                    logger.info(f"Found pie chart at distance {distance} from placeholder")
                            else:
                                # No placeholder, just use first chart found
                                chart = temp_chart
                                chart_shape = shape
                                logger.info(f"Found pie/doughnut chart for P14_pie (no placeholder)")
                                break
                    except Exception as chart_error:
                        # This shape has a chart but it's external or inaccessible
                        logger.debug(f"Skipping chart shape with external link: {chart_error}")
                        continue
            except Exception as e:
                # Skip shapes that cause errors when checking has_chart
                logger.debug(f"Skipping shape due to error: {e}")
                continue

        # Try to update chart if found
        if chart_shape and chart:
            try:

                # Update chart data
                chart_data_obj = self._CategoryChartData()
                chart_data_obj.categories = categories
                chart_data_obj.add_series('', values)

                # Replace chart data
                chart.replace_data(chart_data_obj)

                # P14-specific colors for severity levels (高危/中危/低危)
                p14_colors = [
                    (220, 38, 38),     # 高危 - Red
                    (234, 179, 8),     # 中危 - Yellow/Amber
                    (34, 197, 94),     # 低危 - Green
                ]

                # Style pie slices with custom colors and white borders for separation
                plot = chart.plots[0]
                for idx, point in enumerate(plot.series[0].points):
                    if idx < len(p14_colors):
                        color = p14_colors[idx]
                        point.format.fill.solid()
                        point.format.fill.fore_color.rgb = self._RGBColor(*color)

                        # Add white border between slices for better visual separation
                        line = point.format.line
                        line.color.rgb = self._RGBColor(255, 255, 255)  # White border
                        line.width = self._Pt(2)  # 2pt border width

                # Update data labels with percentages (smaller font)
                plot.has_data_labels = True
                data_labels = plot.data_labels
                data_labels.show_category_name = False
                data_labels.show_percentage = True
                data_labels.show_value = False
                data_labels.font.size = self._Pt(9)  # Smaller font for percentages
                data_labels.font.name = "微软雅黑"
                data_labels.font.color.rgb = self._RGBColor(51, 51, 51)
                data_labels.number_format = '0%'

                # Update legend styling (position should already be set in template)
                if chart.has_legend:
                    chart.legend.font.size = self._Pt(10)
                    chart.legend.font.name = "微软雅黑"
                    chart.legend.font.color.rgb = self._RGBColor(51, 51, 51)

                logger.info(f"Updated existing P14_pie donut chart with {len(categories)} categories")

            except Exception as e:
                logger.error(f"Failed to update chart: {e}")
                # Don't return - continue to remove placeholder
        else:
            logger.warning("No existing chart found in slide for P14_pie")

        # Remove the placeholder text box if we found it earlier
        if placeholder_shape_to_remove:
            try:
                sp = placeholder_shape_to_remove.element
                sp.getparent().remove(sp)
                logger.info(f"Successfully removed placeholder text box for P14_pie")
            except Exception as e:
                logger.error(f"Failed to remove placeholder: {e}")

    def _render_p15_pie_common(
        self,
        slide,
        chart_data: Dict[str, Any],
        token: str,
        chart_name: str,
        colors: List[Tuple[int, int, int]],
    ) -> None:
        """Render one of the P15 pie charts by updating the nearest existing pie/doughnut chart."""
        if not chart_data or 'categories' not in chart_data or 'values' not in chart_data:
            logger.warning(f"Invalid {chart_name} chart data format")
            return

        categories = chart_data.get('categories', [])
        values = chart_data.get('values', [])
        if not categories or not values or len(categories) != len(values):
            logger.warning(f"Invalid or mismatched {chart_name} chart data")
            return

        placeholder_shape_to_remove, placeholder_position = self._find_placeholder_shape(slide, token)
        chart_shape, chart = self._find_nearest_chart(
            slide,
            placeholder_position,
            {
                self._XL_CHART_TYPE.PIE,
                self._XL_CHART_TYPE.DOUGHNUT,
                self._XL_CHART_TYPE.PIE_EXPLODED,
                self._XL_CHART_TYPE.DOUGHNUT_EXPLODED,
            },
        )

        if chart_shape and chart:
            try:
                chart_data_obj = self._CategoryChartData()
                chart_data_obj.categories = categories
                chart_data_obj.add_series('', values)
                chart.replace_data(chart_data_obj)

                plot = chart.plots[0]
                for idx, point in enumerate(plot.series[0].points):
                    color = colors[idx % len(colors)]
                    point.format.fill.solid()
                    point.format.fill.fore_color.rgb = self._RGBColor(*color)
                    line = point.format.line
                    line.color.rgb = self._RGBColor(255, 255, 255)
                    line.width = self._Pt(1.5)

                plot.has_data_labels = True
                data_labels = plot.data_labels
                data_labels.show_category_name = False
                data_labels.show_percentage = True
                data_labels.show_value = False
                data_labels.font.size = self._Pt(9)
                data_labels.font.name = "微软雅黑"
                data_labels.font.color.rgb = self._RGBColor(51, 51, 51)
                data_labels.number_format = '0%'

                if chart.has_legend:
                    chart.legend.font.size = self._Pt(10)
                    chart.legend.font.name = "微软雅黑"
                    chart.legend.font.color.rgb = self._RGBColor(51, 51, 51)

                logger.info(f"Updated existing {chart_name} chart with {len(categories)} categories")
            except Exception as exc:
                logger.error(f"Failed to update {chart_name}: {exc}")
        else:
            logger.warning(f"No existing chart found in slide for {chart_name}")

        if placeholder_shape_to_remove:
            try:
                sp = placeholder_shape_to_remove.element
                sp.getparent().remove(sp)
                logger.info(f"Successfully removed placeholder text box for {chart_name}")
            except Exception as exc:
                logger.error(f"Failed to remove placeholder for {chart_name}: {exc}")

    def _render_p15_pie_1(
        self,
        slide,
        chart_data: Dict[str, Any],
        token: str = None
    ) -> None:
        self._render_p15_pie_common(
            slide,
            chart_data,
            token or "P15_pie_1",
            "P15_pie_1",
            [
                (10, 66, 117),
                (49, 130, 206),
                (72, 187, 120),
                (242, 153, 74),
                (165, 94, 234),
            ],
        )

    def _render_p15_pie_2(
        self,
        slide,
        chart_data: Dict[str, Any],
        token: str = None
    ) -> None:
        self._render_p15_pie_common(
            slide,
            chart_data,
            token or "P15_pie_2",
            "P15_pie_2",
            [
                (68, 114, 196),
                (91, 155, 213),
                (237, 125, 49),
                (165, 165, 165),
                (255, 192, 0),
            ],
        )

    def _render_p15_bar(
        self,
        slide,
        chart_data: Dict[str, Any],
        token: str = None
    ) -> None:
        """Render the P15 host TOP5 bar chart by updating the nearest existing bar/column chart."""
        if not chart_data or 'categories' not in chart_data:
            logger.warning("Invalid P15_bar chart data format")
            return

        categories = chart_data.get('categories', [])
        series_list = chart_data.get('series', [])
        if not categories or not series_list:
            logger.warning("Invalid or missing P15_bar chart data")
            return

        placeholder_shape_to_remove, placeholder_position = self._find_placeholder_shape(slide, token or "P15_bar")
        chart_shape, chart = self._find_nearest_chart(
            slide,
            placeholder_position,
            {
                self._XL_CHART_TYPE.BAR_CLUSTERED,
                self._XL_CHART_TYPE.BAR_STACKED,
                self._XL_CHART_TYPE.BAR_STACKED_100,
                self._XL_CHART_TYPE.COLUMN_CLUSTERED,
                self._XL_CHART_TYPE.COLUMN_STACKED,
                self._XL_CHART_TYPE.COLUMN_STACKED_100,
            },
        )

        if chart_shape and chart:
            try:
                chart_data_obj = self._CategoryChartData()
                chart_data_obj.categories = categories
                for series in series_list:
                    chart_data_obj.add_series(series.get('name', 'Series'), series.get('values', []))
                chart.replace_data(chart_data_obj)

                plot = chart.plots[0]
                for idx, series in enumerate(plot.series):
                    color = ChartColors.MULTI_SERIES[idx % len(ChartColors.MULTI_SERIES)]
                    series.format.fill.solid()
                    series.format.fill.fore_color.rgb = self._RGBColor(*color)
                    series.has_data_labels = True
                    data_labels = series.data_labels
                    data_labels.show_value = True
                    data_labels.font.size = self._Pt(9)
                    data_labels.font.name = "微软雅黑"
                    data_labels.font.color.rgb = self._RGBColor(51, 51, 51)
                    data_labels.number_format = '#,##0'

                if chart.has_legend:
                    chart.legend.font.size = self._Pt(10)
                    chart.legend.font.name = "微软雅黑"
                    chart.legend.font.color.rgb = self._RGBColor(51, 51, 51)

                logger.info(f"Updated existing P15_bar chart with {len(categories)} categories")
            except Exception as exc:
                logger.error(f"Failed to update P15_bar chart: {exc}")
        else:
            logger.warning("No existing chart found in slide for P15_bar")

        if placeholder_shape_to_remove:
            try:
                sp = placeholder_shape_to_remove.element
                sp.getparent().remove(sp)
                logger.info("Successfully removed placeholder text box for P15_bar")
            except Exception as exc:
                logger.error(f"Failed to remove placeholder for P15_bar: {exc}")

    def _render_p15_line(
        self,
        slide,
        chart_data: Dict[str, Any],
        token: str = None
    ) -> None:
        """Render P15 line chart (月度威胁趋势折线图 - 外部攻击数和恶意外联数).

        This function looks for an existing chart in the slide and updates its data,
        preserving the manually configured layout and legend position.

        Style specifications:
        - Line chart with two series (dual-line)
        - Series 1: External attacks (外部攻击数)
        - Series 2: Malicious outbound (恶意外联数)
        - X-axis: 12 months
        - Custom colors for each series
        - Data labels optional
        - Clean, minimal design

        Args:
            slide: pptx slide object
            chart_data: Dict with 'months', 'external_attacks', 'malicious_outbound'
            token: Token name to locate the placeholder (e.g., "P15_line")
        """
        if not chart_data or 'months' not in chart_data:
            logger.warning("Invalid P15_line chart data format")
            return

        months = chart_data.get('months', [])
        external_attacks = chart_data.get('external_attacks', [])
        malicious_outbound = chart_data.get('malicious_outbound', [])

        if not months or not external_attacks or not malicious_outbound:
            logger.warning("Invalid or missing P15_line chart data")
            return

        placeholder_shape_to_remove, placeholder_position = self._find_placeholder_shape(slide, token or "P15_line")
        chart_shape, chart = self._find_nearest_chart(
            slide,
            placeholder_position,
            {
                self._XL_CHART_TYPE.LINE,
                self._XL_CHART_TYPE.LINE_MARKERS,
                self._XL_CHART_TYPE.LINE_MARKERS_STACKED,
                self._XL_CHART_TYPE.LINE_STACKED,
            },
        )

        # Try to update chart if found
        if chart_shape and chart:
            try:
                # Update chart data with two series
                chart_data_obj = self._CategoryChartData()
                chart_data_obj.categories = months

                # Add two series
                chart_data_obj.add_series('外部攻击数', external_attacks)
                chart_data_obj.add_series('恶意外联数', malicious_outbound)

                # Replace chart data
                try:
                    chart.replace_data(chart_data_obj)
                except Exception as replace_error:
                    # Chart has external data source - try to access chart part to embed it
                    logger.warning(f"Cannot replace external chart data directly: {replace_error}")
                    logger.info("Attempting to work with existing data series...")
                    # If chart has external data, we can't replace_data
                    # But we can still style existing series and modify labels
                    if len(chart.plots) == 0 or len(chart.plots[0].series) < 2:
                        raise Exception("Chart does not have 2 series to update")

                # Style line series - keep original colors from template
                plot = chart.plots[0]
                for idx, series in enumerate(plot.series):
                    # Don't change line colors - keep template colors
                    # series.format.line.color.rgb = ... (removed)

                    # 添加数据标签，显示"万"单位
                    series.has_data_labels = True
                    data_labels = series.data_labels

                    # Position labels ABOVE the line to avoid overlap
                    data_labels.position = self._XL_LABEL_POSITION.ABOVE

                    
                    # Critical: Set show_value to False first to avoid conflict
                    data_labels.show_value = False
                    data_labels.show_category_name = False

                    # 方案：直接设置每个数据点的标签文本
                    # 这样可以完全控制显示格式
                    try:
                        for point_idx, point in enumerate(series.points):
                            if point_idx < len(external_attacks if idx == 0 else malicious_outbound):
                                value = external_attacks[point_idx] if idx == 0 else malicious_outbound[point_idx]
                                # 格式化：整数不显示小数，小数保留1位
                                if value == int(value):
                                    # 整数，不显示小数点
                                    formatted = f"{int(value)}万"
                                else:
                                    # 小数，保留1位
                                    formatted = f"{value:.1f}万"

                                # Set text on individual point's data label
                                try:
                                    point.data_label.text_frame.text = formatted
                                    logger.info(f"Series {idx}, Point {point_idx}: set label to '{formatted}'")
                                except Exception as point_error:
                                    logger.error(f"Failed to set label for point {point_idx}: {point_error}")
                    except Exception as label_error:
                        logger.error(f"Failed to iterate through points for series {idx}: {label_error}")

                # Update legend styling (position should already be set in template)
                if chart.has_legend:
                    chart.legend.font.size = self._Pt(10)
                    chart.legend.font.name = "微软雅黑"
                    chart.legend.font.color.rgb = self._RGBColor(51, 51, 51)

                logger.info(f"Updated existing P15_line chart with {len(months)} months and 2 series")

            except Exception as e:
                logger.error(f"Failed to update chart: {e}")
                # Don't return - continue to remove placeholder
        else:
            logger.warning("No existing chart found in slide for P15_line")

        # Remove the placeholder text box if we found it earlier
        if placeholder_shape_to_remove:
            try:
                sp = placeholder_shape_to_remove.element
                sp.getparent().remove(sp)
                logger.info(f"Successfully removed placeholder text box for P15_line")
            except Exception as e:
                logger.error(f"Failed to remove placeholder: {e}")

    def _render_p26_line(
        self,
        slide,
        chart_data: Dict[str, Any],
        token: str = None
    ) -> None:
        """Render P26 vulnerability trend line chart."""
        if not chart_data or 'months' not in chart_data:
            logger.warning("Invalid P26_line chart data format")
            return

        months = chart_data.get('months', [])
        series_list = chart_data.get('series', [])
        if not months or not series_list:
            logger.warning("Invalid or missing P26_line chart data")
            return

        placeholder_shape_to_remove, placeholder_position = self._find_placeholder_shape(slide, token or "P26_line")
        chart_shape, chart = self._find_nearest_chart(
            slide,
            placeholder_position,
            {
                self._XL_CHART_TYPE.LINE,
                self._XL_CHART_TYPE.LINE_MARKERS,
                self._XL_CHART_TYPE.LINE_MARKERS_STACKED,
                self._XL_CHART_TYPE.LINE_STACKED,
            },
        )

        if chart_shape and chart:
            try:
                chart_data_obj = self._CategoryChartData()
                chart_data_obj.categories = months
                for series in series_list:
                    chart_data_obj.add_series(series.get('name', 'Series'), series.get('values', []))
                chart.replace_data(chart_data_obj)

                plot = chart.plots[0]
                for idx, series in enumerate(plot.series):
                    series.has_data_labels = True
                    data_labels = series.data_labels
                    data_labels.position = self._XL_LABEL_POSITION.ABOVE
                    data_labels.show_value = True
                    data_labels.show_category_name = False
                    data_labels.font.size = self._Pt(8)
                    data_labels.font.name = "微软雅黑"
                    data_labels.font.color.rgb = self._RGBColor(51, 51, 51)
                    data_labels.number_format = '#,##0'

                if chart.has_legend:
                    chart.legend.font.size = self._Pt(10)
                    chart.legend.font.name = "微软雅黑"
                    chart.legend.font.color.rgb = self._RGBColor(51, 51, 51)

                logger.info(f"Updated existing P26_line chart with {len(months)} months and {len(series_list)} series")
            except Exception as exc:
                logger.error(f"Failed to update P26_line chart: {exc}")
        else:
            logger.warning("No existing chart found in slide for P26_line")

        if placeholder_shape_to_remove:
            try:
                sp = placeholder_shape_to_remove.element
                sp.getparent().remove(sp)
                logger.info("Successfully removed placeholder text box for P26_line")
            except Exception as exc:
                logger.error(f"Failed to remove placeholder for P26_line: {exc}")

    def _render_p11_line(
        self,
        slide,
        chart_data: Dict[str, Any],
        token: str = None
    ) -> None:
        """Render P11 line chart (月度事件趋势折线图).

        This function looks for an existing line chart in the slide and updates its data
        with multiple series (e.g., critical, high, medium severity incidents by month).

        Style specifications:
        - Line chart with markers
        - Multiple series with different colors
        - Data labels showing counts
        - Clean, minimal design
        - Legend on top or right side

        Args:
            slide: pptx slide object
            chart_data: Dict with 'months' and 'series' (list of {name, values})
            token: Token name to locate the placeholder (e.g., "P11_line")
        """
        if not chart_data or 'months' not in chart_data or 'series' not in chart_data:
            logger.warning("Invalid P11_line chart data format")
            return

        months = chart_data.get('months', [])
        series_list = chart_data.get('series', [])

        if not months or not series_list:
            logger.warning("Invalid or missing P11_line chart data")
            return

        # Find placeholder position first (if token provided)
        placeholder_position = None
        placeholder_shape_to_remove = None

        if token:
            import re
            placeholder_pattern = re.compile(r'\{\{[^}]+\}?\}?')

            for shape in slide.shapes:
                try:
                    if hasattr(shape, 'has_text_frame') and shape.has_text_frame:
                        full_text = ''.join(
                            run.text for paragraph in shape.text_frame.paragraphs
                            for run in paragraph.runs
                        ).strip()

                        if placeholder_pattern.fullmatch(full_text):
                            placeholder_position = (shape.left, shape.top)
                            placeholder_shape_to_remove = shape
                            logger.info(f"Found placeholder '{full_text}' at position ({shape.left}, {shape.top})")
                            break
                except:
                    continue

        # Find existing line chart in the slide
        chart_shape = None
        chart = None
        min_distance = float('inf')

        def check_shape_for_line_chart(shape, parent_left=0, parent_top=0):
            """Check if a shape contains a line chart."""
            nonlocal chart, chart_shape, min_distance

            try:
                if shape.has_chart:
                    try:
                        temp_chart = shape.chart
                        if temp_chart.chart_type in (
                            self._XL_CHART_TYPE.LINE,
                            self._XL_CHART_TYPE.LINE_MARKERS,
                            self._XL_CHART_TYPE.LINE_MARKERS_STACKED,
                            self._XL_CHART_TYPE.LINE_STACKED
                        ):
                            if placeholder_position:
                                chart_pos = (parent_left + shape.left, parent_top + shape.top)
                                distance = ((chart_pos[0] - placeholder_position[0]) ** 2 +
                                          (chart_pos[1] - placeholder_position[1]) ** 2) ** 0.5

                                if distance < min_distance:
                                    min_distance = distance
                                    chart = temp_chart
                                    chart_shape = shape
                                    logger.info(f"Found line chart at distance {distance} from placeholder")
                            else:
                                chart = temp_chart
                                chart_shape = shape
                                logger.info(f"Found line chart for P11_line (no placeholder)")
                                return True
                    except Exception as chart_error:
                        logger.debug(f"Skipping chart shape with external link: {chart_error}")
            except Exception as e:
                logger.debug(f"Skipping shape due to error: {e}")

            return False

        # Search all shapes, including those inside groups
        for shape in slide.shapes:
            if shape.shape_type == 6:  # GROUP
                try:
                    for sub_shape in shape.shapes:
                        if check_shape_for_line_chart(sub_shape, shape.left, shape.top):
                            break
                except Exception as e:
                    logger.debug(f"Error searching group shape: {e}")
            else:
                if check_shape_for_line_chart(shape):
                    break

        # Update chart if found
        if chart_shape and chart:
            try:
                # Create chart data object
                chart_data_obj = self._CategoryChartData()
                chart_data_obj.categories = months

                # Add all series
                for series_info in series_list:
                    series_name = series_info.get('name', '数量')
                    series_values = series_info.get('values', [])
                    chart_data_obj.add_series(series_name, series_values)

                # Replace chart data
                try:
                    chart.replace_data(chart_data_obj)
                except Exception as replace_error:
                    logger.warning(f"Cannot replace external chart data: {replace_error}")
                    if len(chart.plots) == 0 or len(chart.plots[0].series) < len(series_list):
                        raise Exception(f"Chart does not have {len(series_list)} series to update")

                # Style line series - 保留模板原始颜色
                plot = chart.plots[0]
                for series in plot.series:
                    # 不修改线条颜色，使用模板原始颜色
                    # 不修改线宽，使用模板原始设置

                    # Add markers
                    series.marker.style = 2  # Circle marker
                    series.marker.size = 6

                    # Add data labels
                    series.has_data_labels = True
                    data_labels = series.data_labels
                    data_labels.position = self._XL_LABEL_POSITION.ABOVE
                    data_labels.show_value = True
                    data_labels.show_category_name = False
                    data_labels.font.size = self._Pt(9)
                    data_labels.font.name = "微软雅黑"
                    data_labels.font.color.rgb = self._RGBColor(51, 51, 51)
                    data_labels.number_format = '0.00'

                # Update legend
                if chart.has_legend:
                    chart.legend.position = self._XL_LEGEND_POSITION.TOP
                    chart.legend.include_in_layout = False
                    chart.legend.font.size = self._Pt(10)
                    chart.legend.font.name = "微软雅黑"
                    chart.legend.font.color.rgb = self._RGBColor(51, 51, 51)

                # Style axes
                category_axis = chart.category_axis
                category_axis.tick_labels.font.size = self._Pt(8)  # 横坐标字号更小
                category_axis.tick_labels.font.name = "微软雅黑"
                category_axis.tick_labels.font.color.rgb = self._RGBColor(51, 51, 51)
                category_axis.has_major_gridlines = False

                value_axis = chart.value_axis
                value_axis.tick_labels.font.size = self._Pt(10)
                value_axis.tick_labels.font.name = "微软雅黑"
                value_axis.tick_labels.font.color.rgb = self._RGBColor(102, 102, 102)
                value_axis.has_major_gridlines = False  # 不要网格横线
                value_axis.minimum_scale = 0

                # 保留原始轴线颜色，不做修改

                logger.info(f"Updated existing P11_line chart with {len(months)} months and {len(series_list)} series")

            except Exception as e:
                logger.error(f"Failed to update P11_line chart: {e}")
        else:
            logger.warning("No existing chart found in slide for P11_line")

        # Remove the placeholder text box
        if placeholder_shape_to_remove:
            try:
                sp = placeholder_shape_to_remove.element
                sp.getparent().remove(sp)
                logger.info(f"Successfully removed placeholder text box for P11_line")
            except Exception as e:
                logger.error(f"Failed to remove placeholder: {e}")

    def _render_p16_combo(
        self,
        slide,
        chart_data: Dict[str, Any],
        token: str = None
    ) -> None:
        """Render P16 combo chart (柱状图+折线图混合图表).

        This is a combination chart with:
        - Bar series: Daily attack count (日均攻击数) - values like 123, 145
        - Line series: Defense rate (防御率) - percentages like 100%
        - 7 data points (categories)

        The chart is located by finding the placeholder token, then searching for
        the nearest combo chart to that placeholder's position.

        Args:
            slide: pptx slide object
            chart_data: Dict with 'categories', 'attack_counts', 'defense_rates'
            token: Token name to locate the placeholder (e.g., "P16_combo")
        """
        if not chart_data or 'categories' not in chart_data:
            logger.warning("Invalid P16_combo chart data format")
            return

        categories = chart_data.get('categories', [])
        attack_counts = chart_data.get('attack_counts', [])
        defense_rates = chart_data.get('defense_rates', [])

        if not categories or not attack_counts or not defense_rates:
            logger.warning("Invalid or missing P16_combo chart data")
            return

        # Find the placeholder for this exact token. A slide can contain many
        # placeholders, so matching any ``{{...}}`` token can remove the wrong
        # text box (for example ``{{security_value2}}`` before ``{{P30_combo}}``).
        placeholder_shape_to_remove, placeholder_position = self._find_placeholder_shape(
            slide,
            token or "P16_combo",
        )

        # Find existing chart - look for combo charts (COLUMN_CLUSTERED with multiple chart types)
        chart_shape = None
        chart = None
        min_distance = float('inf')

        def check_shape_for_combo_chart(shape, parent_left=0, parent_top=0):
            """Check if a shape contains a combo chart."""
            nonlocal chart, chart_shape, min_distance

            try:
                if shape.has_chart:
                    try:
                        temp_chart = shape.chart
                        # Combo charts can be identified by having multiple plot types
                        # or by checking if chart has both bar and line series
                        # For now, we'll accept COLUMN_CLUSTERED charts as potential combo charts
                        if temp_chart.chart_type in (
                            self._XL_CHART_TYPE.COLUMN_CLUSTERED,
                            self._XL_CHART_TYPE.LINE_MARKERS,
                            self._XL_CHART_TYPE.AREA  # Combo charts may report as various types
                        ):
                            if placeholder_position:
                                chart_pos = (parent_left + shape.left, parent_top + shape.top)
                                distance = ((chart_pos[0] - placeholder_position[0]) ** 2 +
                                          (chart_pos[1] - placeholder_position[1]) ** 2) ** 0.5

                                if distance < min_distance:
                                    min_distance = distance
                                    chart = temp_chart
                                    chart_shape = shape
                                    logger.info(f"Found combo chart at distance {distance} from placeholder")
                            else:
                                chart = temp_chart
                                chart_shape = shape
                                logger.info(f"Found combo chart for P16_combo (no placeholder)")
                                return True
                    except Exception as chart_error:
                        logger.debug(f"Skipping chart shape with external link: {chart_error}")
            except Exception as e:
                logger.debug(f"Skipping shape due to error: {e}")

            return False

        # Search all shapes, including those inside groups
        for shape in slide.shapes:
            if shape.shape_type == 6:  # GROUP
                try:
                    for sub_shape in shape.shapes:
                        if check_shape_for_combo_chart(sub_shape, shape.left, shape.top):
                            break
                except Exception as e:
                    logger.debug(f"Error searching group shape: {e}")
            else:
                if check_shape_for_combo_chart(shape):
                    break

        # Try to update chart if found
        if chart_shape and chart:
            try:
                # Update chart data ONLY - preserve all template styling
                chart_data_obj = self._CategoryChartData()
                chart_data_obj.categories = categories

                # Add bar series (attack counts)
                chart_data_obj.add_series('日均攻击数', attack_counts)
                # Add line series (defense rates) - these should be decimal values (e.g., 1.0 for 100%)
                chart_data_obj.add_series('防御率', defense_rates)

                # Replace chart data only - all styling from template is preserved
                chart.replace_data(chart_data_obj)

                logger.info(f"Updated P16_combo chart with {len(categories)} categories")

            except Exception as e:
                logger.error(f"Failed to update P16_combo chart: {e}")
        else:
            logger.warning("No existing combo chart found in slide for P16_combo")

        # Remove placeholder text box if found
        if placeholder_shape_to_remove:
            try:
                sp = placeholder_shape_to_remove.element
                sp.getparent().remove(sp)
                logger.info(f"Successfully removed placeholder text box for P16_combo")
            except Exception as e:
                logger.error(f"Failed to remove placeholder: {e}")

    def _prune_empty_placeholder_shapes(
        self,
        slide,
        placeholder_tokens: Dict[str, str]
    ) -> None:
        """Remove shapes holding an empty grouped placeholder before text fill.

        Used for grouped placeholders on P37 (e.g. 安全告警定性分布 ``alert_qual_N``
        boxes and 安全事件定性分布 ``event_qual_N`` label boxes). When a group has
        fewer entries, the orchestrator leaves the corresponding token empty.
        This method must run BEFORE ``_replace_tokens_in_shape`` (the raw
        ``{{token}}`` text is still present); boxes whose token resolves to an
        empty value are deleted entirely instead of being filled with blank text.

        For the right-side 安全事件定性分布 blocks, the on-slide layout is a
        background rectangle ``ev-cN`` (empty text) with a sibling label text box
        ``ev-cN-t`` holding the placeholder. When ``ev-cN-t`` is pruned, its
        paired background rectangle is removed too (siblings sharing the ``-t``
        suffix strip).

        Args:
            slide: pptx slide object
            placeholder_tokens: mapping of token name -> replacement value;
                tokens whose value is empty/blank are the ones to prune.
        """
        empty_tokens = {
            token
            for token, value in placeholder_tokens.items()
            if (value or "").strip() == ""
        }
        if not empty_tokens:
            return

        empty_placeholders = {f"{{{{{t}}}}}" for t in empty_tokens}

        def collect(shapes, remove_targets):
            for shape in shapes:
                if shape.shape_type == 6:  # GROUP
                    try:
                        collect(shape.shapes, remove_targets)
                    except Exception:
                        continue
                    continue
                if not getattr(shape, "has_text_frame", False):
                    continue
                text = "".join(
                    run.text
                    for paragraph in shape.text_frame.paragraphs
                    for run in paragraph.runs
                ).strip()
                if text in empty_placeholders:
                    remove_targets.append(shape)

        remove_targets: List[Any] = []
        collect(slide.shapes, remove_targets)

        # Collect sibling background shapes paired with pruned `-t` label boxes.
        # e.g. pruning ``ev-c3-t`` also removes the empty ``ev-c3`` rectangle.
        # Build a name -> shape map across the slide, then for each pruned
        # ``...-t`` shape delete the sibling with the matching base name whose
        # text frame is empty (a pure background box).
        paired_shapes: List[Any] = []
        pruned_names = {
            getattr(shape, "name", "")
            for shape in remove_targets
            if getattr(shape, "name", "") and getattr(shape, "name", "").endswith("-t")
        }
        if pruned_names:
            name_to_shape: Dict[str, Any] = {}

            def index_names(shapes):
                for shape in shapes:
                    if shape.shape_type == 6:  # GROUP
                        try:
                            index_names(shape.shapes)
                        except Exception:
                            continue
                        continue
                    nm = getattr(shape, "name", "") or ""
                    if nm:
                        name_to_shape[nm] = shape

            index_names(slide.shapes)

            for label_name in pruned_names:
                base_name = label_name[:-2]  # strip trailing "-t"
                background = name_to_shape.get(base_name)
                if background is None:
                    continue
                try:
                    bg_text = (
                        background.text_frame.text
                        if background.has_text_frame
                        else ""
                    ) or ""
                except Exception:
                    bg_text = ""
                if not bg_text.strip():
                    paired_shapes.append(background)

        for shape in remove_targets:
            try:
                sp = shape.element
                sp.getparent().remove(sp)
            except Exception as exc:
                logger.warning(f"Failed to prune empty placeholder box: {exc}")

        for shape in paired_shapes:
            try:
                sp = shape.element
                sp.getparent().remove(sp)
            except Exception as exc:
                logger.warning(f"Failed to prune paired background box: {exc}")

        if remove_targets or paired_shapes:
            logger.info(
                "Pruned %d empty grouped placeholder boxes (+%d paired backgrounds)",
                len(remove_targets),
                len(paired_shapes),
            )

    def _process_chart_placeholder(
        self,
        slide,
        token: str,
        value: Any,
        chart_type: str
    ) -> bool:
        """Process a chart placeholder value using the new architecture.

        Args:
            slide: pptx slide object
            token: placeholder token name
            value: chart data (dict or special format)
            chart_type: specific chart type (e.g., 'P11_bar')

        Returns:
            True if chart was rendered, False otherwise
        """
        if not isinstance(value, dict):
            logger.warning(f"Chart placeholder {token} has invalid data type: {type(value)}")
            return False

        # Look up the renderer function for this chart type
        renderer = self._chart_renderers.get(chart_type)

        if renderer:
            try:
                renderer(slide, value, token)
                return True
            except Exception as e:
                logger.error(f"Failed to render {chart_type} for {token}: {e}")
                return False
        else:
            logger.warning(f"Unknown chart type: {chart_type}")
            return False

    def _process_table_placeholder(
        self,
        slide,
        token: str,
        value: Any
    ) -> bool:
        """Process a native table placeholder value.

        Args:
            slide: pptx slide object
            token: placeholder token name
            value: table data (dict with headers and rows)

        Returns:
            True if table was rendered, False otherwise
        """
        if not isinstance(value, dict):
            logger.warning(f"Table placeholder {token} has invalid data type: {type(value)}")
            return False

        try:
            self._render_native_table(slide, value, value.get('position'))
            return True
        except Exception as e:
            logger.error(f"Failed to render table for {token}: {e}")
            return False

    def render(self, slidespec: SlideSpecV2, output_path: Path) -> Path:
        """Render V2 slidespec to PPTX.

        Args:
            slidespec: V2 slidespec with placeholders filled
            output_path: Where to save the output PPTX

        Returns:
            Path to the saved PPTX file
        """
        template_path = self.template_repo.get_pptx_path(slidespec.template_id)
        prs = self._Presentation(template_path)

        # Load template descriptor to get placeholder types
        template_desc = self.template_repo.get_descriptor_v2(slidespec.template_id)

        # Build mapping: slide_key -> placeholder_definitions
        placeholder_types = {}
        for slide_def in template_desc.slides:
            placeholder_types[slide_def.slide_key] = {
                ph.token: ph.type for ph in slide_def.placeholders
            }

        # Build mapping: slide_no -> placeholders dict
        slides_by_no = {s.slide_no: s for s in slidespec.slides}

        for slide_no, slide_content in slides_by_no.items():
            if slide_no > len(prs.slides):
                continue

            # pptx slides are 0-indexed
            pptx_slide = prs.slides[slide_no - 1]

            # Get placeholder types for this slide
            slide_types = placeholder_types.get(slide_content.slide_key, {})

            # Separate placeholders by type
            text_placeholders = {}
            chart_placeholders = []  # Unified chart list with type info
            table_placeholders = []

            for token, value in slide_content.placeholders.items():
                ph_type = slide_types.get(token, 'text')

                # Check if it's a chart type (in the renderer mapping)
                if ph_type in self._chart_renderers:
                    chart_placeholders.append((token, value, ph_type))
                elif ph_type in ('native_table',):
                    table_placeholders.append((token, value))
                else:
                    # Regular text placeholder
                    if value is None:
                        value = ""
                    elif isinstance(value, list):
                        # Join list items with newlines
                        value = "\n".join(str(v) for v in value)
                    text_placeholders[token] = str(value)

            # Remove boxes whose placeholder resolves to an empty value
            # (e.g. unused 安全告警定性分布 slots on P37). Must run BEFORE text
            # replacement so the raw {{token}} text is still present to match.
            self._prune_empty_placeholder_shapes(pptx_slide, text_placeholders)

            # Replace text tokens in all shapes
            for shape in pptx_slide.shapes:
                self._replace_tokens_in_shape(shape, text_placeholders)
            if slide_content.slide_key == "critical_assurance":
                self._cleanup_critical_assurance_festival_paragraphs(
                    pptx_slide,
                    text_placeholders,
                )

            # Render charts (using specific renderer for each type)
            for token, value, chart_type in chart_placeholders:
                self._process_chart_placeholder(pptx_slide, token, value, chart_type)

            # Render tables
            for token, value in table_placeholders:
                self._process_table_placeholder(pptx_slide, token, value)

        # Save output
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if output_path.exists():
            try:
                output_path.unlink()
            except OSError:
                output_path = output_path.with_name(output_path.stem + "_new" + output_path.suffix)

        prs.save(output_path)
        return output_path
