#!/usr/bin/env python3
"""Standalone finance Skill runtime. Python 3.9+, standard library only.

Accepts the same JSON requests as calculate.mjs; never invokes Node or the network.
"""
import calendar
import datetime as dt
import json
import math
from pathlib import Path
import re
import sys


def require(condition, message):
    if not condition:
        raise ValueError(message)


def number(value, label):
    require(type(value) in (int, float) and math.isfinite(value),
            f"{label}必须是有限数字，不能为 null、布尔值或字符串")
    return value


def integer(value):
    return type(value) in (int, float) and math.isfinite(value) and value == int(value)


def obj(value, label="input"):
    require(isinstance(value, dict), f"{label}必须是对象")


def keys(value, allowed, label="input"):
    obj(value, label)
    for key in value:
        require(key in allowed, f"{label}包含未知字段 {key}")


def date(value):
    require(isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value), "日期无效")
    return dt.date.fromisoformat(value)


def series(value, field):
    require(isinstance(value, list), "序列必须是数组")
    seen, result = set(), []
    for point in value:
        keys(point, ("date", field), "序列")
        when = date(point.get("date"))
        amount = number(point.get(field), field)
        if field == "value":
            require(amount > 0, "净值必须大于0")
            require(when not in seen, "净值序列包含重复日期")
        seen.add(when)
        result.append((when, amount))
    return sorted(result, key=lambda point: point[0])


def mean(values):
    return sum(values) / len(values)


def variance(values):
    average = mean(values)
    return sum((value - average) ** 2 for value in values) / (len(values) - 1) if len(values) > 1 else 0


def exp(value):
    try:
        return math.exp(value)
    except OverflowError:
        return math.inf


def xirr(cash_flows):
    flows = series(cash_flows, "amount")
    require(len(flows) >= 2, "至少需要两笔现金流")
    require(flows[0][0] != flows[-1][0], "现金流必须跨越至少两个不同日期")
    require(any(v < 0 for _, v in flows) and any(v > 0 for _, v in flows),
            "至少需要一笔投入和一笔流入，投入填负数、流入填正数")
    normalized = [((d - flows[0][0]).days / 365, v) for d, v in flows]

    def npv(log_rate):
        return sum(v * exp(-t * log_rate) for t, v in normalized)

    def derivative(log_rate):
        return sum(-t * v * exp(-t * log_rate) for t, v in normalized)

    def sign(value):
        return (value > 0) - (value < 0)

    def bisect(low, high, fn):
        low_value = fn(low)
        for _ in range(240):
            middle = (low + high) / 2
            middle_value = fn(middle)
            if middle_value == 0 or abs(high - low) < 1e-13:
                return middle
            if sign(low_value) == sign(middle_value):
                low, low_value = middle, middle_value
            else:
                high = middle
        return (low + high) / 2

    low, high = math.log(0.000001), math.log(10001)
    roots = []
    previous, old_value, old_derivative = low, npv(low), derivative(low)
    for index in range(1, 721):
        current = low + (high - low) * index / 720
        value, slope = npv(current), derivative(current)
        if math.isfinite(old_value) and math.isfinite(value) and sign(old_value) != sign(value):
            roots.append(math.exp(bisect(previous, current, npv)) - 1)
        if math.isfinite(old_derivative) and math.isfinite(slope) and sign(old_derivative) != sign(slope):
            stationary = bisect(previous, current, derivative)
            residual = abs(npv(stationary))
            scale = sum(abs(v) * exp(-t * stationary) for t, v in normalized)
            if math.isfinite(residual) and math.isfinite(scale) and residual <= max(1, scale) * 1e-10:
                roots.append(math.exp(stationary) - 1)
        previous, old_value, old_derivative = current, value, slope
    ordered = sorted(roots)
    roots = [r for i, r in enumerate(ordered) if i == 0 or abs(r - ordered[i - 1]) > 1e-7]
    require(roots, "在-99.9999%至1,000,000%的范围内没有找到可用XIRR")
    rate = min(roots, key=lambda r: abs(r - 0.1))
    residual = sum(v / (1 + rate) ** t for t, v in normalized)
    return dict(rate=rate, roots=roots, multipleRoots=len(roots) > 1, netPresentValue=residual)


