#!/usr/bin/env python3
"""Generate the private admin-only alphaScreen public purchase support playbook PDF."""

from __future__ import annotations

from pathlib import Path
from typing import Iterable, Sequence

from reportlab.lib import colors
from reportlab.lib.pagesizes import landscape, letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_PATH = ROOT / "templates" / "pdf" / "alphascreen-public-purchase-support-playbook.pdf"

PAGE_WIDTH, PAGE_HEIGHT = landscape(letter)

NAVY = colors.HexColor("#0A1547")
TEXT = colors.HexColor("#273454")
MUTED = colors.HexColor("#7580A0")
BG = colors.HexColor("#F4F2FB")
PANEL = colors.HexColor("#FFFFFF")
PANEL_SOFT = colors.HexColor("#F7F4FF")
BORDER = colors.HexColor("#DDE2F0")
PURPLE = colors.HexColor("#9A70F4")
TEAL = colors.HexColor("#05D1B2")
BLUE = colors.HexColor("#08A8D8")
AMBER = colors.HexColor("#F6C45F")
RED = colors.HexColor("#E85D75")
MINT_SOFT = colors.HexColor("#E9FBF7")
AMBER_SOFT = colors.HexColor("#FFF6DF")
RED_SOFT = colors.HexColor("#FFF0F3")
BLUE_SOFT = colors.HexColor("#EAF7FC")
LAVENDER_SOFT = colors.HexColor("#F0EAFF")


def clean(text: str) -> str:
    """Keep generated PDF text ASCII-friendly and avoid smart punctuation."""
    replacements = {
        "\u2014": "-",
        "\u2013": "-",
        "\u2011": "-",
        "\u2018": "'",
        "\u2019": "'",
        "\u201c": '"',
        "\u201d": '"',
        "\u2022": "-",
        "\u203a": ">",
    }
    for source, target in replacements.items():
        text = text.replace(source, target)
    return text


def width(text: str, font: str, size: float) -> float:
    return pdfmetrics.stringWidth(clean(text), font, size)


def wrap_text(text: str, font: str, size: float, max_width: float) -> list[str]:
    words = clean(text).split()
    if not words:
        return []
    lines: list[str] = []
    current = words[0]
    for word in words[1:]:
        candidate = f"{current} {word}"
        if width(candidate, font, size) <= max_width:
            current = candidate
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


def draw_text(
    c: canvas.Canvas,
    text: str,
    x: float,
    y: float,
    *,
    size: float = 10,
    font: str = "Helvetica",
    color=TEXT,
    max_width: float | None = None,
    leading: float | None = None,
) -> float:
    c.setFont(font, size)
    c.setFillColor(color)
    if max_width is None:
        c.drawString(x, y, clean(text))
        return y - (leading or size + 3)
    line_height = leading or size + 4
    for line in wrap_text(text, font, size, max_width):
        c.drawString(x, y, line)
        y -= line_height
    return y


def draw_centered(
    c: canvas.Canvas,
    text: str,
    x: float,
    y: float,
    max_width: float,
    *,
    size: float = 10,
    font: str = "Helvetica-Bold",
    color=TEXT,
) -> None:
    c.setFont(font, size)
    c.setFillColor(color)
    lines = wrap_text(text, font, size, max_width)
    line_height = size + 3
    total = line_height * (len(lines) - 1)
    for index, line in enumerate(lines):
        line_width = width(line, font, size)
        c.drawString(x + (max_width - line_width) / 2, y - index * line_height + total / 2, line)


def rounded_rect(c: canvas.Canvas, x: float, y: float, w: float, h: float, radius: float = 12, *, fill=PANEL, stroke=BORDER, line_width: float = 1) -> None:
    c.setLineWidth(line_width)
    c.setStrokeColor(stroke)
    c.setFillColor(fill)
    c.roundRect(x, y, w, h, radius, fill=1, stroke=1)


def draw_footer(c: canvas.Canvas, page_number: int, total_pages: int) -> None:
    c.setStrokeColor(colors.HexColor("#D9DEEA"))
    c.setLineWidth(0.7)
    c.line(46, 34, PAGE_WIDTH - 46, 34)
    draw_text(c, "alphaScreen public purchase support playbook", 46, 20, size=8, font="Helvetica-Bold", color=MUTED)
    label = f"{page_number:02d} / {total_pages:02d}"
    c.setFont("Helvetica-Bold", 8)
    c.setFillColor(MUTED)
    c.drawRightString(PAGE_WIDTH - 46, 20, label)


def draw_header(c: canvas.Canvas, page_number: int, title: str, label: str, total_pages: int) -> None:
    c.setFillColor(BG)
    c.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
    rounded_rect(c, 46, 532, 38, 38, 9, fill=NAVY, stroke=NAVY)
    draw_centered(c, f"{page_number:02d}", 46, 550, 38, size=14, font="Helvetica-Bold", color=colors.white)
    draw_text(c, "ALPHASCREEN BY ALPHASOURCE", 96, 564, size=8.5, font="Helvetica-Bold", color=MUTED)
    draw_text(c, title, 96, 540, size=21, font="Helvetica-Bold", color=NAVY, max_width=470, leading=24)
    c.setFont("Helvetica-Bold", 8)
    c.setFillColor(MUTED)
    for index, line in enumerate(label.split(" / ")):
        c.drawRightString(PAGE_WIDTH - 70, 560 - index * 15, clean(line))
    draw_footer(c, page_number, total_pages)


def draw_badge(c: canvas.Canvas, text: str, x: float, y: float, *, fill=PURPLE, text_color=colors.white, font_size: float = 9, min_width: float = 0) -> float:
    pad_x = 18
    badge_w = max(min_width, width(text, "Helvetica-Bold", font_size) + pad_x * 2)
    rounded_rect(c, x, y, badge_w, 26, 13, fill=fill, stroke=fill)
    c.setFont("Helvetica-Bold", font_size)
    c.setFillColor(text_color)
    c.drawCentredString(x + badge_w / 2, y + 8, clean(text))
    return badge_w


