from __future__ import annotations

import asyncio
import pathlib
import sys
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from backend.api.routes import lens_groups  # noqa: E402


class LensGroupsRouteTests(unittest.TestCase):
    def test_route_delegates_to_canonical_application_service(self):
        payload = {"tree": {"paragraphs": []}}
        request = object()
        expected = {"ok": True, "groupingResult": {"status": "usable"}}
        with patch.object(lens_groups, "group_paragraphs", return_value=expected) as service:
            actual = asyncio.run(lens_groups.groups(payload, request))
        service.assert_awaited_once_with(payload, request)
        self.assertIs(actual, expected)

    def test_canonical_path_is_registered_once(self):
        paths = [route.path for route in lens_groups.router.routes]
        self.assertEqual(paths, ["/v2/engine/runsextension/groups"])


if __name__ == "__main__":
    unittest.main()