def annualized(p):
    initial, ending, days, income = p["initialValue"], p["endingValue"], p["days"], p.get("income", 0)
    require(initial > 0 and days > 0, "初始投入和持有天数必须大于0")
    total = ending + income
    require(total > 0, "期末价值加现金收入必须大于0，才能计算复合年化")
    return dict(initialValue=initial, endingValue=ending, income=income, days=days,
                totalEndingValue=total, holdingPeriodRate=total / initial - 1,
                annualizedRate=(total / initial) ** (365 / days) - 1)


def sharpe(p):
    returns, periods, rf = p["returns"], p["periodsPerYear"], p["riskFreeRate"]
    require(isinstance(returns, list) and len(returns) >= 2, "夏普比率至少需要两个等间隔收益率观测值")
    require(integer(periods) and periods > 0, "periodsPerYear必须为正整数年化周期数")
    require(rf > -1, "riskFreeRate必须大于-100%")
    for value in returns:
        require(number(value, "returns收益率") >= -1, "单期收益率不能低于-100%")
    offsets = [r - returns[0] for r in returns]
    avg_offset = mean(offsets)
    avg = returns[0] + avg_offset
    deviation = math.sqrt(sum((r - avg_offset) ** 2 for r in offsets) / (len(returns) - 1))
    period_rf = (1 + rf) ** (1 / periods) - 1
    excess = avg - period_rf
    return dict(observations=len(returns), periodsPerYear=periods, riskFreeRate=rf,
                periodRiskFreeRate=period_rf, meanPeriodRate=avg, meanExcessPeriodRate=excess,
                periodVolatility=deviation, annualArithmeticRate=avg * periods,
                annualVolatility=deviation * math.sqrt(periods),
                sharpeRatio=None if deviation == 0 else excess / deviation * math.sqrt(periods))


def fund_cost(p):
    initial, rate, days = p["initialValue"], p["annualRate"], p["horizonDays"]
    management, redemption, basis = p["managementFeeRate"], p["redemptionFeeRate"], p["rateBasis"]
    require(initial > 0 and days > 0 and rate > -1, "基金投入、期限或收益率无效")
    require(0 <= management < 1 and 0 <= redemption < 1, "基金费率必须在0%至100%之间")
    require(basis in ("net", "gross"), "rateBasis必须为 net 或 gross")
    factor = (1 - management / 365) ** days
    entered = initial * (1 + rate) ** (days / 365)
    before = entered if basis == "gross" else entered / factor
    after = entered * factor if basis == "gross" else entered
    fee = after * redemption
    ending = after - fee
    return dict(initialValue=initial, endingValue=ending, beforeManagementValue=before,
                afterManagementValue=after, managementFeeImpact=before - after,
                redemptionFeeAmount=fee, managementFeeRate=management, redemptionFeeRate=redemption,
                rateBasis=basis, holdingPeriodRate=ending / initial - 1,
                annualizedRate=(ending / initial) ** (365 / days) - 1)


def month_ends(values):
    by_month = {}
    for d, v in values:
        by_month[(d.year, d.month)] = (d, v)
    return list(by_month.values())


def returns_of(values):
    return [values[i][1] / values[i - 1][1] - 1 for i in range(1, len(values))]


