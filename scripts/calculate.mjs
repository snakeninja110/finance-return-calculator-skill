#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as engine from './engine.mjs';

const modes = {
  annualized: [engine.calculateAnnualizedReturn, ['initialValue', 'endingValue', 'days'], ['income']],
  xirr: [engine.calculateXirr, [], []],
  sharpe: [calculateSharpe, ['returns', 'periodsPerYear', 'riskFreeRate'], []],
  'fund-cost': [engine.calculateFundCostAdjustedReturn, ['initialValue', 'annualRate', 'horizonDays', 'managementFeeRate', 'redemptionFeeRate', 'rateBasis'], []],
  'fund-metrics': [engine.calculateFundMetrics, ['history'], ['benchmarkHistory', 'riskFreeRate', 'periodsPerYear']],
  composite: [engine.calculateCompositeAnnualRate, ['geometricAnnualRate', 'maxDrawdown', 'annualVolatility', 'holdingDays'], ['targetHorizonDays', 'redemptionFeeRate', 'riskAversion']],
  projected: [engine.calculateProjectedReturn, ['initialValue', 'annualRate', 'horizonDays'], ['productTermDays', 'rollover', 'termCompounding']],
  'savings-bond': [engine.calculateSavingsBondReturn, ['initialValue', 'annualRate', 'horizonDays', 'productTermDays'], ['rollover', 'earlyRedemptionTiers', 'earlyRedemptionFeeRate']],
  insurance: [engine.calculatePlannedInsuranceReturn, ['totalPremium', 'paymentYears', 'horizonDays', 'guaranteedValue', 'illustratedValue', 'startDate'], []],
};
const special = new Set(['history', 'benchmarkHistory', 'rateBasis', 'rollover', 'termCompounding', 'earlyRedemptionTiers', 'startDate', 'returns']);

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}必须是对象`);
}
function number(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name}必须是有限数字，不能为 null 或字符串`);
}
function keys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${name}包含未知字段 ${key}`);
}
function datedSeries(series, name, field) {
  if (!Array.isArray(series)) throw new Error(`${name}必须是数组`);
  const dates = new Set();
  for (const point of series) {
    object(point, name);
    keys(point, ['date', field], name);
    if (typeof point.date !== 'string') throw new Error(`${name}.date必须是 YYYY-MM-DD 字符串`);
    number(point[field], `${name}.${field}`);
    if (field === 'value' && dates.has(point.date)) throw new Error(`${name}包含重复日期 ${point.date}`);
    dates.add(point.date);
  }
}

function single(action, input) {
  if (action === 'insurance-table') return insuranceTable(input);
  const mode = modes[action];
  if (!Object.hasOwn(modes, action)) throw new Error(`不支持的 action: ${action}`);
  if (action === 'xirr') {
    object(input, 'input');
    keys(input, ['cashFlows'], 'input');
    datedSeries(input.cashFlows, 'cashFlows', 'amount');
    const result = mode[0](input.cashFlows);
    return { result, warnings: result.multipleRoots ? ['XIRR 存在多个根；展示值取最接近 10% 的根，请同时报告全部 roots。'] : [] };
  }
  object(input, 'input');
  const [, required, optional] = mode;
  keys(input, [...required, ...optional], 'input');
  for (const key of required) if (input[key] === undefined || input[key] === null) throw new Error(`缺少必填参数 ${key}`);
  for (const [key, value] of Object.entries(input)) if (!special.has(key)) number(value, key);
  if ('rollover' in input && typeof input.rollover !== 'boolean') throw new Error('rollover必须为布尔值');
  if ('productTermDays' in input && input.productTermDays <= 0) throw new Error('productTermDays必须大于0');
  if ('history' in input) datedSeries(input.history, 'history', 'value');
  if (input.benchmarkHistory !== undefined && input.benchmarkHistory !== null) datedSeries(input.benchmarkHistory, 'benchmarkHistory', 'value');
  if ('rateBasis' in input && !['net', 'gross'].includes(input.rateBasis)) throw new Error('rateBasis必须为 net 或 gross');
  if ('termCompounding' in input && !['simple', 'compound'].includes(input.termCompounding)) throw new Error('termCompounding必须为 simple 或 compound');
  const params = { ...input };
  const warnings = [];
  if (['projected', 'savings-bond'].includes(action)) {
    params.rollover ??= false;
    warnings.push(params.rollover ? '续投各期沿用同一利率，仅为假设，未来利率可能变化。' : '产品到期后资金闲置，不继续计息。');
  }
  if (action === 'projected') warnings.push('这是利率情景，未验证提前赎回可行性、赎回费用或产品合同限制。');
  if (action === 'savings-bond') {
    if (params.earlyRedemptionTiers !== undefined) {
      if (!Array.isArray(params.earlyRedemptionTiers)) throw new Error('earlyRedemptionTiers必须为数组');
      for (const tier of params.earlyRedemptionTiers) {
        object(tier, '提前兑取分档');
        keys(tier, ['minDays', 'maxDays', 'annualRate'], '提前兑取分档');
        for (const key of ['minDays', 'maxDays', 'annualRate']) number(tier[key], key);
        if (tier.minDays < 0 || tier.maxDays <= tier.minDays || tier.annualRate <= -1) throw new Error('国债提前兑取分档规则无效');
      }
      const sorted = [...params.earlyRedemptionTiers].sort((a, b) => a.minDays - b.minDays);
      for (let i = 1; i < sorted.length; i++) if (sorted[i].minDays < sorted[i - 1].maxDays) throw new Error('国债提前兑取分档不能重叠');
    }
    const earlyDays = params.horizonDays < params.productTermDays
      ? params.horizonDays
      : params.rollover ? params.horizonDays % params.productTermDays : 0;
    if (earlyDays > 0) {
      if (params.earlyRedemptionFeeRate === undefined) throw new Error('提前兑取须明确 earlyRedemptionFeeRate，免费也须填写0');
      if (!params.earlyRedemptionTiers?.some(t => earlyDays >= t.minDays && earlyDays < t.maxDays)) throw new Error('提前兑取分档未覆盖实际持有天数');
    }
    warnings.push('储蓄国债模型将利息计入到期价值；实际逐期付息请使用现金流 XIRR。');
  }
  if (action === 'insurance') {
    if (!Number.isInteger(params.horizonDays)) throw new Error('保险 horizonDays 必须为整数实际天数');
    const start = new Date(`${params.startDate}T00:00:00Z`);
    const lastPayment = new Date(start);
    lastPayment.setUTCFullYear(lastPayment.getUTCFullYear() + params.paymentYears - 1);
    if (lastPayment >= new Date(start.getTime() + params.horizonDays * 86400000)) throw new Error('最后缴费日期必须早于期末利益日期');
    warnings.push('假定等额年初缴费、期末一次性收回利益；演示利益非保证。');
  }
  if (action === 'fund-metrics') warnings.push('风险指标使用月末收益和完整总回报路径；历史样本不代表未来。');
  if (action === 'composite') warnings.push('综合年化为自定义风险惩罚指标，不是标准收益率或未来收益预测。');
  if (action === 'annualized' && (params.income ?? 0) !== 0) warnings.push('期间收入按期末合并，不考虑实际收取时间；需按日期加权时使用 XIRR。');
  const result = mode[0](params);
  if (action === 'sharpe') {
    warnings.push('历史年化夏普采用等间隔收益、固定无风险利率及平方根年化；收益自相关可能影响该年化假设。');
    if (result.sharpeRatio === null) warnings.push('收益序列零波动，夏普比率未定义，不能解释为无限大或无风险。');
    if (result.observations < params.periodsPerYear) warnings.push('样本不足一个年度周期，夏普估计可能不稳定。');
  }
  return { result, warnings };
}

function calculateSharpe({ returns, periodsPerYear, riskFreeRate }) {
  if (!Array.isArray(returns) || returns.length < 2) throw new Error('夏普比率至少需要两个等间隔收益率观测值');
  if (!Number.isInteger(periodsPerYear) || periodsPerYear <= 0) throw new Error('periodsPerYear必须为正整数年化周期数');
  if (riskFreeRate <= -1) throw new Error('riskFreeRate必须大于-100%');
  for (const rate of returns) {
    number(rate, 'returns收益率');
    if (rate < -1) throw new Error('单期收益率不能低于-100%');
  }
  // Center relative to the first return to preserve exact zero variance for constant series.
  const offsets = returns.map(rate => rate - returns[0]);
  const meanOffset = offsets.reduce((sum, value) => sum + value, 0) / returns.length;
  const meanPeriodRate = returns[0] + meanOffset;
  const variance = offsets.reduce((sum, value) => sum + (value - meanOffset) ** 2, 0) / (returns.length - 1);
  const periodVolatility = Math.sqrt(variance);
  const periodRiskFreeRate = (1 + riskFreeRate) ** (1 / periodsPerYear) - 1;
  const meanExcessPeriodRate = meanPeriodRate - periodRiskFreeRate;
  return {
    observations: returns.length,
    periodsPerYear,
    riskFreeRate,
    periodRiskFreeRate,
    meanPeriodRate,
    meanExcessPeriodRate,
    periodVolatility,
    annualArithmeticRate: meanPeriodRate * periodsPerYear,
    annualVolatility: periodVolatility * Math.sqrt(periodsPerYear),
    sharpeRatio: periodVolatility === 0 ? null : meanExcessPeriodRate / periodVolatility * Math.sqrt(periodsPerYear),
  };
}

function insuranceTable(input) {
  object(input, 'input');
  keys(input, ['annualPremium', 'paymentYears', 'premiumTiming', 'timeBasis', 'startDate', 'rows'], 'input');
  number(input.annualPremium, 'annualPremium');
  number(input.paymentYears, 'paymentYears');
  if (input.annualPremium <= 0 || !Number.isInteger(input.paymentYears) || input.paymentYears <= 0) throw new Error('年缴保费必须大于0，缴费年数必须为正整数');
  if (input.premiumTiming !== 'year-start') throw new Error('insurance-table须明确 premiumTiming 为 year-start；其他缴费安排使用 xirr');
  if (!['policy-years', 'actual-dates'].includes(input.timeBasis)) throw new Error('timeBasis必须明确为 policy-years 或 actual-dates');
  let base;
  if (input.timeBasis === 'actual-dates') {
    if (typeof input.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) throw new Error('实际日期口径须提供 startDate');
    base = new Date(`${input.startDate}T00:00:00Z`);
    if (!Number.isFinite(base.getTime()) || base.toISOString().slice(0, 10) !== input.startDate) throw new Error('startDate日期无效');
  } else if ('startDate' in input) throw new Error('保单年度口径不接受 startDate；有实际日期时选择 actual-dates');
  if (!Array.isArray(input.rows) || !input.rows.length) throw new Error('rows至少需要一个利益表年度');
  const warnings = ['按等额年初缴费、每个所选年度末退保测算；演示利益非保证，身故保额不能当作退保价值。'];
  warnings.push(input.timeBasis === 'policy-years'
    ? '图片未提供实际起始日期时按每保单年度365天建模，结果为年度模型 IRR，不是实际日期 XIRR。'
    : '按保单周年日与365天年化计算 XIRR；2月29日的非闰年周年日按2月28日处理。');
  function dateAt(year) {
    if (input.timeBasis === 'policy-years') return new Date(Date.UTC(2001, 0, 1) + year * 365 * 86400000).toISOString().slice(0, 10);
    const targetYear = base.getUTCFullYear() + year;
    const lastDay = new Date(Date.UTC(targetYear, base.getUTCMonth() + 1, 0)).getUTCDate();
    return new Date(Date.UTC(targetYear, base.getUTCMonth(), Math.min(base.getUTCDate(), lastDay))).toISOString().slice(0, 10);
  }
  const seen = new Set();
  const rows = input.rows.map(row => {
    object(row, '利益表行');
    keys(row, ['policyYear', 'guaranteedValue', 'illustratedValue'], '利益表行');
    if (!Number.isInteger(row.policyYear) || row.policyYear <= 0) throw new Error('policyYear必须为正整数保单年度');
    if (seen.has(row.policyYear)) throw new Error(`重复保单年度 ${row.policyYear}`);
    seen.add(row.policyYear);
    const count = Math.min(input.paymentYears, row.policyYear);
    const paidPremium = input.annualPremium * count;
    const premiums = Array.from({ length: count }, (_, index) => ({ date: dateAt(index), amount: -input.annualPremium }));
    const result = { policyYear: row.policyYear, paidPremium, paidYears: count };
    let values = 0;
    for (const [field, label] of [['guaranteedValue', 'guaranteed'], ['illustratedValue', 'illustrated']]) {
      if (!(field in row)) continue;
      values++;
      number(row[field], field);
      if (row[field] < 0) throw new Error(`${field}不能为负数`);
      const flows = [...premiums, { date: dateAt(row.policyYear), amount: row[field] }];
      const scenario = { endingValue: row[field], gain: row[field] - paidPremium, holdingPeriodRate: row[field] / paidPremium - 1 };
      try {
        const irr = engine.calculateXirr(flows);
        Object.assign(scenario, { annualizedRate: irr.rate, roots: irr.roots, multipleRoots: irr.multipleRoots });
      } catch (error) {
        Object.assign(scenario, { annualizedRate: null, error: error.message });
        warnings.push(`第${row.policyYear}年${label}口径未得到可用年化：${error.message}`);
      }
      scenario.cashFlows = input.timeBasis === 'actual-dates' ? flows : flows.map((flow, index) => ({ policyTime: index < count ? index : row.policyYear, amount: flow.amount }));
      result[label] = scenario;
    }
    if (!values) throw new Error('每行至少提供一项已确认的保证或演示退保价值');
    return result;
  }).sort((a, b) => a.policyYear - b.policyYear);
  return { result: { annualPremium: input.annualPremium, paymentYears: input.paymentYears, totalPlannedPremium: input.annualPremium * input.paymentYears, premiumTiming: input.premiumTiming, timeBasis: input.timeBasis, ...(base ? { startDate: input.startDate } : {}), rows }, warnings };
}

export function calculate(request) {
  object(request, '请求');
  keys(request, ['action', 'input', 'provenance'], '请求');
  if (typeof request.action !== 'string') throw new Error('action必须为字符串');
  let output;
  if (request.action !== 'compare') output = single(request.action, request.input);
  else {
    const input = request.input;
    object(input, 'input');
    keys(input, ['budget', 'horizonDays', 'products'], 'input');
    number(input.budget, 'budget');
    number(input.horizonDays, 'horizonDays');
    if (input.budget <= 0 || input.horizonDays <= 0) throw new Error('统一预算和期限必须大于0');
    if (!Array.isArray(input.products) || input.products.length < 2) throw new Error('compare至少需要两个产品');
    const rows = input.products.map(product => {
      object(product, '产品');
      keys(product, ['name', 'action', 'input'], '产品');
      if (typeof product.name !== 'string' || !product.name.trim()) throw new Error('产品必须有 name');
      if (!['fund-cost', 'projected', 'savings-bond', 'insurance'].includes(product.action)) throw new Error('比较仅支持 fund-cost、projected、savings-bond、insurance');
      object(product.input, '产品 input');
      const amountKey = product.action === 'insurance' ? 'totalPremium' : 'initialValue';
      for (const [key, value] of [[amountKey, input.budget], ['horizonDays', input.horizonDays]]) {
        if (key in product.input && product.input[key] !== value) throw new Error(`${product.name}的${key}与统一比较口径不一致`);
      }
      const detail = single(product.action, { ...product.input, [amountKey]: input.budget, horizonDays: input.horizonDays });
      const r = detail.result;
      const summary = product.action === 'insurance'
        ? { guaranteed: { endingValue: r.guaranteedValue, holdingPeriodRate: r.guaranteedHoldingPeriodRate, annualizedRate: r.guaranteedRate }, illustrated: { endingValue: r.illustratedValue, holdingPeriodRate: r.illustratedHoldingPeriodRate, annualizedRate: r.illustratedRate } }
        : { endingValue: r.endingValue, holdingPeriodRate: r.holdingPeriodRate, annualizedRate: r.annualizedRate };
      return { name: product.name, action: product.action, summary, ...detail };
    });
    output = { result: { budget: input.budget, horizonDays: input.horizonDays, products: rows }, warnings: ['统一总预算与期限；分期缴费的资金占用不同于一次性投入，保险年化为计划现金流 XIRR。'] };
  }
  ensureFinite(output.result);
  return { ok: true, action: request.action, ...output, provenance: request.provenance ?? null };
}

function ensureFinite(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('计算结果超出有限数值范围');
  if (value && typeof value === 'object') for (const child of Object.values(value)) ensureFinite(child);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    if (process.argv.length > 3) throw new Error('用法: node calculate.mjs [请求.json]；无参数时读取标准输入');
    const request = JSON.parse(readFileSync(process.argv[2] ?? 0, 'utf8'));
    process.stdout.write(`${JSON.stringify(calculate(request), null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}
