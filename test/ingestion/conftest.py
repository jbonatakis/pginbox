from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType

import pytest


ROOT = Path(__file__).resolve().parents[2]


def _load_ingest_module() -> ModuleType:
    spec = spec_from_file_location("ingest", ROOT / "src/ingestion/ingest.py")
    assert spec is not None
    ingest = module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(ingest)
    return ingest


@pytest.fixture
def ingest() -> ModuleType:
    return _load_ingest_module()
