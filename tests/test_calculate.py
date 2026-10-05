"""Standard-library tests; Node, when present, is used only for parity checks."""
import importlib.util
import json
import math
import os
from pathlib import Path
import random
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("finance_calculate", ROOT / "scripts/calculate.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
calculate = module.calculate


def request(action, **params):
    return dict(action=action, input=params)


def examples():
    return [json.loads(match) for doc in sorted((ROOT / "references").glob("*.md"))
            for match in re.findall(r"```json\n(.*?)\n```", doc.read_text(encoding="utf-8"), re.S)]


class FinanceRuntimeTests(unittest.TestCase):
    def assert_tree_close(self, expected, actual):
        if type(expected) in (float, int):
            self.assertTrue(math.isclose(expected, actual, rel_tol=1e-8, abs_tol=1e-7), (expected, actual))
        elif isinstance(expected, dict):
            self.assertEqual(set(expected), set(actual))
            for key in expected:
                with self.subTest(field=key):
                    self.assert_tree_close(expected[key], actual[key])
        elif isinstance(expected, list):
            self.assertEqual(len(expected), len(actual))
            for left, right in zip(expected, actual):
                self.assert_tree_close(left, right)
        else:
            self.assertEqual(expected, actual)

    def test_reference_financial_answers(self):
        annual = calculate(request("annualized", initialValue=100000, endingValue=100800, days=90))["result"]
        self.assertAlmostEqual(annual["annualizedRate"], 0.03284316588779457, places=10)
        fund = calculate(request("fund-cost", initialValue=10000, annualRate=0.04, horizonDays=365,
                                 managementFeeRate=0.005, redemptionFeeRate=0.001, rateBasis="net"))["result"]
        self.assertAlmostEqual(fund["endingValue"], 10389.6)
        score = calculate(request("composite", geometricAnnualRate=0.05, maxDrawdown=-0.1,
                                  annualVolatility=0.2, holdingDays=730))["result"]
        self.assertAlmostEqual(score["compositeAnnualRate"], -0.04)
        idle = calculate(request("projected", initialValue=10000, annualRate=0.02,
                                 horizonDays=365, productTermDays=30))["result"]
        self.assertFalse(idle["rollover"])
        self.assertAlmostEqual(idle["endingValue"], 10000 * (1 + 0.02 * 30 / 365))
        bond = calculate(request("savings-bond", initialValue=10000, annualRate=0.02, horizonDays=200,
                                 productTermDays=1095, earlyRedemptionFeeRate=0.001,
                                 earlyRedemptionTiers=[dict(minDays=0, maxDays=1095, annualRate=0.01)]))["result"]
        self.assertAlmostEqual(bond["endingValue"], 10000 + 10000 * 0.01 * 200 / 365 - 10)

    def test_xirr_multiple_and_tangent_roots(self):
        for middle, ending, roots in [(230, -132, [0.1, 0.2]), (220, -121, [0.1])]:
            result = calculate(request("xirr", cashFlows=[dict(date="2025-01-01", amount=-100),
                               dict(date="2026-01-01", amount=middle), dict(date="2027-01-01", amount=ending)]))["result"]
            self.assertEqual(len(result["roots"]), len(roots))
            for actual, expected in zip(result["roots"], roots):
                self.assertAlmostEqual(actual, expected, places=7)
            self.assertAlmostEqual(result["netPresentValue"], 0, places=7)

    def test_sharpe_and_zero_variance(self):
        result = calculate(request("sharpe", returns=[0.01, 0.02, 0.03], periodsPerYear=12, riskFreeRate=0))["result"]
        self.assertAlmostEqual(result["sharpeRatio"], 2 * math.sqrt(12))
        self.assertAlmostEqual(result["annualVolatility"], 0.01 * math.sqrt(12))
        self.assertIsNone(calculate(request("sharpe", returns=[0.01] * 12, periodsPerYear=12, riskFreeRate=0.015))["result"]["sharpeRatio"])

    def test_insurance_dates_and_partial_values(self):
        result = calculate(request("insurance-table", annualPremium=10000, paymentYears=3,
                           premiumTiming="year-start", timeBasis="policy-years",
                           rows=[dict(policyYear=1, guaranteedValue=6000), dict(policyYear=5, illustratedValue=35000)]))["result"]
        self.assertEqual(result["rows"][0]["paidPremium"], 10000)
        self.assertNotIn("illustrated", result["rows"][0])
        self.assertAlmostEqual(result["rows"][0]["guaranteed"]["annualizedRate"], -0.4)
        leap = calculate(request("insurance-table", annualPremium=10000, paymentYears=2,
                         premiumTiming="year-start", timeBasis="actual-dates", startDate="2024-02-29",
                         rows=[dict(policyYear=2, guaranteedValue=22000)]))["result"]
        self.assertEqual([f["date"] for f in leap["rows"][0]["guaranteed"]["cashFlows"]],
                         ["2024-02-29", "2025-02-28", "2026-02-28"])
        zero = calculate(request("insurance-table", annualPremium=10000, paymentYears=1,
                         premiumTiming="year-start", timeBasis="policy-years", rows=[dict(policyYear=1, guaranteedValue=0)]))["result"]
        self.assertIsNone(zero["rows"][0]["guaranteed"]["annualizedRate"])

    def test_rejects_invalid_data(self):
        invalid = [
            request("annualized", initialValue=True, endingValue=10, days=365),
            request("annualized", initialValue=100, endingValue=None, days=365),
            request("projected", initialValue=100, annualRate="0.02", horizonDays=365),
            request("projected", initialValue=100, annualRate=0.02, horizonDays=365, rollover="false"),
            request("xirr", cashFlows=[dict(date="2025-02-30", amount=-100), dict(date="2026-02-28", amount=110)]),
            request("sharpe", returns=[0.01], periodsPerYear=12, riskFreeRate=0),
            request("savings-bond", initialValue=100, annualRate=0.02, horizonDays=30, productTermDays=365),
            request("fund-metrics", history=[dict(date="2025-01-01", value=1)] * 3),
            request("compare", budget=100, horizonDays=365, products=[
                dict(name="A", action="projected", input=dict(initialValue=200, annualRate=0.02)),
                dict(name="B", action="projected", input=dict(annualRate=0.02))]),
        ]
        for item in invalid:
            with self.subTest(action=item["action"]), self.assertRaises((ValueError, TypeError)):
                calculate(item)

    def test_all_examples_and_cli_without_node(self):
        # Copy only the Python executable script; remove Node from the child PATH.
        with tempfile.TemporaryDirectory(prefix="finance-python-only-") as directory:
            cli = Path(directory) / "calculate.py"
            shutil.copyfile(ROOT / "scripts/calculate.py", cli)
            environment = dict(os.environ, PATH=directory, PYTHONIOENCODING="utf-8")
            self.assertIsNone(shutil.which("node", path=directory))
            samples = examples()
            self.assertEqual(len(samples), 14)
            for item in samples:
                run = subprocess.run([sys.executable, str(cli)], input=json.dumps(item), text=True,
                                     capture_output=True, cwd=directory, env=environment)
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
                self.assertTrue(json.loads(run.stdout)["ok"])
            input_file = Path(directory) / "input.json"
            input_file.write_text(json.dumps(samples[0]), encoding="utf-8")
            run = subprocess.run([sys.executable, str(cli), str(input_file)], text=True,
                                 capture_output=True, cwd=directory, env=environment)
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            for invalid in ["{", "{}", '{"action":"annualized","input":{"initialValue":NaN}}']:
                run = subprocess.run([sys.executable, str(cli)], input=invalid, text=True,
                                     capture_output=True, cwd=directory, env=environment)
                self.assertEqual(run.returncode, 1)
                self.assertFalse(json.loads(run.stdout)["ok"])

    @unittest.skipUnless(shutil.which("node"), "Node optional: parity test only")
    def test_cross_runtime_parity(self):
        samples = examples()
        samples += [request("composite", geometricAnnualRate=0.05, maxDrawdown=-0.1, annualVolatility=0.2, holdingDays=730)]
        rng = random.Random(20261005)
        for _ in range(20):
            samples += [
                request("annualized", initialValue=10000, endingValue=rng.uniform(5000, 30000), days=rng.randint(1, 3650)),
                request("sharpe", returns=[rng.uniform(-0.1, 0.1) for _ in range(12)], periodsPerYear=12, riskFreeRate=0.015),
                request("fund-cost", initialValue=10000, annualRate=rng.uniform(-0.2, 0.2), horizonDays=rng.randint(1, 2000), managementFeeRate=0.005, redemptionFeeRate=0.001, rateBasis=rng.choice(["net", "gross"])),
                request("projected", initialValue=10000, annualRate=0.03, horizonDays=rng.randint(1, 2000), productTermDays=90, rollover=rng.choice([True, False]), termCompounding=rng.choice(["simple", "compound"])),
            ]
        for final in (110, -132, -121):
            flows = [dict(date="2025-01-01", amount=-100), dict(date="2026-01-01", amount=final)] if final > 0 else [dict(date="2025-01-01", amount=-100), dict(date="2026-01-01", amount=230 if final == -132 else 220), dict(date="2027-01-01", amount=final)]
            samples.append(request("xirr", cashFlows=flows))
        samples.append(request("insurance", totalPremium=20000, paymentYears=2, horizonDays=1461,
                               guaranteedValue=22000, illustratedValue=24000, startDate="2024-02-29"))
        samples.append(request("insurance-table", annualPremium=10000, paymentYears=2,
                               premiumTiming="year-start", timeBasis="actual-dates", startDate="2024-02-29",
                               rows=[dict(policyYear=2, guaranteedValue=22000)]))
        samples.append(request("savings-bond", initialValue=10000, annualRate=0.02, horizonDays=800,
                               productTermDays=365, rollover=True, earlyRedemptionFeeRate=0.001,
                               earlyRedemptionTiers=[dict(minDays=0, maxDays=365, annualRate=0.005)]))
        history = [dict(date="2025-01-31", value=100), dict(date="2025-02-28", value=101), dict(date="2025-03-31", value=99)]
        samples.append(request("fund-metrics", history=history, benchmarkHistory=history))
        javascript = "import {readFileSync} from 'node:fs'; import {calculate} from './scripts/calculate.mjs'; process.stdout.write(JSON.stringify(JSON.parse(readFileSync(0,'utf8')).map(calculate)));"
        run = subprocess.run([shutil.which("node"), "--input-type=module", "-e", javascript], input=json.dumps(samples),
                             text=True, capture_output=True, cwd=ROOT, check=True)
        for item, expected in zip(samples, json.loads(run.stdout)):
            with self.subTest(action=item["action"]):
                self.assert_tree_close(expected, calculate(item))


if __name__ == "__main__":
    unittest.main()
