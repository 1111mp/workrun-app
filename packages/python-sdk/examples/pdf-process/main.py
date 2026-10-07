"""Workflow Process: extract PDF text and return durable generated files."""

from __future__ import annotations

import json
import sys
from collections.abc import Mapping
from pathlib import Path
from tempfile import TemporaryDirectory

from pypdf import PdfReader, PdfWriter
from workrun_sdk import artifacts, process
from workrun_sdk._protocol import JsonObject, JsonValue


def process_pdf(document: Mapping[str, JsonValue]) -> JsonObject:
    if document.get("mimeType") != "application/pdf":
        raise ValueError("document must reference a PDF file")
    source = artifacts.path(document)
    reader = PdfReader(source)
    if reader.is_encrypted:
        raise ValueError("Encrypted PDF files must be decrypted before processing")
    if not reader.pages:
        raise ValueError("The PDF contains no pages")

    text_page_count = 0
    with TemporaryDirectory(prefix="workrun-pdf-") as directory:
        text_path = Path(directory) / "extracted-text.txt"
        with text_path.open("w", encoding="utf-8") as output:
            for number, page in enumerate(reader.pages, start=1):
                text = page.extract_text() or ""
                if text.strip():
                    text_page_count += 1
                output.write(f"--- Page {number} ---\n{text}\n\n")

        # Re-serialize the pages into a new PDF. Save both files while the
        # temporary directory exists; only immutable references leave this node.
        pdf_path = Path(directory) / "processed.pdf"
        with PdfWriter() as writer:
            writer.append(reader)
            writer.add_metadata({"/Title": "Processed PDF"})
            writer.write(pdf_path)
        return {
            "pageCount": len(reader.pages),
            "textPageCount": text_page_count,
            "warnings": (
                ["Some pages have no extractable text; scanned pages may require OCR."]
                if text_page_count < len(reader.pages)
                else []
            ),
            "report": artifacts.save(text_path),
            "processedPdf": artifacts.save(pdf_path),
        }


def main() -> None:
    state = json.load(sys.stdin)
    if not isinstance(state, dict) or not isinstance(state.get("document"), dict):
        raise TypeError("Workflow input must contain a document resource")
    result = process_pdf(state["document"])
    print(f"Processed {result['pageCount']} PDF pages")
    process.result(result)


if __name__ == "__main__":
    main()
