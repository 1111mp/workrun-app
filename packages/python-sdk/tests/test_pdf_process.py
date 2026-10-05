from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
from pypdf import PdfReader, PdfWriter
from workrun_sdk._protocol import JsonObject

example_path = Path(__file__).parents[1] / "examples/pdf-process/main.py"
spec = importlib.util.spec_from_file_location("pdf_process_example", example_path)
assert spec and spec.loader
example = importlib.util.module_from_spec(spec)
spec.loader.exec_module(example)


def test_scanned_pages_report_missing_text_and_generate_valid_files(
    tmp_path, monkeypatch
):
    source = tmp_path / "scan.pdf"
    with PdfWriter() as writer:
        writer.add_blank_page(width=300, height=200)
        writer.write(source)
    saved: dict[str, bytes] = {}

    def save(file: Path) -> JsonObject:
        saved[file.name] = file.read_bytes()
        return {"$type": "artifact", "name": file.name}

    monkeypatch.setattr(example.artifacts, "path", lambda _: source)
    monkeypatch.setattr(example.artifacts, "save", save)
    result = example.process_pdf({"mimeType": "application/pdf"})
    assert result["pageCount"] == 1
    assert result["textPageCount"] == 0
    assert result["warnings"]
    assert b"--- Page 1 ---" in saved["extracted-text.txt"]
    output = tmp_path / "processed.pdf"
    output.write_bytes(saved["processed.pdf"])
    reader = PdfReader(output)
    assert len(reader.pages) == 1
    metadata = reader.metadata
    assert metadata is not None
    assert metadata.title == "Processed PDF"


def test_encrypted_pdf_fails_without_saving_partial_outputs(tmp_path, monkeypatch):
    source = tmp_path / "encrypted.pdf"
    with PdfWriter() as writer:
        writer.add_blank_page(width=300, height=200)
        writer.encrypt("secret")
        writer.write(source)
    saved = []
    monkeypatch.setattr(example.artifacts, "path", lambda _: source)
    monkeypatch.setattr(example.artifacts, "save", lambda file: saved.append(file))
    with pytest.raises(ValueError, match="Encrypted PDF"):
        example.process_pdf({"mimeType": "application/pdf"})
    assert not saved


def test_non_pdf_is_rejected_before_requesting_a_private_copy(monkeypatch):
    def unexpected_read(_):
        pytest.fail("Non-PDF input should not be read")

    monkeypatch.setattr(example.artifacts, "path", unexpected_read)
    with pytest.raises(ValueError, match="PDF file"):
        example.process_pdf({"mimeType": "image/png"})
