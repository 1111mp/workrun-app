"""Deterministic two-page text PDF used by the real IPC integration test."""

import sys
from pathlib import Path

from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject


def create_pdf(destination: Path) -> None:
    with PdfWriter() as writer:
        font = DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            }
        )
        font_ref = writer._add_object(font)
        for text in ["First page alpha", "Second page beta"]:
            page = writer.add_blank_page(width=300, height=200)
            page[NameObject("/Resources")] = DictionaryObject(
                {
                    NameObject("/Font"): DictionaryObject(
                        {NameObject("/F1"): font_ref}
                    ),
                }
            )
            content = DecodedStreamObject()
            content.set_data(f"BT /F1 12 Tf 20 100 Td ({text}) Tj ET".encode())
            page[NameObject("/Contents")] = writer._add_object(content)
        writer.write(destination)


if __name__ == "__main__":
    create_pdf(Path(sys.argv[1]))