def draw_callout(c: canvas.Canvas, title: str, body: str, x: float, y: float, w: float, h: float, *, accent=PURPLE, fill=PANEL_SOFT) -> None:
    rounded_rect(c, x, y, w, h, 12, fill=fill, stroke=fill)
    c.setFillColor(accent)
    c.roundRect(x, y, 4, h, 2, fill=1, stroke=0)
    draw_text(c, title.upper(), x + 18, y + h - 20, size=7.5, font="Helvetica-Bold", color=accent)
    draw_text(c, body, x + 18, y + h - 39, size=10, font="Helvetica-Bold", color=NAVY, max_width=w - 34, leading=13)


def draw_card(
    c: canvas.Canvas,
    title: str,
    body: str,
    x: float,
    y: float,
    w: float,
    h: float,
    *,
    accent=PURPLE,
    fill=PANEL,
    title_size: float = 11,
    body_size: float = 8.5,
) -> None:
    rounded_rect(c, x, y, w, h, 11, fill=fill, stroke=BORDER)
    c.setFillColor(accent)
    c.roundRect(x, y + h - 4, w, 4, 2, fill=1, stroke=0)
    draw_text(c, title, x + 15, y + h - 24, size=title_size, font="Helvetica-Bold", color=NAVY, max_width=w - 30, leading=13)
    draw_text(c, body, x + 15, y + h - 48, size=body_size, color=MUTED, max_width=w - 30, leading=11.5)


def draw_numbered_item(c: canvas.Canvas, number: int, title: str, body: str, x: float, y: float, w: float) -> float:
    c.setFillColor(NAVY)
    c.circle(x + 9, y - 5, 9, fill=1, stroke=0)
    c.setFont("Helvetica-Bold", 8)
    c.setFillColor(colors.white)
    c.drawCentredString(x + 9, y - 8, str(number))
    draw_text(c, title, x + 28, y, size=11, font="Helvetica-Bold", color=NAVY, max_width=w - 28, leading=13)
    return draw_text(c, body, x + 28, y - 15, size=8.8, color=MUTED, max_width=w - 28, leading=11) - 5


def draw_pill(c: canvas.Canvas, text: str, x: float, y: float, w: float, *, fill=PANEL_SOFT, stroke=BORDER, text_color=NAVY, font_size: float = 7.5) -> None:
    rounded_rect(c, x, y, w, 20, 10, fill=fill, stroke=stroke)
    draw_centered(c, text, x + 6, y + 10, w - 12, size=font_size, font="Helvetica-Bold", color=text_color)


def draw_flow(c: canvas.Canvas, labels: Sequence[str], x: float, y: float, max_width: float, *, active_index: int = 0) -> None:
    cursor_x = x
    cursor_y = y
    for index, label in enumerate(labels):
        chip_w = max(78, min(148, width(label, "Helvetica-Bold", 8.2) + 26))
        if cursor_x + chip_w > x + max_width:
            cursor_x = x
            cursor_y -= 35
        fill = PURPLE if index == active_index else PANEL
        stroke = PURPLE if index == active_index else BORDER
        text_color = colors.white if index == active_index else NAVY
        rounded_rect(c, cursor_x, cursor_y, chip_w, 26, 13, fill=fill, stroke=stroke)
        draw_centered(c, label, cursor_x + 4, cursor_y + 13, chip_w - 8, size=8.2, font="Helvetica-Bold", color=text_color)
        cursor_x += chip_w + 10
        if index < len(labels) - 1:
            c.setFont("Helvetica-Bold", 10)
            c.setFillColor(MUTED)
            c.drawString(cursor_x - 4, cursor_y + 8, ">")
            cursor_x += 12


def draw_stage_flow_cards(c: canvas.Canvas, stages: Sequence[tuple[str, str]], x: float, y: float, w: float) -> None:
    card_gap = 10
    card_w = (w - card_gap * (len(stages) - 1)) / len(stages)
    for index, (label, detail) in enumerate(stages, start=1):
        card_x = x + (index - 1) * (card_w + card_gap)
        rounded_rect(c, card_x, y, card_w, 66, 12, fill=PANEL, stroke=BORDER)
        c.setFillColor(PURPLE if index == 1 else NAVY)
        c.circle(card_x + 17, y + 47, 10, fill=1, stroke=0)
        c.setFillColor(colors.white)
        c.setFont("Helvetica-Bold", 7.5)
        c.drawCentredString(card_x + 17, y + 44, str(index))
        draw_text(c, label, card_x + 34, y + 52, size=8.3, font="Helvetica-Bold", color=NAVY, max_width=card_w - 40, leading=9.5)
        draw_text(c, detail, card_x + 12, y + 28, size=6.7, color=MUTED, max_width=card_w - 24, leading=8.4)
        if index < len(stages):
            c.setFont("Helvetica-Bold", 10)
            c.setFillColor(MUTED)
            c.drawString(card_x + card_w + 2, y + 31, ">")


def draw_aligned_bullets(
    c: canvas.Canvas,
    items: Iterable[str],
    x: float,
    y: float,
    w: float,
    *,
    bullet_color=PURPLE,
    text_color=TEXT,
    size: float = 9.2,
    leading: float | None = None,
    item_gap: float = 4,
    bullet_x_offset: float = 5,
    text_x_offset: float = 18,
    bullet_radius: float = 2.8,
    bullet_y_offset: float | None = None,
) -> float:
    line_height = leading or size + 3
    current_y = y
    for item in items:
        text_x = x + text_x_offset
        max_width = w - text_x_offset
        lines = wrap_text(item, "Helvetica", size, max_width)
        if not lines:
            continue
        c.setFillColor(bullet_color)
        marker_y = current_y + (bullet_y_offset if bullet_y_offset is not None else size * 0.34)
        c.circle(x + bullet_x_offset, marker_y, bullet_radius, fill=1, stroke=0)
        c.setFont("Helvetica", size)
        c.setFillColor(text_color)
        for line_index, line in enumerate(lines):
            c.drawString(text_x, current_y - line_index * line_height, clean(line))
        current_y -= line_height * len(lines) + item_gap
    return current_y


