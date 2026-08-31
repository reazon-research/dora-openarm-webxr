# Copyright 2026 Enactic, Inc.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.

"""Tests for THETA board-temperature parsing and HUD state."""

import unittest

from dora_openarm_webxr import hud, theta


class ThetaTemperatureTest(unittest.TestCase):
    """Validate the OSC field accepted by the HUD pipeline."""

    def test_extract_board_temperature(self):
        """Read the documented `_boardTemp` field as degrees Celsius."""
        self.assertEqual(
            theta._extract_board_temperature({"state": {"_boardTemp": 26}}),
            26.0,
        )

    def test_reject_invalid_board_temperature(self):
        """Reject absent, non-finite and out-of-range camera responses."""
        for payload in (
            {},
            {"state": {}},
            {"state": {"_boardTemp": "nan"}},
            {"state": {"_boardTemp": 101}},
        ):
            with (
                self.subTest(payload=payload),
                self.assertRaises((KeyError, ValueError)),
            ):
                theta._extract_board_temperature(payload)

    def test_hud_retains_only_temperature_changes(self):
        """Wake HUD clients only when a valid board temperature changes."""
        self.assertTrue(hud.set_board_temperature(31))
        self.assertEqual(hud._board_temperature, 31.0)
        self.assertFalse(hud.set_board_temperature(31))
        self.assertFalse(hud.set_board_temperature(float("inf")))


if __name__ == "__main__":
    unittest.main()