def fund_metrics(p):
    values = series(p["history"], "value")
    require(len(values) >= 2, "基金收益序列至少需要两个观测值")
    rf, periods = p.get("riskFreeRate", 0.015), p.get("periodsPerYear", 12)
    require(rf > -1 and periods > 0, "无风险收益率或年化周期数无效")
    days = (values[-1][0] - values[0][0]).days
    growth = values[-1][1] / values[0][1]
    internal = xirr([dict(date=d.isoformat(), amount=v * (-1 if i == 0 else 1))
                     for i, (d, v) in enumerate([values[0], values[-1]])])["rate"]
    peak, drawdown = values[0][1], 0
    for _, value in values:
        peak = max(peak, value)
        drawdown = min(drawdown, value / peak - 1)
    monthly = month_ends(values)
    require(len(monthly) >= 3, "基金风险指标至少需要三个自然月的观测值")
    returns = returns_of(monthly)
    avg, deviation = mean(returns), math.sqrt(variance(returns))
    period_rf = (1 + rf) ** (1 / periods) - 1
    beta, observations = None, 0
    if p.get("benchmarkHistory") is not None:
        benchmark = series(p["benchmarkHistory"], "value")
        require(len(benchmark) >= 2, "基准收益序列至少需要两个观测值")
        funds = {(d.year, d.month): v for d, v in monthly}
        aligned = [(d, funds[(d.year, d.month)], v) for d, v in month_ends(benchmark)
                   if (d.year, d.month) in funds]
        if len(aligned) >= 3:
            f = [aligned[i][1] / aligned[i - 1][1] - 1 for i in range(1, len(aligned))]
            b = [aligned[i][2] / aligned[i - 1][2] - 1 for i in range(1, len(aligned))]
            cov = sum((x - mean(f)) * (y - mean(b)) for x, y in zip(f, b)) / (len(f) - 1)
            beta = cov / variance(b) if variance(b) else None
            observations = len(f)
    return dict(startDate=values[0][0].isoformat(), endDate=values[-1][0].isoformat(),
                holdingDays=days, observations=len(values), riskObservations=len(returns),
                betaObservations=observations, holdingPeriodRate=growth - 1,
                expectedAnnualRate=avg * periods, geometricAnnualRate=growth ** (365 / days) - 1,
                internalRate=internal, maxDrawdown=drawdown, annualVolatility=deviation * math.sqrt(periods),
                beta=beta, sharpeRatio=None if deviation == 0 else (avg - period_rf) / deviation * math.sqrt(periods))


def composite(p):
    geometric, drawdown, volatility = p["geometricAnnualRate"], p["maxDrawdown"], p["annualVolatility"]
    days, horizon = p["holdingDays"], p.get("targetHorizonDays", p["holdingDays"])
    redemption, weight = p.get("redemptionFeeRate", 0), p.get("riskAversion", 2)
    require(geometric > -1 and -1 < drawdown <= 0 and volatility >= 0, "几何年化、最大回撤或波动率无效")
    require(days > 0 and horizon > 0 and 0 <= redemption < 1 and weight >= 0, "期限、赎回费率或风险厌恶系数无效")
    adjusted = ((1 + geometric) ** (horizon / 365) * (1 - redemption)) ** (365 / horizon) - 1
    dp, vp = abs(drawdown) / (days / 365), 0.5 * weight * volatility ** 2
    return dict(compositeAnnualRate=adjusted - dp - vp, costAdjustedGeometricRate=adjusted,
                drawdownPenalty=dp, volatilityPenalty=vp, redemptionFeeRate=redemption, riskAversion=weight)


