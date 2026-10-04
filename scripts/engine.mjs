const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_DAYS = 365;

function requireFiniteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${label}必须是有效数字`);
  }
  return number;
}

function parseDate(value, label = "现金流日期") {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label}无效`);
  }

  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label}无效`);
  }
  return date;
}

export function calculateAnnualizedReturn({ initialValue, endingValue, income = 0, days }) {
  const initial = requireFiniteNumber(initialValue, "初始投入");
  const ending = requireFiniteNumber(endingValue, "期末价值");
  const cashIncome = requireFiniteNumber(income, "期间现金收入");
  const holdingDays = requireFiniteNumber(days, "持有天数");

  if (initial <= 0) {
    throw new Error("初始投入必须大于0");
  }
  if (holdingDays <= 0) {
    throw new Error("持有天数必须大于0");
  }

  const totalEndingValue = ending + cashIncome;
  const growthFactor = totalEndingValue / initial;
  if (growthFactor <= 0) {
    throw new Error("期末价值加现金收入必须大于0，才能计算复合年化");
  }

  return {
    initialValue: initial,
    endingValue: ending,
    income: cashIncome,
    days: holdingDays,
    totalEndingValue,
    holdingPeriodRate: growthFactor - 1,
    annualizedRate: growthFactor ** (YEAR_DAYS / holdingDays) - 1,
  };
}

function normalizeValueSeries(series, label) {
  if (!Array.isArray(series) || series.length < 2) {
    throw new Error(`${label}至少需要两个观测值`);
  }

  const byDate = new Map();
  series.forEach((point, index) => {
    const date = parseDate(point.date, `${label}第${index + 1}个日期`);
    const value = requireFiniteNumber(point.value, `${label}第${index + 1}个数值`);
    if (value <= 0) throw new Error(`${label}数值必须大于0`);
    byDate.set(point.date, { date: point.date, time: date.getTime(), value });
  });

  const normalized = [...byDate.values()].sort((a, b) => a.time - b.time);
  if (normalized.length < 2) throw new Error(`${label}至少需要两个不同日期的观测值`);
  return normalized;
}

function calculateReturns(series) {
  return series.slice(1).map((point, index) => ({
    date: point.date,
    rate: point.value / series[index].value - 1,
  }));
}

function toMonthEndSeries(series) {
  const byMonth = new Map();
  series.forEach((point) => byMonth.set(point.date.slice(0, 7), point));
  return [...byMonth.values()];
}

function arithmeticMean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function sampleVariance(values) {
  if (values.length < 2) return 0;
  const mean = arithmeticMean(values);
  return values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1);
}

export function calculateFundMetrics({
  history,
  benchmarkHistory = null,
  riskFreeRate = 0.015,
  periodsPerYear = 12,
}) {
  const values = normalizeValueSeries(history, "基金收益序列");
  const annualRiskFreeRate = requireFiniteNumber(riskFreeRate, "无风险收益率");
  const annualPeriods = requireFiniteNumber(periodsPerYear, "年化周期数");
  if (annualRiskFreeRate <= -1) throw new Error("无风险收益率必须大于-100%");
  if (annualPeriods <= 0) throw new Error("年化周期数必须大于0");

  const first = values[0];
  const last = values.at(-1);
  const holdingDays = (last.time - first.time) / DAY_MS;
  if (holdingDays <= 0) throw new Error("基金收益序列必须跨越至少两个日期");

  const holdingPeriodRate = last.value / first.value - 1;
  const geometricAnnualRate = (last.value / first.value) ** (YEAR_DAYS / holdingDays) - 1;
  const internalRate = calculateXirr([
    { date: first.date, amount: -first.value },
    { date: last.date, amount: last.value },
  ]).rate;

  let peak = values[0].value;
  let maxDrawdown = 0;
  values.forEach((point) => {
    peak = Math.max(peak, point.value);
    maxDrawdown = Math.min(maxDrawdown, point.value / peak - 1);
  });

  const monthlyValues = toMonthEndSeries(values);
  if (monthlyValues.length < 3) throw new Error("基金风险指标至少需要三个自然月的观测值");
  const returns = calculateReturns(monthlyValues).map((point) => point.rate);
  const meanPeriodRate = arithmeticMean(returns);
  const periodVolatility = Math.sqrt(sampleVariance(returns));
  const expectedAnnualRate = meanPeriodRate * annualPeriods;
  const annualVolatility = periodVolatility * Math.sqrt(annualPeriods);
  const periodRiskFreeRate = (1 + annualRiskFreeRate) ** (1 / annualPeriods) - 1;
  const sharpeRatio = periodVolatility === 0
    ? null
    : (meanPeriodRate - periodRiskFreeRate) / periodVolatility * Math.sqrt(annualPeriods);

  let beta = null;
  let betaObservations = 0;
  if (benchmarkHistory !== null) {
    const benchmark = toMonthEndSeries(normalizeValueSeries(benchmarkHistory, "基准收益序列"));
    const fundByMonth = new Map(monthlyValues.map((point) => [point.date.slice(0, 7), point.value]));
    const aligned = benchmark
      .filter((point) => fundByMonth.has(point.date.slice(0, 7)))
      .map((point) => ({
        month: point.date.slice(0, 7),
        fund: fundByMonth.get(point.date.slice(0, 7)),
        benchmark: point.value,
      }));

    if (aligned.length >= 3) {
      const fundReturns = [];
      const benchmarkReturns = [];
      for (let index = 1; index < aligned.length; index += 1) {
        fundReturns.push(aligned[index].fund / aligned[index - 1].fund - 1);
        benchmarkReturns.push(aligned[index].benchmark / aligned[index - 1].benchmark - 1);
      }
      const fundMean = arithmeticMean(fundReturns);
      const benchmarkMean = arithmeticMean(benchmarkReturns);
      const covariance = fundReturns.reduce((total, rate, index) => (
        total + (rate - fundMean) * (benchmarkReturns[index] - benchmarkMean)
      ), 0) / (fundReturns.length - 1);
      const benchmarkVariance = sampleVariance(benchmarkReturns);
      beta = benchmarkVariance === 0 ? null : covariance / benchmarkVariance;
      betaObservations = fundReturns.length;
    }
  }

  return {
    startDate: first.date,
    endDate: last.date,
    holdingDays,
    observations: values.length,
    riskObservations: returns.length,
    betaObservations,
    holdingPeriodRate,
    expectedAnnualRate,
    geometricAnnualRate,
    internalRate,
    maxDrawdown,
    annualVolatility,
    beta,
    sharpeRatio,
  };
}

export function calculateFundCostAdjustedReturn({
  initialValue,
  annualRate,
  horizonDays,
  managementFeeRate,
  redemptionFeeRate,
  rateBasis = "net",
}) {
  const initial = requireFiniteNumber(initialValue, "基金投入");
  const rate = requireFiniteNumber(annualRate, "基金年化收益率");
  const days = requireFiniteNumber(horizonDays, "基金持有天数");
  const managementRate = requireFiniteNumber(managementFeeRate, "基金管理费率");
  const redemptionRate = requireFiniteNumber(redemptionFeeRate, "基金赎回费率");

  if (initial <= 0) throw new Error("基金投入必须大于0");
  if (rate <= -1) throw new Error("基金年化收益率必须大于-100%");
  if (days <= 0) throw new Error("基金持有天数必须大于0");
  if (managementRate < 0 || managementRate >= 1) throw new Error("基金管理费率必须在0%至100%之间");
  if (redemptionRate < 0 || redemptionRate >= 1) throw new Error("基金赎回费率必须在0%至100%之间");
  if (!["net", "gross"].includes(rateBasis)) throw new Error("基金收益率口径无效");

  const years = days / YEAR_DAYS;
  const managementFactor = (1 - managementRate / YEAR_DAYS) ** days;
  const enteredEndingValue = initial * (1 + rate) ** years;
  const beforeManagementValue = rateBasis === "gross"
    ? enteredEndingValue
    : enteredEndingValue / managementFactor;
  const afterManagementValue = rateBasis === "gross"
    ? enteredEndingValue * managementFactor
    : enteredEndingValue;
  const managementFeeImpact = beforeManagementValue - afterManagementValue;
  const redemptionFeeAmount = afterManagementValue * redemptionRate;
  const endingValue = afterManagementValue - redemptionFeeAmount;
  const holdingPeriodRate = endingValue / initial - 1;

  return {
    initialValue: initial,
    endingValue,
    beforeManagementValue,
    afterManagementValue,
    managementFeeImpact,
    redemptionFeeAmount,
    managementFeeRate: managementRate,
    redemptionFeeRate: redemptionRate,
    rateBasis,
    holdingPeriodRate,
    annualizedRate: (endingValue / initial) ** (YEAR_DAYS / days) - 1,
  };
}

export function calculateCompositeAnnualRate({
  geometricAnnualRate,
  maxDrawdown,
  annualVolatility,
  holdingDays,
  targetHorizonDays = holdingDays,
  redemptionFeeRate = 0,
  riskAversion = 2,
}) {
  const geometricRate = requireFiniteNumber(geometricAnnualRate, "基金几何年化");
  const drawdown = requireFiniteNumber(maxDrawdown, "基金最大回撤");
  const volatility = requireFiniteNumber(annualVolatility, "基金年化波动率");
  const sampleDays = requireFiniteNumber(holdingDays, "基金样本天数");
  const horizonDays = requireFiniteNumber(targetHorizonDays, "基金目标持有天数");
  const redemptionRate = requireFiniteNumber(redemptionFeeRate, "基金赎回费率");
  const riskWeight = requireFiniteNumber(riskAversion, "风险厌恶系数");

  if (geometricRate <= -1) throw new Error("基金几何年化必须大于-100%");
  if (drawdown > 0 || drawdown <= -1) throw new Error("基金最大回撤必须在-100%至0%之间");
  if (volatility < 0) throw new Error("基金年化波动率不能小于0");
  if (sampleDays <= 0 || horizonDays <= 0) throw new Error("基金持有天数必须大于0");
  if (redemptionRate < 0 || redemptionRate >= 1) throw new Error("基金赎回费率必须在0%至100%之间");
  if (riskWeight < 0) throw new Error("风险厌恶系数不能小于0");

  const horizonGrowth = (1 + geometricRate) ** (horizonDays / YEAR_DAYS);
  const costAdjustedGeometricRate = (horizonGrowth * (1 - redemptionRate)) ** (YEAR_DAYS / horizonDays) - 1;
  const drawdownPenalty = Math.abs(drawdown) / (sampleDays / YEAR_DAYS);
  const volatilityPenalty = 0.5 * riskWeight * volatility ** 2;

  return {
    compositeAnnualRate: costAdjustedGeometricRate - drawdownPenalty - volatilityPenalty,
    costAdjustedGeometricRate,
    drawdownPenalty,
    volatilityPenalty,
    redemptionFeeRate: redemptionRate,
    riskAversion: riskWeight,
  };
}

export function calculateProjectedReturn({
  initialValue,
  annualRate,
  horizonDays,
  productTermDays = null,
  rollover = true,
  termCompounding = "simple",
}) {
  const initial = requireFiniteNumber(initialValue, "比较本金");
  const rate = requireFiniteNumber(annualRate, "年化收益假设");
  const days = requireFiniteNumber(horizonDays, "比较期限");

  if (initial <= 0) throw new Error("比较本金必须大于0");
  if (rate <= -1) throw new Error("年化收益假设必须大于-100%");
  if (days <= 0) throw new Error("比较期限必须大于0");

  let endingValue;
  let completedTerms = 0;
  let remainingDays = days;
  let maturityReached = false;

  if (productTermDays === null || productTermDays === "") {
    endingValue = initial * (1 + rate) ** (days / YEAR_DAYS);
  } else {
    const termDays = requireFiniteNumber(productTermDays, "产品期限");
    if (termDays <= 0) throw new Error("产品期限必须大于0");

    if (!["simple", "compound"].includes(termCompounding)) {
      throw new Error("产品计息方式无效");
    }
    const growthForDays = (periodDays) => termCompounding === "compound"
      ? (1 + rate) ** (periodDays / YEAR_DAYS)
      : 1 + rate * periodDays / YEAR_DAYS;
    const termGrowth = growthForDays(termDays);
    if (termGrowth <= 0) throw new Error("当前收益率和产品期限会使到期价值小于等于0");

    if (days < termDays) {
      endingValue = initial * growthForDays(days);
    } else {
      maturityReached = true;
      completedTerms = rollover ? Math.floor(days / termDays) : 1;
      remainingDays = rollover ? days - completedTerms * termDays : 0;
      endingValue = initial * termGrowth ** completedTerms;
      if (rollover && remainingDays > 0) {
        endingValue *= growthForDays(remainingDays);
      }
    }
  }

  const holdingPeriodRate = endingValue / initial - 1;
  return {
    initialValue: initial,
    endingValue,
    totalEndingValue: endingValue,
    horizonDays: days,
    holdingPeriodRate,
    annualizedRate: (endingValue / initial) ** (YEAR_DAYS / days) - 1,
    completedTerms,
    remainingDays,
    maturityReached,
    rollover: Boolean(rollover),
  };
}

export function calculateSavingsBondReturn({
  initialValue,
  annualRate,
  horizonDays,
  productTermDays,
  rollover = true,
  earlyRedemptionTiers = [],
  earlyRedemptionFeeRate = 0,
}) {
  const initial = requireFiniteNumber(initialValue, "国债投入");
  const couponRate = requireFiniteNumber(annualRate, "国债票面年利率");
  const days = requireFiniteNumber(horizonDays, "国债持有天数");
  const termDays = requireFiniteNumber(productTermDays, "国债期限");
  const feeRate = requireFiniteNumber(earlyRedemptionFeeRate, "国债提前兑取手续费率");

  if (initial <= 0) throw new Error("国债投入必须大于0");
  if (couponRate <= -1) throw new Error("国债票面年利率必须大于-100%");
  if (days <= 0 || termDays <= 0) throw new Error("国债持有天数和期限必须大于0");
  if (feeRate < 0 || feeRate >= 1) throw new Error("国债提前兑取手续费率必须在0%至100%之间");

  const normalizedTiers = earlyRedemptionTiers.map((tier, index) => {
    const minDays = requireFiniteNumber(tier.minDays, `第${index + 1}档最短持有天数`);
    const maxDays = requireFiniteNumber(tier.maxDays, `第${index + 1}档最长持有天数`);
    const rate = requireFiniteNumber(tier.annualRate, `第${index + 1}档提前兑取年利率`);
    if (minDays < 0 || maxDays <= minDays || rate <= -1) throw new Error("国债提前兑取分档规则无效");
    return { minDays, maxDays, annualRate: rate };
  });

  const termGrowth = 1 + couponRate * termDays / YEAR_DAYS;
  if (termGrowth <= 0) throw new Error("当前国债利率和期限会使到期价值小于等于0");

  const earlyRedemption = (value, holdingDays) => {
    const tier = normalizedTiers.find(({ minDays, maxDays }) => holdingDays >= minDays && holdingDays < maxDays);
    const appliedRate = tier?.annualRate ?? 0;
    const interest = value * appliedRate * holdingDays / YEAR_DAYS;
    const fee = value * feeRate;
    return { endingValue: value + interest - fee, appliedRate, interest, fee };
  };

  let endingValue = initial;
  let completedTerms = 0;
  let remainingDays = days;
  let earlyRedemptionApplied = false;
  let appliedEarlyRedemptionRate = null;
  let redemptionFeeAmount = 0;

  if (days < termDays) {
    const earlyResult = earlyRedemption(initial, days);
    endingValue = earlyResult.endingValue;
    appliedEarlyRedemptionRate = earlyResult.appliedRate;
    redemptionFeeAmount = earlyResult.fee;
    earlyRedemptionApplied = true;
  } else {
    completedTerms = rollover ? Math.floor(days / termDays) : 1;
    remainingDays = rollover ? days - completedTerms * termDays : 0;
    endingValue = initial * termGrowth ** completedTerms;

    if (rollover && remainingDays > 0) {
      const earlyResult = earlyRedemption(endingValue, remainingDays);
      endingValue = earlyResult.endingValue;
      appliedEarlyRedemptionRate = earlyResult.appliedRate;
      redemptionFeeAmount = earlyResult.fee;
      earlyRedemptionApplied = true;
    }
  }

  const holdingPeriodRate = endingValue / initial - 1;
  return {
    initialValue: initial,
    endingValue,
    totalEndingValue: endingValue,
    horizonDays: days,
    holdingPeriodRate,
    annualizedRate: (endingValue / initial) ** (YEAR_DAYS / days) - 1,
    applicableAnnualRate: earlyRedemptionApplied ? appliedEarlyRedemptionRate : couponRate,
    completedTerms,
    remainingDays,
    maturityReached: days >= termDays,
    rollover: Boolean(rollover),
    earlyRedemptionApplied,
    appliedEarlyRedemptionRate,
    redemptionFeeRate: earlyRedemptionApplied ? feeRate : 0,
    redemptionFeeAmount,
  };
}

export function calculatePlannedInsuranceReturn({
  totalPremium,
  paymentYears,
  horizonDays,
  guaranteedValue,
  illustratedValue,
  startDate = "2026-08-30",
}) {
  const premium = requireFiniteNumber(totalPremium, "总计划保费");
  const years = requireFiniteNumber(paymentYears, "缴费年数");
  const days = requireFiniteNumber(horizonDays, "比较期限");
  const guaranteed = requireFiniteNumber(guaranteedValue, "保证利益");
  const illustrated = requireFiniteNumber(illustratedValue, "演示利益");

  if (premium <= 0) throw new Error("总计划保费必须大于0");
  if (!Number.isInteger(years) || years <= 0) throw new Error("缴费年数必须是正整数");
  if (days <= 0) throw new Error("比较期限必须大于0");
  if (years > Math.ceil(days / YEAR_DAYS)) throw new Error("缴费年数不能超过比较期限内可发生的年度数");
  if (guaranteed <= 0 || illustrated <= 0) throw new Error("保证利益和演示利益必须大于0");
  parseDate(startDate, "起始日期");

  const annualPremium = premium / years;
  const baseDate = new Date(`${startDate}T00:00:00Z`);
  const endDate = new Date(baseDate.getTime() + days * DAY_MS).toISOString().slice(0, 10);
  const outflows = Array.from({ length: years }, (_, index) => {
    const date = new Date(baseDate);
    date.setUTCFullYear(date.getUTCFullYear() + index);
    return { date: date.toISOString().slice(0, 10), amount: -annualPremium };
  });

  const guaranteedResult = calculateXirr([...outflows, { date: endDate, amount: guaranteed }]);
  const illustratedResult = calculateXirr([...outflows, { date: endDate, amount: illustrated }]);

  return {
    totalPremium: premium,
    annualPremium,
    paymentYears: years,
    horizonDays: days,
    guaranteedValue: guaranteed,
    illustratedValue: illustrated,
    guaranteedRate: guaranteedResult.rate,
    illustratedRate: illustratedResult.rate,
    guaranteedHoldingPeriodRate: guaranteed / premium - 1,
    illustratedHoldingPeriodRate: illustrated / premium - 1,
  };
}

export function normalizeCashFlows(cashFlows) {
  if (!Array.isArray(cashFlows) || cashFlows.length < 2) {
    throw new Error("至少需要两笔现金流");
  }

  const normalized = cashFlows
    .map((flow, index) => ({
      date: parseDate(flow.date, `第${index + 1}笔现金流日期`),
      amount: requireFiniteNumber(flow.amount, `第${index + 1}笔现金流金额`),
    }))
    .sort((a, b) => a.date - b.date);

  if (normalized[0].date.getTime() === normalized.at(-1).date.getTime()) {
    throw new Error("现金流必须跨越至少两个不同日期");
  }
  if (!normalized.some((flow) => flow.amount < 0) || !normalized.some((flow) => flow.amount > 0)) {
    throw new Error("至少需要一笔投入和一笔流入，投入填负数、流入填正数");
  }

  const firstDate = normalized[0].date;
  return normalized.map((flow) => ({
    ...flow,
    yearFraction: (flow.date - firstDate) / DAY_MS / YEAR_DAYS,
  }));
}

function normalizedXnpv(rate, cashFlows) {
  if (!Number.isFinite(rate) || rate <= -1) {
    return Number.NaN;
  }
  const base = 1 + rate;
  return cashFlows.reduce((total, flow) => {
    return total + flow.amount / base ** flow.yearFraction;
  }, 0);
}

function normalizedXnpvAtLogRate(logBase, cashFlows) {
  return cashFlows.reduce((total, flow) => {
    return total + flow.amount * Math.exp(-flow.yearFraction * logBase);
  }, 0);
}

function normalizedXnpvDerivativeAtLogRate(logBase, cashFlows) {
  return cashFlows.reduce((total, flow) => {
    return total - flow.yearFraction * flow.amount * Math.exp(-flow.yearFraction * logBase);
  }, 0);
}

function isScaleRelativeZero(logBase, cashFlows) {
  const residual = Math.abs(normalizedXnpvAtLogRate(logBase, cashFlows));
  const scale = cashFlows.reduce((total, flow) => {
    return total + Math.abs(flow.amount) * Math.exp(-flow.yearFraction * logBase);
  }, 0);
  return Number.isFinite(residual)
    && Number.isFinite(scale)
    && residual <= Math.max(1, scale) * 1e-10;
}

export function xnpv(rate, cashFlows) {
  return normalizedXnpv(rate, normalizeCashFlows(cashFlows));
}

function bisectLogRate(cashFlows, lowLogRate, highLogRate, evaluator) {
  let low = lowLogRate;
  let high = highLogRate;
  let lowValue = evaluator(low, cashFlows);

  for (let iteration = 0; iteration < 240; iteration += 1) {
    const middle = (low + high) / 2;
    const middleValue = evaluator(middle, cashFlows);

    if (middleValue === 0 || Math.abs(high - low) < 1e-13) {
      return middle;
    }

    if (Math.sign(lowValue) === Math.sign(middleValue)) {
      low = middle;
      lowValue = middleValue;
    } else {
      high = middle;
    }
  }

  return (low + high) / 2;
}

function findRoots(cashFlows) {
  const roots = [];
  const logMin = Math.log(0.000001);
  const logMax = Math.log(10001);
  const samples = 720;
  let previousLogRate = logMin;
  let previousValue = normalizedXnpvAtLogRate(previousLogRate, cashFlows);
  let previousDerivative = normalizedXnpvDerivativeAtLogRate(previousLogRate, cashFlows);

  for (let index = 1; index <= samples; index += 1) {
    const logRate = logMin + ((logMax - logMin) * index) / samples;
    const value = normalizedXnpvAtLogRate(logRate, cashFlows);
    const derivative = normalizedXnpvDerivativeAtLogRate(logRate, cashFlows);

    if (
      Number.isFinite(previousValue)
      && Number.isFinite(value)
      && Math.sign(previousValue) !== Math.sign(value)
    ) {
      const rootLogRate = bisectLogRate(
        cashFlows,
        previousLogRate,
        logRate,
        normalizedXnpvAtLogRate,
      );
      roots.push(Math.exp(rootLogRate) - 1);
    }

    if (
      Number.isFinite(previousDerivative)
      && Number.isFinite(derivative)
      && Math.sign(previousDerivative) !== Math.sign(derivative)
    ) {
      const stationaryLogRate = bisectLogRate(
        cashFlows,
        previousLogRate,
        logRate,
        normalizedXnpvDerivativeAtLogRate,
      );
      if (isScaleRelativeZero(stationaryLogRate, cashFlows)) {
        roots.push(Math.exp(stationaryLogRate) - 1);
      }
    }

    previousLogRate = logRate;
    previousValue = value;
    previousDerivative = derivative;
  }

  return roots
    .sort((a, b) => a - b)
    .filter((root, index, allRoots) => index === 0 || Math.abs(root - allRoots[index - 1]) > 1e-7);
}

export function calculateXirr(cashFlows) {
  const normalized = normalizeCashFlows(cashFlows);
  const roots = findRoots(normalized);

  if (roots.length === 0) {
    throw new Error("在-99.9999%至1,000,000%的范围内没有找到可用XIRR");
  }

  const rate = roots.reduce((best, candidate) => (
    Math.abs(candidate - 0.1) < Math.abs(best - 0.1) ? candidate : best
  ));

  return {
    rate,
    roots,
    multipleRoots: roots.length > 1,
    netPresentValue: normalizedXnpv(rate, normalized),
  };
}
