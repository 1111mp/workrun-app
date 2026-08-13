from __future__ import annotations

from workrun_sdk import choice, collect, number, text, ui


def test_collect_builds_schema_and_ui_schema(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def fake_form(**kwargs: object) -> object:
        captured.update(kwargs)
        return {"gender": "female", "height_cm": 165, "note": "hello"}

    monkeypatch.setattr(ui, "form", fake_form)

    result = collect(
        title="Personal information",
        description="Please complete your profile",
        submit_label="Save",
        layout=[["gender"], ["height_cm", "note"]],
        fields={
            "gender": choice(
                "Gender",
                {"male": "Male", "female": "Female"},
                required=True,
                widget="radio",
                ui_options={"inline": True},
            ),
            "height_cm": number(
                "Height (cm)",
                minimum=50,
                maximum=300,
                placeholder="e.g. 165",
                ui_options={"step": 0.5},
            ),
            "note": text("Note", placeholder="Optional note", multiline=True),
        },
    )

    assert result == {"gender": "female", "height_cm": 165, "note": "hello"}
    assert captured["schema"] == {
        "type": "object",
        "properties": {
            "gender": {
                "type": "string",
                "title": "Gender",
                "enum": ["male", "female"],
            },
            "height_cm": {
                "type": "number",
                "title": "Height (cm)",
                "minimum": 50,
                "maximum": 300,
            },
            "note": {"type": "string", "title": "Note"},
        },
        "required": ["gender"],
    }
    assert captured["ui_schema"] == {
        "gender": {
            "ui:widget": "radio",
            "ui:options": {"inline": True},
            "ui:enumNames": ["Male", "Female"],
        },
        "height_cm": {
            "ui:options": {"step": 0.5},
            "ui:placeholder": "e.g. 165",
        },
        "note": {"ui:placeholder": "Optional note", "ui:widget": "textarea"},
        "ui:field": "LayoutGridField",
        "ui:layoutGrid": {
            "ui:row": {
                "children": [
                    {
                        "ui:row": {
                            "columns": 1,
                            "children": [
                                {"ui:col": {"span": 1, "children": ["gender"]}}
                            ],
                        }
                    },
                    {
                        "ui:row": {
                            "columns": 2,
                            "children": [
                                {
                                    "ui:col": {
                                        "span": 1,
                                        "children": ["height_cm"],
                                    }
                                },
                                {"ui:col": {"span": 1, "children": ["note"]}},
                            ],
                        }
                    },
                ]
            }
        },
    }
