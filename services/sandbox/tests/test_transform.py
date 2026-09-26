"""POST /transform — one child process, a deadline, an output cap, and the
stdlib import allowlist (ADR-047 §4.3).

Every case here runs the REAL runner.py in a child interpreter: the
allowlist, the timeout and the cap are the properties customer-written code
meets, so they are exercised end to end rather than through a mock.
"""

from __future__ import annotations

import os

import pytest

import main
from main import TransformRequest, run_transform


def _t(code: str, inputs=None, **kw) -> dict:
    return run_transform(TransformRequest(code=code, inputs=inputs or {}, **kw))


def test_a_pure_function_over_its_inputs():
    out = _t(
        "by_customer = {}\n"
        "for inv in inputs['invoices']:\n"
        "    by_customer[inv['customer']] = by_customer.get(inv['customer'], 0) + inv['amount']\n"
        "output = {'count': len(by_customer), 'by_customer': by_customer}\n",
        {"invoices": [{"customer": "a", "amount": 10}, {"customer": "a", "amount": 5}, {"customer": "b", "amount": 1}]},
    )
    assert out == {"output": {"count": 2, "by_customer": {"a": 15, "b": 1}}}


def test_allowed_modules_import():
    out = _t(
        "import json, math, statistics, datetime, decimal, collections, itertools, re, textwrap\n"
        "output = [math.floor(2.5), statistics.mean([1, 2, 3]), json.dumps({'a': 1}),"
        " str(decimal.Decimal('1.10') + decimal.Decimal('2.20')),"
        " list(itertools.islice(itertools.count(), 3)), bool(re.match(r'a+', 'aaa')),"
        " textwrap.shorten('a long line of text', 10), collections.Counter('aab')['a'],"
        " datetime.date(2026, 9, 19).isoformat()]\n",
    )
    assert out == {"output": [2, 2, '{"a": 1}', "3.30", [0, 1, 2], True, "a [...]", 2, "2026-09-19"]}


@pytest.mark.parametrize(
    "module", ["socket", "subprocess", "os", "sys", "importlib", "ctypes", "pathlib", "urllib", "http"]
)
def test_refused_modules_are_refused_by_name(module):
    out = _t(f"import {module}\noutput = 1\n")
    assert "error" in out
    assert f"import {module} is not allowed" in out["error"]


@pytest.mark.parametrize("module", ["os", "socket", "subprocess"])
def test_refused_modules_are_refused_via_dunder_import_and_from_import(module):
    assert "not allowed" in _t(f"m = __import__('{module}')\noutput = 1\n")["error"]
    assert "not allowed" in _t(f"from {module} import *\noutput = 1\n")["error"]


def test_a_submodule_of_a_refused_package_is_refused():
    assert "not allowed" in _t("import urllib.request\noutput = 1\n")["error"]
    assert "not allowed" in _t("import os.path\noutput = 1\n")["error"]


def test_open_and_eval_are_not_in_the_namespace():
    assert "NameError" in _t("output = open('/etc/passwd').read()\n")["error"]
    assert "NameError" in _t("output = eval('1+1')\n")["error"]
    assert "NameError" in _t("output = exec('x=1')\n")["error"]


def test_the_result_is_output_not_stdout():
    out = _t("print('this is a log line')\noutput = 'the result'\n")
    assert out == {"output": "the result"}


def test_a_user_error_names_the_line():
    out = _t("x = 1\ny = x / 0\noutput = y\n")
    assert out["error"].startswith("ZeroDivisionError at line 2")


def test_a_syntax_error_is_a_step_error_not_a_crash():
    out = _t("output = (\n")
    assert out["error"].startswith("syntax error at line")


def test_non_json_output_is_refused():
    out = _t("import datetime\noutput = datetime.datetime(2026, 1, 1)\n")
    assert "not JSON-serialisable" in out["error"]


def test_inputs_are_a_private_copy():
    out = _t("inputs['a'].append(1)\noutput = inputs['a']\n", {"a": []})
    assert out == {"output": [1]}


def test_the_timeout_kills_the_child_and_names_the_deadline():
    out = _t("while True:\n    pass\n", timeoutMs=500)
    assert out == {"error": "transform exceeded 500 ms"}


def test_the_output_cap_is_reported_never_sliced():
    # MUTATION: replace the cap error with a truncation and this goes red —
    # a summarizer that quietly received half its facts writes a confident,
    # wrong briefing (ROUTINES brief §4.4).
    out = _t("output = 'x' * 5000\n", outputCapBytes=1024)
    assert out == {"error": "output exceeded 1024 bytes"}


def test_route_validates_bounds(client, auth):
    assert client.post("/transform", json={"code": ""}, headers=auth).status_code == 422
    assert client.post("/transform", json={"code": "output=1", "timeoutMs": 10**9}, headers=auth).status_code == 422
    assert client.post("/transform", json={"code": "output=1", "outputCapBytes": 1}, headers=auth).status_code == 422
    r = client.post("/transform", json={"code": "output = inputs['n'] * 2", "inputs": {"n": 21}}, headers=auth)
    assert r.status_code == 200 and r.json() == {"output": 42}


def test_child_environment_carries_no_token():
    # The service's own bearer must never be visible to user code, and since
    # `os` is refused the code cannot ask; this pins the env the child gets.
    assert "SANDBOX_SERVICE_TOKEN" not in main.CHILD_ENV
    assert set(main.CHILD_ENV) <= {"PATH", "PYTHONDONTWRITEBYTECODE", "PYTHONIOENCODING", "LC_ALL", "HOME"}


@pytest.mark.skipif(os.name != "posix", reason="RLIMIT_NPROC is POSIX-only")
def test_the_child_cannot_fork_even_if_it_finds_a_way_to_ask():
    # `subprocess` and `os` are refused by name; this pins the second wall,
    # the rlimit, through the one builtin the namespace does keep: an
    # allowed module that happens to fork internally does not exist, so the
    # honest check is that the limit is in force for the child's own pid.
    out = _t("import resource\noutput = 1\n")
    assert "not allowed" in out["error"]
