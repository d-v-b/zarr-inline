import json

import pytest

from zarr_json.validator import Strictness, ValidationError, validate


def test_empty_document_is_valid():
    assert validate({}) == []


def test_valid_group_document_passes():
    doc = {"zarr.json": {"zarr_format": 3, "node_type": "group", "attributes": {}}}
    assert validate(doc) == []


def test_metadata_key_with_non_object_value_reports_r2():
    errors = validate({"zarr.json": "not an object"})
    assert len(errors) == 1
    assert errors[0].rule == "R2"
    assert errors[0].key == "zarr.json"


def test_byte_key_with_non_string_value_reports_r2():
    errors = validate({"a/c/0": {"not": "a string"}})
    assert len(errors) == 1
    assert errors[0].rule == "R2"


def test_leading_slash_key_reports_r1():
    errors = validate({"/zarr.json": {}})
    assert any(e.rule == "R1" for e in errors)


def test_empty_segment_key_reports_r1():
    errors = validate({"a//zarr.json": {}})
    assert any(e.rule == "R1" for e in errors)


def test_dot_segment_key_reports_r1():
    errors = validate({"a/./zarr.json": {}})
    assert any(e.rule == "R1" for e in errors)


def test_strict_mode_raises_on_invalid_document():
    with pytest.raises(ValidationError):
        validate({"zarr.json": "not an object"}, strictness=Strictness.STRICT)


def test_lenient_mode_returns_errors_without_raising():
    errors = validate({"zarr.json": "not an object"}, strictness=Strictness.LENIENT)
    assert len(errors) == 1


def test_all_manifest_fixtures_get_expected_verdict(examples_dir, manifest):
    for rel_path, expected in manifest.items():
        doc = json.loads((examples_dir / rel_path).read_text())
        errors = validate(doc)
        if expected["valid"]:
            assert errors == [], f"{rel_path} should be valid"
        else:
            assert errors, f"{rel_path} should be invalid"
            assert any(e.rule == expected["rule"] for e in errors), (
                f"{rel_path} should fail rule {expected['rule']}"
            )


def test_trailing_slash_key_reports_r1():
    errors = validate({"a/zarr.json/": {}})
    assert any(e.rule == "R1" for e in errors)


def test_standalone_dotdot_key_reports_r1():
    errors = validate({"..": {}})
    assert any(e.rule == "R1" for e in errors)


def test_multiple_bad_keys_accumulate_issues():
    errors = validate({"/leading": "x", "trailing/": "y"})
    assert len(errors) == 2
    assert all(e.rule == "R1" for e in errors)


def test_byte_key_with_inline_json_array_is_valid():
    assert validate({"a/c/0": [[0, 1], [2, 3]]}) == []


def test_byte_key_with_number_value_reports_r2():
    errors = validate({"a/c/0": 123})
    assert len(errors) == 1
    assert errors[0].rule == "R2"
