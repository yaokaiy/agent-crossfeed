import json

from helpers import CrossfeedCase, load_crossfeed, run_crossfeed


SPAWN = {"type": "spawn", "session": "session", "origin": "workflow", "outcome": "refused",
         "run_id": "wf_one", "agent_index": 2, "model": None}
BREAKER = {"type": "breaker", "session": "session", "task_id": "task", "run_id": "wf_one",
           "outcome": "denied", "reason": "permission rule"}
WAKE = {"type": "wake", "session": "session", "trigger": "pace", "outcome": "prompt"}


class RecordTests(CrossfeedCase):
    def record(self, payload, written, skipped):
        result = run_crossfeed(["record"], stdin=payload, env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"written": written, "skipped": skipped})
        return load_crossfeed().read_ledger()

    def test_json_lines_accept_each_type_and_preserve_order(self):
        unconfirmed = dict(SPAWN, outcome="unconfirmed")
        expected = [SPAWN, BREAKER, WAKE, unconfirmed]
        data = [dict(SPAWN, v=99, ts="forged", extra="ignored"), BREAKER, WAKE, unconfirmed]
        payload = "\n".join(map(json.dumps, data)).encode()
        records = self.record(payload, len(expected), 0)
        self.assertEqual(len(records), len(expected))
        for record, row in zip(records, expected):
            self.assertEqual(record.pop("v"), 1)
            self.assertTrue(record.pop("ts").endswith("Z"))
            self.assertEqual(record, row)

    def test_skips_bad_json_encoding_and_fields_and_keeps_valid_lines(self):
        invalid = [
            b"bad JSON", b"\xff", b"[]", b"", b'{"type":"decision"}',
            json.dumps(dict(SPAWN, origin="unknown")).encode(),
            json.dumps(dict(SPAWN, agent_index=True)).encode(),
            json.dumps(dict(BREAKER, task_id="")).encode(),
            json.dumps(dict(BREAKER, reason="\ud800")).encode(),
            json.dumps(dict(WAKE, outcome="invalid")).encode(),
            b'{"type":"wake","trigger":"pace","outcome":"notice","extra":NaN}',
        ]
        valid = json.dumps(WAKE).encode()
        records = self.record(b"\n".join([valid, *invalid, valid]), 2, len(invalid))
        self.assertEqual([record["type"] for record in records], ["wake", "wake"])

    def test_empty_input_is_success_and_writes_no_ledger(self):
        self.assertEqual(self.record(b"", 0, 0), [])
        self.assertFalse((self.home / "ledger.jsonl").exists())

    def test_crlf_and_a_leading_utf8_bom(self):
        payload = ("\ufeff" + json.dumps(SPAWN) + "\r\n" + json.dumps(WAKE) + "\r\n").encode()
        self.assertEqual([row["type"] for row in self.record(payload, 2, 0)], ["spawn", "wake"])
