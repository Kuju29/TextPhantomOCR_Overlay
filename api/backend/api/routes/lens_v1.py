"""HTTP routes for Google Lens operations."""

from fastapi import APIRouter

from backend.application.lens_service import lens_decode, lens_fallback, lens_raw

router = APIRouter()

router.post("/v1/lens/decode")(lens_decode)
router.post("/v1/lens/raw")(lens_raw)
router.post("/v2/engine/runsextension/lens/raw")(lens_raw)
router.post("/v1/lens/fallback")(lens_fallback)
