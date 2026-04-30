#!/usr/bin/env python3
"""Convert a source document into markdown using MarkItDown.

This script is intentionally small so Atlas can use one default extractor
across common office and document formats before deciding whether ingest can
continue.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    from markitdown import MarkItDown
except ImportError:  # pragma: no cover - environment-dependent dependency
    MarkItDown = None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Convert a document to markdown with MarkItDown."
    )
    parser.add_argument("input_path", help="Path to the source file.")
    parser.add_argument(
        "-o",
        "--output",
        help="Optional path to write markdown output. Defaults to stdout.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Write conversion metadata as JSON to stderr.",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    input_path = Path(args.input_path).expanduser().resolve()

    if MarkItDown is None:
        print(
            "Missing dependency: markitdown. Install it in the Python environment "
            "running this script, or use another reliable extraction path.",
            file=sys.stderr,
        )
        return 4

    if not input_path.exists():
        print(f"Input file does not exist: {input_path}", file=sys.stderr)
        return 2

    converter = MarkItDown()

    try:
        result = converter.convert(input_path)
    except Exception as exc:  # pragma: no cover - passthrough for runtime failures
        print(f"MarkItDown conversion failed for {input_path}: {exc}", file=sys.stderr)
        return 1

    markdown = (result.markdown or "").strip()
    if not markdown:
        print(f"MarkItDown returned empty output for {input_path}", file=sys.stderr)
        return 3

    if args.output:
        output_path = Path(args.output).expanduser().resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(markdown + "\n", encoding="utf-8")
    else:
        sys.stdout.write(markdown + "\n")

    if args.json:
        metadata = {
            "input_path": str(input_path),
            "title": result.title,
            "characters": len(markdown),
            "lines": markdown.count("\n") + 1,
        }
        print(json.dumps(metadata, ensure_ascii=True), file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