def font_visual_center_offset(font: str, size: float) -> float:
    ascent = pdfmetrics.getAscent(font) * size / 1000
    descent = pdfmetrics.getDescent(font) * size / 1000
    return (ascent + descent) / 2


def draw_card_bullets(
    c: canvas.Canvas,
    items: Iterable[str],
    x: float,
    y: float,
    width: float,
    *,
    text_size: float,
    leading: float,
    bullet_radius: float,
    bullet_color=PURPLE,
    text_color=TEXT,
    bullet_center_x_offset: float = 10,
    text_x_offset: float = 26,
    item_gap: float = 2,
    font: str = "Helvetica",
) -> float:
    current_top_y = y
    text_x = x + text_x_offset
    max_width = width - text_x_offset
    visual_center_offset = font_visual_center_offset(font, text_size)
    for item in items:
        lines = wrap_text(item, font, text_size, max_width)
        if not lines:
            continue
        first_row_center_y = current_top_y - leading / 2
        c.setFillColor(bullet_color)
        c.circle(x + bullet_center_x_offset, first_row_center_y, bullet_radius, fill=1, stroke=0)
        c.setFont(font, text_size)
        c.setFillColor(text_color)
        for line_index, line in enumerate(lines):
            row_center_y = current_top_y - leading * (line_index + 0.5)
            baseline_y = row_center_y - visual_center_offset
            c.drawString(text_x, baseline_y, clean(line))
        current_top_y -= leading * len(lines) + item_gap
    return current_top_y


def draw_bullets(c: canvas.Canvas, items: Iterable[str], x: float, y: float, w: float, *, bullet_color=PURPLE, size: float = 9.2, gap: float = 12) -> float:
    current_y = draw_aligned_bullets(
        c,
        items,
        x,
        y,
        w,
        bullet_color=bullet_color,
        size=size,
        leading=size + 2.2,
        item_gap=gap,
        bullet_x_offset=5,
        text_x_offset=18,
        bullet_radius=3,
        bullet_y_offset=size * 0.34,
    )
    return current_y


def draw_section_box(
    c: canvas.Canvas,
    label: str,
    body: str | Sequence[str],
    x: float,
    y: float,
    w: float,
    h: float,
    *,
    fill=PANEL_SOFT,
    accent=PURPLE,
    body_size: float = 7.4,
    list_bullet_x_offset: float = 4,
    list_text_x_offset: float = 15,
    list_bullet_radius: float = 2.2,
    list_bullet_y_offset: float | None = None,
    list_leading: float | None = None,
    list_item_gap: float = 1.6,
) -> None:
    rounded_rect(c, x, y, w, h, 9, fill=fill, stroke=fill)
    c.setFillColor(accent)
    c.roundRect(x, y, 3.5, h, 2, fill=1, stroke=0)
    draw_text(c, label.upper(), x + 12, y + h - 15, size=6.7, font="Helvetica-Bold", color=accent)
    body_y = y + h - 30
    if isinstance(body, str):
        draw_text(c, body, x + 12, body_y, size=body_size, color=TEXT, max_width=w - 24, leading=body_size + 2.1)
        return
    draw_aligned_bullets(
        c,
        body,
        x + 12,
        body_y,
        w - 24,
        bullet_color=accent,
        size=body_size,
        leading=list_leading or body_size + 2.1,
        item_gap=list_item_gap,
        bullet_x_offset=list_bullet_x_offset,
        text_x_offset=list_text_x_offset,
        bullet_radius=list_bullet_radius,
        bullet_y_offset=list_bullet_y_offset,
    )


def draw_card_bullet_section_box(
    c: canvas.Canvas,
    label: str,
    items: Sequence[str],
    x: float,
    y: float,
    w: float,
    h: float,
    *,
    fill=PANEL_SOFT,
    accent=PURPLE,
    text_size: float = 7,
    leading: float = 8,
    item_gap: float = 1.5,
    bullet_radius: float = 2,
    bullet_center_x_offset: float = 8,
    text_x_offset: float = 24,
    list_top_offset: float = 24,
) -> None:
    rounded_rect(c, x, y, w, h, 9, fill=fill, stroke=fill)
    c.setFillColor(accent)
    c.roundRect(x, y, 3.5, h, 2, fill=1, stroke=0)
    draw_text(c, label.upper(), x + 12, y + h - 15, size=6.7, font="Helvetica-Bold", color=accent)
    draw_card_bullets(
        c,
        items,
        x + 12,
        y + h - list_top_offset,
        w - 24,
        text_size=text_size,
        leading=leading,
        item_gap=item_gap,
        bullet_radius=bullet_radius,
        bullet_color=accent,
        bullet_center_x_offset=bullet_center_x_offset,
        text_x_offset=text_x_offset,
    )


def draw_table(c: canvas.Canvas, x: float, y: float, w: float, headers: Sequence[str], rows: Sequence[Sequence[str]], col_widths: Sequence[float], *, row_height: float = 45) -> float:
    header_h = 28
    rounded_rect(c, x, y - header_h, w, header_h, 10, fill=NAVY, stroke=NAVY)
    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 7.8)
    col_x = x
    for header, col_w in zip(headers, col_widths):
        c.drawString(col_x + 10, y - 18, clean(header).upper())
        col_x += col_w
    current_y = y - header_h
    for row_index, row in enumerate(rows):
        fill = colors.white if row_index % 2 == 0 else colors.HexColor("#F8F9FD")
        c.setFillColor(fill)
        c.roundRect(x, current_y - row_height, w, row_height, 4, fill=1, stroke=0)
        c.setStrokeColor(BORDER)
        c.line(x, current_y - row_height, x + w, current_y - row_height)
        col_x = x
        for cell, col_w in zip(row, col_widths):
            draw_text(c, cell, col_x + 10, current_y - 14, size=7.4, color=TEXT, max_width=col_w - 18, leading=9.5)
            col_x += col_w
        current_y -= row_height
    return current_y


