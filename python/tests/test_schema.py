"""The published JSON Schema agrees with the validator on every fixture."""

import json
from pathlib import Path

import pytest

from zarr_inline.validator import validate

SCHEMA_PATH = Path(__file__).resolve().parents[2] / "docs" / "zarr-inline.schema.json"


@pytest.fixture(scope="module")
def schema_validator():
    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads(SCHEMA_PATH.read_text())
    jsonschema.Draft202012Validator.check_schema(schema)
    return jsonschema.Draft202012Validator(schema)


def test_schema_verdict_matches_validator_on_all_fixtures(schema_validator, examples_dir, manifest):
    for rel_path, expected in manifest.items():
        document = json.loads((examples_dir / rel_path).read_text())
        schema_ok = schema_validator.is_valid(document)
        assert schema_ok == expected["valid"], rel_path
        assert schema_ok == (validate(document) == []), rel_path


@pytest.mark.parametrize(
    "document",
    [
        {"/leading": {}},
        {"a//b": "AAEC"},
        {"a/./zarr.json": {}},
        {"..": {}},
        {"zarr.json": "not an object"},
        {"a/c/0": 123},
        {"a/c/0": "not base64!"},
    ],
)
def test_schema_rejects_each_rule_violation(schema_validator, document):
    assert not schema_validator.is_valid(document)