def projected(p):
    initial, rate, days = p["initialValue"], p["annualRate"], p["horizonDays"]
    term, rollover = p.get("productTermDays"), p.get("rollover", False)
    require(initial > 0 and rate > -1 and days > 0, "本金、收益率或期限无效")
    compounding = p.get("termCompounding", "simple")
    require(compounding in ("simple", "compound"), "产品计息方式无效")
    completed, remaining, matured = 0, days, False
    if term is None:
        ending = initial * (1 + rate) ** (days / 365)
    else:
        def growth(period):
            return (1 + rate) ** (period / 365) if compounding == "compound" else 1 + rate * period / 365
        require(term > 0 and growth(term) > 0, "产品期限或到期价值无效")
        if days < term:
            ending = initial * growth(days)
        else:
            matured = True
            completed = math.floor(days / term) if rollover else 1
            remaining = days - completed * term if rollover else 0
            ending = initial * growth(term) ** completed
            if rollover and remaining > 0:
                ending *= growth(remaining)
    require(ending > 0, "期末价值必须大于0")
    return dict(initialValue=initial, endingValue=ending, totalEndingValue=ending, horizonDays=days,
                holdingPeriodRate=ending / initial - 1, annualizedRate=(ending / initial) ** (365 / days) - 1,
                completedTerms=completed, remainingDays=remaining, maturityReached=matured, rollover=rollover)


def savings_bond(p):
    initial, rate, days, term = (p[key] for key in ("initialValue", "annualRate", "horizonDays", "productTermDays"))
    rollover, fee_rate = p.get("rollover", False), p.get("earlyRedemptionFeeRate", 0)
    require(initial > 0 and rate > -1 and days > 0 and term > 0, "国债本金、利率或期限无效")
    require(0 <= fee_rate < 1, "国债提前兑取手续费率无效")
    tiers = p.get("earlyRedemptionTiers", [])
    require(isinstance(tiers, list), "earlyRedemptionTiers必须为数组")
    for tier in tiers:
        keys(tier, ("minDays", "maxDays", "annualRate"), "提前兑取分档")
        for key in ("minDays", "maxDays", "annualRate"):
            number(tier.get(key), key)
        require(0 <= tier["minDays"] < tier["maxDays"] and tier["annualRate"] > -1, "国债提前兑取分档规则无效")
    ordered = sorted(tiers, key=lambda t: t["minDays"])
    require(all(ordered[i]["minDays"] >= ordered[i - 1]["maxDays"] for i in range(1, len(ordered))), "国债提前兑取分档不能重叠")
    completed = 0 if days < term else math.floor(days / term) if rollover else 1
    remaining = days if days < term else days - completed * term if rollover else 0
    early = days < term or (rollover and remaining > 0)
    growth = 1 + rate * term / 365
    require(growth > 0, "国债到期价值必须大于0")
    ending = initial * growth ** completed
    applied, fee = None, 0
    if early:
        require("earlyRedemptionFeeRate" in p, "提前兑取须明确 earlyRedemptionFeeRate，免费也须填写0")
        tier = next((t for t in tiers if t["minDays"] <= remaining < t["maxDays"]), None)
        require(tier is not None, "提前兑取分档未覆盖实际持有天数")
        applied = tier["annualRate"]
        fee = ending * fee_rate
        ending += ending * applied * remaining / 365 - fee
    require(ending > 0, "期末价值必须大于0")
    return dict(initialValue=initial, endingValue=ending, totalEndingValue=ending, horizonDays=days,
                holdingPeriodRate=ending / initial - 1, annualizedRate=(ending / initial) ** (365 / days) - 1,
                applicableAnnualRate=applied if early else rate, completedTerms=completed, remainingDays=remaining,
                maturityReached=days >= term, rollover=rollover, earlyRedemptionApplied=bool(early),
                appliedEarlyRedemptionRate=applied, redemptionFeeRate=fee_rate if early else 0, redemptionFeeAmount=fee)


def anniversary(start, years, clamp=False):
    year = start.year + years
    if clamp:
        return dt.date(year, start.month, min(start.day, calendar.monthrange(year, start.month)[1]))
    # Preserve the existing insurance action's JavaScript Feb 29 -> March 1 rule.
    return dt.date(year, start.month, 1) + dt.timedelta(days=start.day - 1)