def draw_quick_reference_table(c: canvas.Canvas, rows: Sequence[tuple[str, str, str, str, object]], x: float, y: float, w: float) -> None:
    col_widths = [138, 178, 268, 116]
    header_h = 30
    rounded_rect(c, x, y - header_h, w, header_h, 11, fill=NAVY, stroke=NAVY)
    headers = ["Status", "What it means", "Correct action", "Customer-facing link?"]
    cursor_x = x
    for header, col_w in zip(headers, col_widths):
        draw_text(c, header.upper(), cursor_x + 10, y - 19, size=7.1, font="Helvetica-Bold", color=colors.white)
        cursor_x += col_w

    current_y = y - header_h
    row_h = 51
    for index, (status, meaning, action, link, accent) in enumerate(rows):
        fill = colors.white if index % 2 == 0 else colors.HexColor("#F8F9FD")
        c.setFillColor(fill)
        c.roundRect(x, current_y - row_h, w, row_h, 4, fill=1, stroke=0)
        c.setStrokeColor(BORDER)
        c.line(x, current_y - row_h, x + w, current_y - row_h)
        draw_pill(c, status, x + 10, current_y - 32, 112, fill=colors.white, stroke=accent, text_color=NAVY, font_size=6.5)
        draw_text(c, meaning, x + col_widths[0] + 10, current_y - 17, size=7.2, color=TEXT, max_width=col_widths[1] - 20, leading=9.2)
        draw_text(c, action, x + col_widths[0] + col_widths[1] + 10, current_y - 17, size=7.2, color=TEXT, max_width=col_widths[2] - 20, leading=9.2)
        draw_text(c, link, x + col_widths[0] + col_widths[1] + col_widths[2] + 10, current_y - 17, size=7.2, color=TEXT, max_width=col_widths[3] - 20, leading=9.2)
        current_y -= row_h


def draw_compact_scenario_card(
    c: canvas.Canvas,
    title: str,
    symptoms: Sequence[str],
    action: str,
    avoid: str,
    wording: str,
    x: float,
    y: float,
    w: float,
    h: float,
    *,
    accent=PURPLE,
) -> None:
    rounded_rect(c, x, y, w, h, 12, fill=PANEL, stroke=BORDER)
    c.setFillColor(accent)
    c.roundRect(x, y + h - 4, w, 4, 2, fill=1, stroke=0)
    draw_text(c, title, x + 13, y + h - 23, size=10.5, font="Helvetica-Bold", color=NAVY, max_width=w - 26, leading=11.5)
    draw_card_bullet_section_box(
        c,
        "Symptoms",
        symptoms,
        x + 13,
        y + h - 86,
        w - 26,
        47,
        fill=BLUE_SOFT,
        accent=BLUE,
        text_size=6.2,
        leading=7.0,
        item_gap=0.8,
        bullet_radius=1.8,
        bullet_center_x_offset=8,
        text_x_offset=24,
        list_top_offset=24,
    )
    draw_section_box(c, "Support action", action, x + 13, y + h - 139, w - 26, 43, fill=LAVENDER_SOFT, accent=PURPLE, body_size=6.4)
    draw_section_box(c, "Do not", avoid, x + 13, y + h - 187, w - 26, 39, fill=RED_SOFT, accent=RED, body_size=6.4)
    draw_section_box(c, "Suggested wording", wording, x + 13, y + h - 244, w - 26, 53, fill=MINT_SOFT, accent=TEAL, body_size=6.1)


def draw_snippet_rows(c: canvas.Canvas, rows: Sequence[tuple[str, str, object]], x: float, y: float, w: float) -> None:
    rounded_rect(c, x, y - 32, w, 32, 12, fill=NAVY, stroke=NAVY)
    draw_text(c, "SITUATION", x + 16, y - 20, size=7.2, font="Helvetica-Bold", color=colors.white)
    draw_text(c, "USE THIS WORDING", x + 170, y - 20, size=7.2, font="Helvetica-Bold", color=colors.white)
    current_y = y - 32
    row_h = 47
    for index, (label, copy, accent) in enumerate(rows):
        fill = colors.white if index % 2 == 0 else colors.HexColor("#F8F9FD")
        c.setFillColor(fill)
        c.roundRect(x, current_y - row_h, w, row_h, 3, fill=1, stroke=0)
        c.setStrokeColor(BORDER)
        c.line(x, current_y - row_h, x + w, current_y - row_h)
        draw_pill(c, label, x + 14, current_y - 31, 118, fill=colors.white, stroke=accent, text_color=NAVY, font_size=6.2)
        draw_text(c, copy, x + 170, current_y - 16, size=7.25, color=TEXT, max_width=w - 190, leading=9.2)
        current_y -= row_h


