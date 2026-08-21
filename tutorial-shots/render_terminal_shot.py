#!/usr/bin/env python3
"""Render terminal-shot text files into terminal-style PNG images.

Usage:
  python3 render_terminal_shot.py <step.txt> [output.png]

Each input file:
  - First line is the command (shown in the title bar).
  - Remaining lines are the terminal output.
"""

import sys
import os
import textwrap
from PIL import Image, ImageDraw, ImageFont

# ── Configuration ──────────────────────────────────────────────────
BG_COLOR = (30, 30, 46)          # #1e1e2e
TITLE_BG = (24, 24, 37)          # slightly darker
TEXT_COLOR = (205, 214, 244)     # #cdd6f4 (Catppuccin text)
PROMPT_COLOR = (166, 227, 161)   # #a6e3a1 (Catppuccin green)
DOT_RED = (243, 139, 168)        # close
DOT_YELLOW = (249, 226, 175)     # minimize
DOT_GREEN = (166, 227, 161)      # maximize
TITLE_TEXT_COLOR = (147, 153, 178)

FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONT_SIZE = 14
LINE_SPACING = 6                  # extra px between lines
DOT_RADIUS = 6
DOT_SPACING = 18
TITLE_BAR_HEIGHT = 32
PADDING_X = 24
PADDING_Y = 16
MAX_WIDTH = 1200                  # max image width
MAX_COLS = 100                    # target column count
# ────────────────────────────────────────────────────────────────────

def load_font(size):
    try:
        return ImageFont.truetype(FONT_PATH, size)
    except Exception:
        return ImageFont.load_default()

def get_char_width(font):
    """Measure monospace char width."""
    bbox = font.getbbox("X")
    return bbox[2] - bbox[0]

def wrap_text(text, max_chars, font):
    """Wrap text to max_chars, preserving existing line breaks."""
    lines = []
    for paragraph in text.split("\n"):
        if paragraph == "":
            lines.append("")
            continue
        while len(paragraph) > max_chars:
            # find break point
            cut = max_chars
            lines.append(paragraph[:cut])
            paragraph = paragraph[cut:]
        lines.append(paragraph)
    return lines

def render(input_path, output_path):
    font = load_font(FONT_SIZE)
    char_w = get_char_width(font)
    line_h = FONT_SIZE + LINE_SPACING

    # Read input
    with open(input_path, "r", encoding="utf-8") as f:
        raw = f.read()

    # Split: first non-empty line = command, rest = output
    lines_raw = raw.strip().split("\n")
    if not lines_raw:
        print(f"ERROR: empty input: {input_path}")
        sys.exit(1)

    # First line is the command prompt
    command_line = lines_raw[0]
    output_lines = lines_raw[1:] if len(lines_raw) > 1 else []

    # Determine column width
    # Find the longest line across command + output
    all_lines = [command_line] + output_lines
    max_line_len = max(len(line) for line in all_lines)
    cols = min(max(max_line_len + 2, 60), MAX_COLS)

    # Calculate image dimensions
    content_width = cols * char_w
    img_width = min(content_width + 2 * PADDING_X, MAX_WIDTH)
    # If capped, recalculate cols for wrapping
    effective_content_width = img_width - 2 * PADDING_X
    effective_cols = effective_content_width // char_w

    # Wrap all lines
    wrapped_cmd = wrap_text(command_line, effective_cols, font)
    wrapped_out = []
    for line in output_lines:
        wrapped_out.extend(wrap_text(line, effective_cols, font))

    total_lines = len(wrapped_cmd) + len(wrapped_out)
    img_height = TITLE_BAR_HEIGHT + PADDING_Y + total_lines * line_h + PADDING_Y

    # Create image
    img = Image.new("RGB", (img_width, img_height), BG_COLOR)
    draw = ImageDraw.Draw(img)

    # Title bar background
    draw.rectangle([(0, 0), (img_width, TITLE_BAR_HEIGHT)], fill=TITLE_BG)

    # Window dots
    dot_y = TITLE_BAR_HEIGHT // 2
    dot_x_start = PADDING_X
    for i, color in enumerate([DOT_RED, DOT_YELLOW, DOT_GREEN]):
        x = dot_x_start + i * DOT_SPACING
        draw.ellipse(
            [(x - DOT_RADIUS, dot_y - DOT_RADIUS),
             (x + DOT_RADIUS, dot_y + DOT_RADIUS)],
            fill=color
        )

    # Title text (the command)
    title_text = command_line
    title_font = load_font(13)
    tbbox = title_font.getbbox(title_text)
    tw = tbbox[2] - tbbox[0]
    # Truncate if too wide
    max_title_w = img_width - dot_x_start - 3 * DOT_SPACING - PADDING_X
    while tw > max_title_w and len(title_text) > 3:
        title_text = title_text[:-4] + "..."
        tbbox = title_font.getbbox(title_text)
        tw = tbbox[2] - tbbox[0]

    title_x = dot_x_start + 3 * DOT_SPACING + 12
    title_y = (TITLE_BAR_HEIGHT - (tbbox[3] - tbbox[1])) // 2
    draw.text((title_x, title_y), title_text, fill=TITLE_TEXT_COLOR, font=title_font)

    # Draw text
    y = TITLE_BAR_HEIGHT + PADDING_Y
    x = PADDING_X

    # Command line (green prompt)
    for line in wrapped_cmd:
        draw.text((x, y), line, fill=PROMPT_COLOR, font=font)
        y += line_h

    # Output lines
    for line in wrapped_out:
        draw.text((x, y), line, fill=TEXT_COLOR, font=font)
        y += line_h

    # Save
    img.save(output_path, "PNG")
    print(f"  {output_path}  ({img_width}x{img_height}, {total_lines} lines)")

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 render_terminal_shot.py <input.txt> [output.png]")
        print("  If output.png is omitted, writes to <input>.png")
        sys.exit(1)

    input_path = sys.argv[1]
    if len(sys.argv) >= 3:
        output_path = sys.argv[2]
    else:
        base = os.path.splitext(input_path)[0]
        output_path = base + ".png"

    render(input_path, output_path)

if __name__ == "__main__":
    main()