def insurance(p):
    premium, years, days = p["totalPremium"], p["paymentYears"], p["horizonDays"]
    guaranteed, illustrated = p["guaranteedValue"], p["illustratedValue"]
    require(premium > 0 and integer(years) and years > 0, "总保费必须大于0，缴费年数必须为正整数")
    require(integer(days) and days > 0, "保险 horizonDays 必须为正整数实际天数")
    require(years <= math.ceil(days / 365), "缴费年数不能超过比较期限内可发生的年度数")
    require(guaranteed > 0 and illustrated > 0, "保证利益和演示利益必须大于0")
    start = date(p["startDate"])
    end = start + dt.timedelta(days=days)
    require(anniversary(start, int(years) - 1) < end, "最后缴费日期必须早于期末利益日期")
    annual = premium / years
    flows = [dict(date=anniversary(start, i).isoformat(), amount=-annual) for i in range(int(years))]
    return dict(totalPremium=premium, annualPremium=annual, paymentYears=years, horizonDays=days,
                guaranteedValue=guaranteed, illustratedValue=illustrated,
                guaranteedRate=xirr(flows + [dict(date=end.isoformat(), amount=guaranteed)])["rate"],
                illustratedRate=xirr(flows + [dict(date=end.isoformat(), amount=illustrated)])["rate"],
                guaranteedHoldingPeriodRate=guaranteed / premium - 1, illustratedHoldingPeriodRate=illustrated / premium - 1)


def insurance_table(p):
    keys(p, ("annualPremium", "paymentYears", "premiumTiming", "timeBasis", "startDate", "rows"))
    premium, years = number(p.get("annualPremium"), "annualPremium"), number(p.get("paymentYears"), "paymentYears")
    require(premium > 0 and integer(years) and years > 0, "年缴保费必须大于0，缴费年数必须为正整数")
    require(p.get("premiumTiming") == "year-start", "insurance-table须明确 premiumTiming 为 year-start；其他缴费安排使用 xirr")
    basis = p.get("timeBasis")
    require(basis in ("policy-years", "actual-dates"), "timeBasis必须明确为 policy-years 或 actual-dates")
    start = date(p.get("startDate")) if basis == "actual-dates" else None
    require(start is not None or "startDate" not in p, "保单年度口径不接受 startDate；有实际日期时选择 actual-dates")
    require(isinstance(p.get("rows"), list) and p["rows"], "rows至少需要一个利益表年度")
    warnings = ["按等额年初缴费、每个所选年度末退保测算；演示利益非保证，身故保额不能当作退保价值。"]
    warnings.append("图片未提供实际起始日期时按每保单年度365天建模，结果为年度模型 IRR，不是实际日期 XIRR。" if start is None
                    else "按保单周年日与365天年化计算 XIRR；2月29日的非闰年周年日按2月28日处理。")

    def date_at(year):
        return (anniversary(start, year, clamp=True) if start else dt.date(2001, 1, 1) + dt.timedelta(days=year * 365)).isoformat()

    seen, rows = set(), []
    for row in p["rows"]:
        keys(row, ("policyYear", "guaranteedValue", "illustratedValue"), "利益表行")
        year = row.get("policyYear")
        require(integer(year) and year > 0, "policyYear必须为正整数保单年度")
        require(year not in seen, f"重复保单年度 {year}")
        seen.add(year)
        year, count = int(year), int(min(years, year))
        paid = premium * count
        outflows = [dict(date=date_at(i), amount=-premium) for i in range(count)]
        result = dict(policyYear=year, paidPremium=paid, paidYears=count)
        values = 0
        for field, label in (("guaranteedValue", "guaranteed"), ("illustratedValue", "illustrated")):
            if field not in row:
                continue
            values += 1
            ending = number(row[field], field)
            require(ending >= 0, f"{field}不能为负数")
            flows = outflows + [dict(date=date_at(year), amount=ending)]
            scenario = dict(endingValue=ending, gain=ending - paid, holdingPeriodRate=ending / paid - 1)
            try:
                irr = xirr(flows)
                scenario.update(annualizedRate=irr["rate"], roots=irr["roots"], multipleRoots=irr["multipleRoots"])
            except ValueError as error:
                scenario.update(annualizedRate=None, error=str(error))
                warnings.append(f"第{year}年{label}口径未得到可用年化：{error}")
            scenario["cashFlows"] = flows if start else [dict(policyTime=i if i < count else year, amount=flow["amount"]) for i, flow in enumerate(flows)]
            result[label] = scenario
        require(values, "每行至少提供一项已确认的保证或演示退保价值")
        rows.append(result)
    result = dict(annualPremium=premium, paymentYears=years, totalPlannedPremium=premium * years,
                  premiumTiming=p["premiumTiming"], timeBasis=basis, rows=sorted(rows, key=lambda row: row["policyYear"]))
    if start:
        result["startDate"] = p["startDate"]
    return dict(result=result, warnings=warnings)