def draw_dashboard_placeholder(c: canvas.Canvas, x: float, y: float, w: float, h: float) -> None:
    rounded_rect(c, x, y, w, h, 14, fill=colors.white, stroke=BORDER)
    c.setFillColor(colors.HexColor("#F6F2FF"))
    c.roundRect(x + 1, y + 1, 94, h - 2, 12, fill=1, stroke=0)
    c.setFillColor(TEAL)
    c.circle(x + 18, y + h - 20, 5.5, fill=1, stroke=0)
    draw_text(c, "alphaSource admin", x + 32, y + h - 17, size=6, font="Helvetica-Bold", color=MUTED)
    nav_items = ["Overview", "Metrics", "Public Purchases", "Clients"]
    for index, item in enumerate(nav_items):
        item_y = y + h - 50 - index * 24
        active = item == "Public Purchases"
        rounded_rect(c, x + 14, item_y, 68, 14, 7, fill=colors.HexColor("#EDE7FF") if active else colors.white, stroke=colors.HexColor("#EDE7FF"))
        draw_text(c, item, x + 21, item_y + 4, size=4.9, font="Helvetica-Bold", color=NAVY if active else MUTED)
    draw_text(c, "Admin Public Purchases", x + 118, y + h - 38, size=11, font="Helvetica-Bold", color=NAVY)
    draw_text(c, "Self-serve membership purchase review", x + 118, y + h - 55, size=6.4, color=MUTED)
    for i, (label, value, accent) in enumerate([
        ("Started", "18", PURPLE),
        ("Agreement pending", "4", AMBER),
        ("Setup pending", "2", BLUE),
        ("Completed", "12", TEAL),
    ]):
        card_x = x + 118 + i * 77
        rounded_rect(c, card_x, y + h - 104, 66, 50, 8, fill=colors.white, stroke=BORDER)
        draw_text(c, label, card_x + 8, y + h - 70, size=5.6, font="Helvetica-Bold", color=MUTED, max_width=50, leading=6.4)
        draw_text(c, value, card_x + 8, y + h - 92, size=15, font="Helvetica-Bold", color=NAVY)
        c.setFillColor(accent)
        c.circle(card_x + 52, y + h - 68, 4.8, fill=1, stroke=0)
    draw_text(c, "RECENT PURCHASE ROWS", x + 118, y + 58, size=5.8, font="Helvetica-Bold", color=MUTED)
    for index in range(4):
        row_y = y + 9 + index * 11
        c.setStrokeColor(colors.HexColor("#ECF0F7"))
        c.line(x + 118, row_y, x + w - 24, row_y)
        rounded_rect(c, x + 118, row_y + 4, 78, 6, 3, fill=colors.HexColor("#F0F3FA"), stroke=colors.HexColor("#F0F3FA"))
        rounded_rect(c, x + 220, row_y + 4, 58, 6, 3, fill=colors.HexColor("#F0F3FA"), stroke=colors.HexColor("#F0F3FA"))
        rounded_rect(c, x + 305, row_y + 4, 80, 6, 3, fill=colors.HexColor("#F0F3FA"), stroke=colors.HexColor("#F0F3FA"))


def draw_scenario_card(
    c: canvas.Canvas,
    title: str,
    symptoms: Sequence[str],
    action: str,
    avoid: str,
    wording: str,
    x: float,
    y: float,
    w: float,
    h: float,
    *,
    accent=PURPLE,
) -> None:
    rounded_rect(c, x, y, w, h, 12, fill=PANEL, stroke=BORDER)
    c.setFillColor(accent)
    c.roundRect(x, y + h - 4, w, 4, 2, fill=1, stroke=0)
    draw_text(c, title, x + 16, y + h - 24, size=12, font="Helvetica-Bold", color=NAVY, max_width=w - 32)
    draw_section_box(c, "Symptoms", symptoms, x + 16, y + h - 110, w - 32, 66, fill=BLUE_SOFT, accent=BLUE, body_size=7.2)
    draw_section_box(c, "Support action", action, x + 16, y + h - 185, w - 32, 63, fill=LAVENDER_SOFT, accent=PURPLE, body_size=7.4)
    draw_section_box(c, "Do not", avoid, x + 16, y + h - 255, w - 32, 58, fill=RED_SOFT, accent=RED, body_size=7.4)
    draw_section_box(c, "Suggested wording", wording, x + 16, y + 16, w - 32, 64, fill=MINT_SOFT, accent=TEAL, body_size=7.1)


def draw_cover(c: canvas.Canvas, total_pages: int) -> None:
    c.setFillColor(BG)
    c.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
    draw_text(c, "alphaScreen by alphaSource", 48, 522, size=12, color=TEXT)
    draw_badge(c, "ADMIN ONLY", 646, 526, fill=NAVY, font_size=8.5, min_width=92)
    draw_text(c, "alphaScreen Public Purchase", 48, 476, size=31, font="Helvetica-Bold", color=NAVY)
    draw_text(c, "Support Playbook", 48, 439, size=31, font="Helvetica-Bold", color=NAVY)
    draw_text(
        c,
        "Internal support guide for self-serve alphaScreen membership purchases.",
        48,
        402,
        size=13,
        color=MUTED,
        max_width=610,
    )
    draw_callout(
        c,
        "Support standard",
        "Every purchase row should be triaged from Admin Public Purchases. Do not manually mark agreements, payments, billing, or account activation outside an approved escalation.",
        48,
        326,
        650,
        62,
        accent=PURPLE,
        fill=PANEL_SOFT,
    )
    card_w = 210
    draw_card(c, "Source of truth", "Use Admin Public Purchases to review agreement, Stripe Checkout, setup, and email state.", 48, 216, card_w, 84, accent=TEAL)
    draw_card(c, "Recovery actions", "Resend the correct agreement, checkout, setup, or welcome email only when the row allows it.", 286, 216, card_w, 84, accent=PURPLE)
    draw_card(c, "Escalation boundary", "Do not manually change agreement, payment, billing, or account activation state.", 524, 216, card_w, 84, accent=BLUE)
    rounded_rect(c, 48, 95, 700, 74, 16, fill=colors.white, stroke=BORDER)
    draw_text(c, "PUBLIC PURCHASE FLOW", 72, 146, size=8.2, font="Helvetica-Bold", color=NAVY)
    draw_flow(
        c,
        ["Pricing", "Signup", "Agreement", "Checkout", "Activation", "Setup", "Dashboard"],
        58,
        111,
        690,
        active_index=0,
    )
    draw_footer(c, 1, total_pages)


def page_support_scope(c: canvas.Canvas, total_pages: int) -> None:
    draw_header(c, 2, "What support can resolve", "SIX TASKS / ONE SOURCE", total_pages)
    draw_text(c, "Use the admin page to find the buyer's current state, choose the next safe recovery action, and escalate mismatches without exposing private system data.", 46, 495, size=10.5, color=MUTED, max_width=700)
    draw_dashboard_placeholder(c, 46, 292, 456, 172)
    y = 452
    for index, (title, body) in enumerate([
        ("Find current state", "Review agreement, checkout, setup, and email signals in one row."),
        ("Resume safely", "Use the allowed resend action for the step the buyer is actually in."),
        ("Avoid manual mutation", "Do not mark agreements, payments, billing, or activation by hand."),
        ("Escalate mismatches", "Copy a sanitized support summary when status signals conflict."),
        ("Use safe wording", "Give the next step without sharing private links or provider data."),
        ("Confirm escalation path", "Route payment, identity, duplicate, or delivery mismatches for approved review."),
    ], start=1):
        y = draw_numbered_item(c, index, title, body, 532, y, 210)
    draw_callout(
        c,
        "Support action",
        "If the row is not clearly complete, describe the current state and next safe step. Do not promise activation, refund, cancellation, or billing changes without confirmation.",
        46,
        122,
        700,
        80,
        accent=TEAL,
        fill=MINT_SOFT,
    )