MODES = {
    "annualized": (annualized, "initialValue endingValue days", "income"),
    "xirr": (lambda p: xirr(p["cashFlows"]), "cashFlows", ""),
    "sharpe": (sharpe, "returns periodsPerYear riskFreeRate", ""),
    "fund-cost": (fund_cost, "initialValue annualRate horizonDays managementFeeRate redemptionFeeRate rateBasis", ""),
    "fund-metrics": (fund_metrics, "history", "benchmarkHistory riskFreeRate periodsPerYear"),
    "composite": (composite, "geometricAnnualRate maxDrawdown annualVolatility holdingDays", "targetHorizonDays redemptionFeeRate riskAversion"),
    "projected": (projected, "initialValue annualRate horizonDays", "productTermDays rollover termCompounding"),
    "savings-bond": (savings_bond, "initialValue annualRate horizonDays productTermDays", "rollover earlyRedemptionTiers earlyRedemptionFeeRate"),
    "insurance": (insurance, "totalPremium paymentYears horizonDays guaranteedValue illustratedValue startDate", ""),
}
SPECIAL = set("cashFlows history benchmarkHistory rateBasis rollover termCompounding earlyRedemptionTiers startDate returns".split())


def single(action, p):
    if action == "insurance-table":
        return insurance_table(p)
    require(action in MODES, f"不支持的 action: {action}")
    function, required, optional = MODES[action]
    keys(p, (required + " " + optional).split())
    for key in required.split():
        require(key in p and p[key] is not None, f"缺少必填参数 {key}")
    for key, value in p.items():
        if key not in SPECIAL:
            number(value, key)
    if "rollover" in p:
        require(type(p["rollover"]) is bool, "rollover必须为布尔值")
    if "productTermDays" in p:
        require(p["productTermDays"] > 0, "productTermDays必须大于0")
    result = function(p)
    warnings = []
    if action in ("projected", "savings-bond"):
        warnings.append("续投各期沿用同一利率，仅为假设，未来利率可能变化。" if p.get("rollover", False) else "产品到期后资金闲置，不继续计息。")
    if action == "projected":
        warnings.append("这是利率情景，未验证提前赎回可行性、赎回费用或产品合同限制。")
    if action == "savings-bond":
        warnings.append("储蓄国债模型将利息计入到期价值；实际逐期付息请使用现金流 XIRR。")
    if action == "insurance":
        warnings.append("假定等额年初缴费、期末一次性收回利益；演示利益非保证。")
    if action == "fund-metrics":
        warnings.append("风险指标使用月末收益和完整总回报路径；历史样本不代表未来。")
    if action == "composite":
        warnings.append("综合年化为自定义风险惩罚指标，不是标准收益率或未来收益预测。")
    if action == "annualized" and p.get("income", 0) != 0:
        warnings.append("期间收入按期末合并，不考虑实际收取时间；需按日期加权时使用 XIRR。")
    if action == "xirr" and result["multipleRoots"]:
        warnings.append("XIRR 存在多个根；展示值取最接近 10% 的根，请同时报告全部 roots。")
    if action == "sharpe":
        warnings.append("历史年化夏普采用等间隔收益、固定无风险利率及平方根年化；收益自相关可能影响该年化假设。")
        if result["sharpeRatio"] is None:
            warnings.append("收益序列零波动，夏普比率未定义，不能解释为无限大或无风险。")
        if result["observations"] < p["periodsPerYear"]:
            warnings.append("样本不足一个年度周期，夏普估计可能不稳定。")
    return dict(result=result, warnings=warnings)