def page_lifecycle(c: canvas.Canvas, total_pages: int) -> None:
    draw_header(c, 3, "Public purchase lifecycle", "SEVEN STAGES / TWO GATES", total_pages)
    draw_text(c, "Support should resume the buyer's current step without skipping the agreement, payment, or setup gates.", 46, 498, size=10.5, color=MUTED, max_width=690)
    draw_stage_flow_cards(
        c,
        [
            ("Pricing", "Buyer chooses membership."),
            ("Signup", "Intent and buyer details."),
            ("Agreement", "Buyer reviews and signs."),
            ("Stripe Checkout", "Secure payment step."),
            ("Activation", "Webhook confirms payment."),
            ("Setup email", "Password setup begins."),
            ("Dashboard", "Access after setup."),
        ],
        46,
        415,
        700,
    )
    draw_callout(c, "Gate 1", "Agreement signing gates Stripe Checkout.", 46, 322, 330, 60, accent=PURPLE, fill=PANEL_SOFT)
    draw_callout(c, "Gate 2", "Stripe confirmation gates setup and dashboard access.", 416, 322, 330, 60, accent=TEAL, fill=MINT_SOFT)
    draw_text(c, "WHERE THE WORK LIVES", 46, 252, size=8.5, font="Helvetica-Bold", color=NAVY)
    c.setStrokeColor(TEAL)
    c.setLineWidth(1.5)
    c.line(46, 241, 746, 241)
    stage_cards = [
        ("Buyer details", "Name, company, membership, cadence, and source path."),
        ("Agreement", "Sent, opened, signed, and checkout gating state."),
        ("Checkout", "Stripe payment and return-state indicators."),
        ("Setup", "Client, member, password setup, and welcome email state."),
    ]
    for index, (title, body) in enumerate(stage_cards):
        draw_card(c, title, body, 46 + index * 176, 132, 154, 78, accent=[TEAL, PURPLE, BLUE, AMBER][index], title_size=10, body_size=8)


def page_quick_reference(c: canvas.Canvas, total_pages: int) -> None:
    draw_header(c, 4, "Admin Public Purchases quick reference", "STATUS TRIAGE / CORRECT ACTION", total_pages)
    rows = [
        ("Agreement pending", "Agreement not signed yet.", "Resend agreement link if available.", "Agreement only", PURPLE),
        ("Checkout pending", "Agreement signed; payment unpaid or in progress.", "Resend checkout link after confirming no paid state.", "Checkout only", TEAL),
        ("Setup pending", "Payment appears complete; setup state incomplete.", "Resend setup email if available; escalate if stuck.", "Setup only", BLUE),
        ("Completed", "Billing and member access are active and linked.", "Guide buyer to login or resend welcome email if needed.", "Login/support", TEAL),
        ("Canceled / failed", "Payment failed, expired, or purchase canceled.", "Confirm state; escalate billing requests.", "No payment promise", RED),
        ("Unknown / mismatch", "Signals do not map cleanly.", "Copy support summary and escalate.", "No direct link", AMBER),
    ]
    draw_quick_reference_table(c, rows, 46, 486, 700)
    draw_callout(c, "Important distinction", "Email sends do not change payment, billing, agreement, or access status. They only help the buyer resume the allowed next step.", 46, 80, 700, 58, accent=AMBER, fill=AMBER_SOFT)


def page_controls(c: canvas.Canvas, total_pages: int) -> None:
    draw_header(c, 5, "Admin page controls", "ROW REVIEW / RECOVERY ACTIONS", total_pages)
    draw_card(c, "What the page shows", "Buyer and company details, membership and cadence, source path, agreement status, Stripe Checkout signals, setup state, and email delivery state.", 46, 352, 215, 124, accent=TEAL, title_size=12, body_size=8.8)
    draw_card(c, "Row actions", "Open Details before acting. Resend agreement, checkout, setup, or welcome email only when the row allows that action. Copy support summary for escalation.", 288, 352, 215, 124, accent=PURPLE, title_size=12, body_size=8.8)
    draw_card(c, "What it cannot do", "It cannot mark an agreement signed, mark checkout paid, activate billing, edit Stripe subscriptions, delete records, or override member state.", 531, 352, 215, 124, accent=RED, title_size=12, body_size=8.8)
    draw_callout(c, "Standing rule", "If the row is not clearly complete, describe the current state and next step. Do not promise activation, refund, cancellation, or billing changes without confirmation.", 46, 258, 700, 64, accent=PURPLE, fill=PANEL_SOFT)
    draw_text(c, "ROW REVIEW LOOP", 46, 205, size=8.5, font="Helvetica-Bold", color=NAVY)
    draw_flow(c, ["Search row", "Open details", "Confirm state", "Use allowed action", "Refresh", "Escalate if mismatched"], 46, 169, 700, active_index=0)
    rounded_rect(c, 46, 78, 700, 60, 14, fill=NAVY, stroke=NAVY)
    draw_text(c, "AVOID THIS", 70, 115, size=7.7, font="Helvetica-Bold", color=AMBER)
    draw_text(c, "Do not use spreadsheets, inbox notes, or memory as the daily source of truth for purchase status. Use Admin Public Purchases and escalate mismatches with sanitized context.", 70, 96, size=10, font="Helvetica-Bold", color=colors.white, max_width=650, leading=12.5)


def page_agreement_checkout(c: canvas.Canvas, total_pages: int) -> None:
    draw_header(c, 6, "Scenario group: agreement and checkout", "SUPPORT PATHS / PAYMENT GATE", total_pages)
    draw_scenario_card(
        c,
        "Agreement pending",
        ["Agreement sent or opened", "Checkout is not paid", "Buyer cannot find signing email"],
        "Confirm buyer email and row state, then use Resend agreement link if available. Ask the buyer to use the newest agreement email.",
        "Do not send checkout instructions before agreement signing.",
        "I resent the agreement email to the buyer address on file. Please use the newest email to review and sign before checkout.",
        46,
        110,
        330,
        360,
        accent=PURPLE,
    )
    draw_scenario_card(
        c,
        "Signed / checkout pending",
        ["Agreement signed time is present", "Payment is unpaid, pending, or failed", "Buyer has not completed payment"],
        "Confirm the signed agreement and unpaid state, then use Resend checkout link if available. Refresh after checkout completes.",
        "Do not tell the buyer the membership is active until payment and setup are complete.",
        "Your agreement appears signed. I resent the secure checkout recovery email so payment can continue from the current signup.",
        416,
        110,
        330,
        360,
        accent=TEAL,
    )


def page_stripe_setup(c: canvas.Canvas, total_pages: int) -> None:
    draw_header(c, 7, "Scenario group: Stripe return and setup", "CHECKOUT REVIEW / ACCOUNT ACCESS", total_pages)
    draw_scenario_card(
        c,
        "Did not return from Stripe",
        ["Buyer says payment completed", "Browser closed or return failed", "Admin row may still be pending"],
        "Refresh the admin row. If completed, guide login or setup. If signals conflict, copy support summary and escalate before asking for another payment step.",
        "Do not ask the buyer to pay again until review confirms it is safe.",
        "We are checking the purchase status before asking you to take another checkout step.",
        46,
        110,
        330,
        360,
        accent=BLUE,
    )
    draw_scenario_card(
        c,
        "Paid but setup pending",
        ["Payment appears complete", "Client/member setup is incomplete", "Buyer cannot access dashboard"],
        "Confirm payment and member setup state. Use Resend setup email when available. Escalate if setup remains stuck after refresh.",
        "Do not share setup tokens or manually mark setup complete.",
        "Payment appears complete, and the remaining step is account setup. I resent the password setup email.",
        416,
        110,
        330,
        360,
        accent=AMBER,
    )


def page_existing_email(c: canvas.Canvas, total_pages: int) -> None:
    draw_header(c, 8, "Scenario group: existing user and email recovery", "LOGIN STATE / EMAIL STATE", total_pages)
    scenarios = [
        (
            "Existing user purchase",
            ["Buyer already has alphaScreen login", "Payment completed", "Member may already be linked"],
            "Confirm row status and member linking. If linked, direct the buyer to login with the existing account.",
            "Do not create a duplicate user.",
            "Please sign in with your existing account first. If the new membership is not visible, we will review the account link.",
            PURPLE,
        ),
        (
            "Welcome email not received",
            ["Setup exists", "Welcome email missing or failed", "Dashboard access may already work"],
            "Check welcome email status. Resend welcome email only when the row allows it.",
            "Do not make welcome email delivery a blocker if account access works.",
            "I resent the alphaScreen welcome email. You can still sign in if password setup is complete.",
            TEAL,
        ),
        (
            "Setup email not received",
            ["Payment appears complete", "Buyer cannot set password", "Setup email missing or failed"],
            "Confirm setup state, then resend setup email if available. Ask the buyer to use the newest setup email.",
            "Do not share password setup tokens.",
            "I resent the password setup email. Please use the newest email to finish account access.",
            BLUE,
        ),
    ]
    for index, scenario in enumerate(scenarios):
        draw_compact_scenario_card(c, *scenario[:-1], 46 + index * 235, 170, 205, 286, accent=scenario[-1])


def page_identity_duplicates(c: canvas.Canvas, total_pages: int) -> None:
    draw_header(c, 9, "Scenario group: identity and duplicates", "BUYER IDENTITY / DUPLICATE RISK", total_pages)
    draw_scenario_card(
        c,
        "Wrong buyer email",
        ["Agreement or checkout went to wrong address", "Buyer asks for link forwarding", "Purchase may be signed or paid"],
        "If unsigned and unpaid, recommend restarting signup with the correct buyer email unless an approved admin path exists. Escalate signed or paid records.",
        "Do not forward agreement, checkout, or setup links to a different email.",
        "The buyer email controls agreement, checkout, and setup delivery. We need to review the safest correction path.",
        46,
        110,
        330,
        360,
        accent=AMBER,
    )
    draw_scenario_card(
        c,
        "Duplicate purchase attempt",
        ["Multiple rows for same buyer or company", "One row may be more advanced", "A paid duplicate is possible"],
        "Compare status, created time, membership, cadence, and payment indicators. Continue from the most advanced legitimate row and escalate any possible duplicate billing.",
        "Do not delete duplicate records or ask for repeat payment while any row may be paid.",
        "I see more than one signup attempt, so I am checking the active path before sending another payment or setup instruction.",
        416,
        110,
        330,
        360,
        accent=PURPLE,
    )


def page_billing_mismatch(c: canvas.Canvas, total_pages: int) -> None:
    draw_header(c, 10, "Billing requests and payment mismatch", "ESCALATION REQUIRED / NO MANUAL STRIPE MUTATION", total_pages)
    draw_card(c, "Cancellation, refund, or membership change", "Locate the row, copy the support summary, acknowledge the request without promising the outcome, and route it to the approved billing/admin owner.", 46, 342, 330, 124, accent=AMBER, title_size=12, body_size=9.3)
    draw_card(c, "Webhook or payment mismatch", "If buyer-reported payment, Stripe indicators, and setup state do not agree, refresh, copy the support summary, and escalate before asking for another payment step.", 416, 342, 330, 124, accent=BLUE, title_size=12, body_size=9.3)
    rounded_rect(c, 46, 228, 700, 76, 14, fill=RED_SOFT, stroke=RED_SOFT)
    draw_text(c, "AVOID THIS", 70, 278, size=7.7, font="Helvetica-Bold", color=RED)
    draw_card_bullets(
        c,
        [
            "Do not promise refund, cancellation, membership change, or billing cadence outcome.",
            "Do not ask the buyer to repeat checkout until review confirms it is safe.",
            "Do not edit Stripe subscriptions directly from this workflow.",
        ],
        70,
        266,
        650,
        bullet_color=RED,
        text_size=8.5,
        leading=10.7,
        bullet_radius=3,
        bullet_center_x_offset=12,
        text_x_offset=32,
        item_gap=3,
    )
    draw_callout(c, "Customer wording", "I received your request and will route it for billing review. We will confirm the next step after the purchase and payment status have been reviewed.", 46, 125, 700, 72, accent=PURPLE, fill=PANEL_SOFT)