def compare(p):
    keys(p, ("budget", "horizonDays", "products"))
    budget, days = number(p.get("budget"), "budget"), number(p.get("horizonDays"), "horizonDays")
    require(budget > 0 and days > 0, "统一预算和期限必须大于0")
    require(isinstance(p.get("products"), list) and len(p["products"]) >= 2, "compare至少需要两个产品")
    rows = []
    for product in p["products"]:
        keys(product, ("name", "action", "input"), "产品")
        name, action, params = product.get("name"), product.get("action"), product.get("input")
        require(isinstance(name, str) and name.strip(), "产品必须有 name")
        require(action in ("fund-cost", "projected", "savings-bond", "insurance"), "比较仅支持 fund-cost、projected、savings-bond、insurance")
        obj(params, "产品 input")
        amount_key = "totalPremium" if action == "insurance" else "initialValue"
        for key, value in ((amount_key, budget), ("horizonDays", days)):
            if key in params:
                number(params[key], key)
                require(params[key] == value, f"{name}的{key}与统一比较口径不一致")
        params = dict(params, **{amount_key: budget, "horizonDays": days})
        detail = single(action, params)
        result = detail["result"]
        if action == "insurance":
            summary = {kind: dict(endingValue=result[kind + "Value"], holdingPeriodRate=result[kind + "HoldingPeriodRate"], annualizedRate=result[kind + "Rate"])
                       for kind in ("guaranteed", "illustrated")}
        else:
            summary = {key: result[key] for key in ("endingValue", "holdingPeriodRate", "annualizedRate")}
        rows.append(dict(name=name, action=action, summary=summary, **detail))
    return dict(result=dict(budget=budget, horizonDays=days, products=rows),
                warnings=["统一总预算与期限；分期缴费的资金占用不同于一次性投入，保险年化为计划现金流 XIRR。"])


def finite_tree(value):
    if type(value) in (int, float):
        require(math.isfinite(value), "计算结果超出有限数值范围")
    elif isinstance(value, complex):
        raise ValueError("计算结果超出实数范围")
    elif isinstance(value, dict):
        for child in value.values():
            finite_tree(child)
    elif isinstance(value, list):
        for child in value:
            finite_tree(child)


def calculate(request):
    keys(request, ("action", "input", "provenance"), "请求")
    action = request.get("action")
    require(isinstance(action, str), "action必须为字符串")
    output = compare(request.get("input")) if action == "compare" else single(action, request.get("input"))
    finite_tree(output["result"])
    return dict(ok=True, action=action, **output, provenance=request.get("provenance"))


def main():
    try:
        require(len(sys.argv) <= 2, "用法: python3 calculate.py [请求.json]；无参数时读取标准输入")
        text = Path(sys.argv[1]).read_text(encoding="utf-8") if len(sys.argv) == 2 else sys.stdin.read()
        # Python's JSON decoder otherwise accepts NaN/Infinity, which are not JSON numbers.
        def reject_constant(value):
            raise ValueError(f"JSON不接受 {value}")
        request = json.loads(text, parse_constant=reject_constant)
        print(json.dumps(calculate(request), ensure_ascii=False, allow_nan=False, indent=2))
        return 0
    except (ValueError, TypeError, KeyError, ArithmeticError, OSError, RecursionError) as error:
        print(json.dumps(dict(ok=False, error=str(error)), ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