def page_email_escalation(c: canvas.Canvas, total_pages: int) -> None:
    draw_header(c, 11, "Email delivery issues and escalation rules", "ONE SAFE RESEND / SANITIZED ESCALATION", total_pages)
    draw_card(c, "Email delivery issue", "Confirm the needed email, use the correct resend action once if available, ask the buyer to check spam and quarantine, then wait for delivery state to update.", 46, 366, 330, 100, accent=TEAL, title_size=12, body_size=9)
    draw_card(c, "Escalate immediately", "Payment/state mismatch, signed agreement blocked from checkout, setup stuck after payment, wrong buyer email after signing or payment, possible duplicate billing, or repeated delivery failure.", 416, 366, 330, 100, accent=AMBER, title_size=12, body_size=9)
    draw_section_box(c, "Include", ["Sanitized support summary", "Current status label", "Buyer-reported problem", "Attempted recovery action and approximate time"], 46, 194, 330, 132, fill=MINT_SOFT, accent=TEAL, body_size=8.2)
    draw_section_box(c, "Do not include", ["Secrets, tokens, or auth headers", "Signing, setup, or password reset URLs", "Webhook signing details or raw payloads", "Unnecessary customer private data"], 416, 194, 330, 132, fill=RED_SOFT, accent=RED, body_size=8.2)
    draw_callout(c, "Safe wording", "I resent the correct alphaScreen email for your current setup step. If it still does not arrive, we will escalate the delivery check.", 46, 92, 700, 66, accent=PURPLE, fill=PANEL_SOFT)


def page_snippets(c: canvas.Canvas, total_pages: int) -> None:
    draw_header(c, 12, "Safe support language snippets", "CUSTOMER WORDING / NO PROMISES", total_pages)
    rows = [
        ("Agreement link", "I resent the alphaScreen membership agreement to the buyer address on file. Please use the newest email to review and sign before checkout.", PURPLE),
        ("Checkout link", "Your agreement appears to be signed. I resent the secure checkout recovery email so payment can continue from the current signup.", TEAL),
        ("Password setup", "Payment appears complete, and the remaining step is password setup. I resent the setup email to the buyer address on file.", BLUE),
        ("Existing login", "This purchase appears tied to an existing alphaScreen login. Please sign in with your existing account first.", PURPLE),
        ("Payment review", "I do not want to ask you to repeat checkout until the current payment state is verified. We are reviewing the purchase status.", AMBER),
        ("Billing request", "I received your request and will route it for billing review. We will confirm the next step after review.", RED),
        ("Escalation", "This needs internal review before we can safely change the purchase path. I am escalating the current status and will follow up.", AMBER),
    ]
    draw_snippet_rows(c, rows, 46, 488, 700)


def page_glossary(c: canvas.Canvas, total_pages: int) -> None:
    draw_header(c, 13, "Glossary and production use note", "FINAL STANDARD / LIVE SUPPORT", total_pages)
    glossary = [
        ("Purchase intent", "Internal record created when a buyer starts public membership signup."),
        ("Membership agreement", "Agreement the buyer reviews and signs before secure checkout."),
        ("Stripe Checkout", "Secure payment step used after agreement signing."),
        ("Setup email", "Email that helps the buyer set a password or complete account access."),
        ("Welcome email", "Email welcoming a new alphaScreen client after activation when applicable."),
        ("Support summary", "Sanitized row summary intended for internal escalation."),
    ]
    for index, (term, definition) in enumerate(glossary):
        x = 46 + (index % 2) * 350
        y = 420 - (index // 2) * 70
        draw_card(c, term, definition, x, y, 320, 56, accent=[PURPLE, TEAL, BLUE, AMBER, PURPLE, TEAL][index], title_size=10.5, body_size=8.3)
    draw_callout(
        c,
        "Production use note",
        "After launch, use the production Admin Public Purchases page for live customers. Do not use QA links, QA records, or QA screenshots when supporting a live buyer.",
        46,
        158,
        700,
        62,
        accent=AMBER,
        fill=AMBER_SOFT,
    )
    rounded_rect(c, 46, 70, 700, 68, 16, fill=NAVY, stroke=NAVY)
    draw_text(c, "FINAL STANDARD", 72, 113, size=7.8, font="Helvetica-Bold", color=TEAL)
    draw_text(c, "Each buyer should receive the next safe step for their current purchase state. Admin recovery actions help the buyer resume agreement, Stripe Checkout, or setup. They do not replace agreement signing, payment confirmation, or account activation.", 72, 94, size=10, font="Helvetica-Bold", color=colors.white, max_width=650, leading=12.5)


def generate() -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(OUTPUT_PATH), pagesize=landscape(letter))
    c.setTitle("alphaScreen Public Purchase Support Playbook")
    c.setAuthor("alphaSource")
    c.setSubject("Admin-only support guide for self-serve alphaScreen membership purchases")
    c.setKeywords("alphaScreen, alphaSource, public purchases, support playbook")

    pages = [
        draw_cover,
        page_support_scope,
        page_lifecycle,
        page_quick_reference,
        page_controls,
        page_agreement_checkout,
        page_stripe_setup,
        page_existing_email,
        page_identity_duplicates,
        page_billing_mismatch,
        page_email_escalation,
        page_snippets,
        page_glossary,
    ]
    total_pages = len(pages)
    for page in pages:
        page(c, total_pages)
        c.showPage()
    c.save()


if __name__ == "__main__":
    generate()
    print(OUTPUT_PATH)
