# JSON 输入参考

本文件供 AI 内部调用计算引擎使用，不要求客户填写 JSON。客户通过问答或图片提供信息，AI 按 [conversation.md](conversation.md) 收集缺项、选择公式并组织输入，再在对话中交付收益结果。

Python 入口 `scripts/calculate.py` 与 Node 入口 `scripts/calculate.mjs` 使用相同 action、字段、结果和退出码。优先使用已有 Python 3.9+，只依赖标准库；不需要安装 Node.js。

以下数值均为接口测试假设，不代表实际产品报价。每个请求格式：

```json
{"action":"annualized","input":{"initialValue":10000,"endingValue":10300,"days":365},"provenance":{"source":"用户提供的测试假设","asOf":"2026-10-04"}}
```

`provenance` 为可选原样回传元数据，不验证其真实性。所有字段区分大小写，不接受未知字段。金额和利率必须为 JSON 数字，不能为字符串或 null（仅 `benchmarkHistory` 可为 null）。数组的日期为 `YYYY-MM-DD`。日期输入顺序不限，重复净值日期会报错；同日多笔现金流允许保留。

## 单笔收益与现金流

### annualized

必填 `initialValue`、`endingValue`、`days`；可选 `income`，默认 0。期间现金收入按期末合并。输出 `holdingPeriodRate` 与复合 `annualizedRate`；有实际收取日期时使用 XIRR。

### xirr

```json
{"action":"xirr","input":{"cashFlows":[{"date":"2025-01-01","amount":-10000},{"date":"2026-01-01","amount":10300}]}}
```

投入为负数，收回为正数。输出 `rate`、全部 `roots`、`multipleRoots`、`netPresentValue`。搜索范围为 -99.9999% 至 1,000,000%；不保证发现所有极端现金流的全部数学根。

## 基金

### sharpe

直接从日/周/月等间隔收益率计算夏普和年化波动率。必填 `returns`、`periodsPerYear`、`riskFreeRate`，无默认无风险利率。完整问答、公式和示例见 [sharpe.md](sharpe.md)。有基金净值则也可使用下方 `fund-metrics` 的月度夏普。

### fund-cost

必填 `initialValue`、`annualRate`、`horizonDays`、`managementFeeRate`、`redemptionFeeRate`、`rateBasis`（`net` 或 `gross`）。`annualRate` 为几何年化情景。

```json
{"action":"fund-cost","input":{"initialValue":10000,"annualRate":0.04,"horizonDays":365,"managementFeeRate":0.005,"redemptionFeeRate":0.001,"rateBasis":"net"}}
```

`net` 不重复扣已包含在净值内的管理费；`gross` 按 `(1 - managementFeeRate / 365) ^ horizonDays` 扣管理费。赎回费从赎回金额扣。输出期末价值、持有收益、扣费年化、`managementFeeImpact` 与 `redemptionFeeAmount`；净口径的管理费影响为反推近似值。

### fund-metrics

必填 `history` 数组，每项为 `{ "date": "2025-01-31", "value": 1.02 }`；可选 `benchmarkHistory` 同结构、`riskFreeRate`（默认 0.015）、`periodsPerYear`（默认 12）。引擎固定抽取每个自然月最后一个观测值，通常保持 12，不要把它当日收益计算器。

至少三个自然月；准备连续月份、完整总回报路径及一致观察日期的基准。输出历史持有收益、算术预期年化、几何年化、一次性投入 XIRR、负数最大回撤、波动、Beta、夏普及观察数。基准不足/方差为零时 Beta 为 null；基金波动为零时夏普为 null，不能解释为 0。历史算术预期年化不等于未来收益预测。

### composite

必填 `geometricAnnualRate`、`maxDrawdown`（负数或 0）、`annualVolatility`（非负）、`holdingDays`（样本天数）；可选 `targetHorizonDays`（默认样本天数）、`redemptionFeeRate`（默认 0）、`riskAversion`（默认 2）。费率未知时先明确，不要用默认 0 表示已核实无费用。

公式：目标期限扣赎回费后的几何年化 − |最大回撤| / (样本天数 / 365) − 0.5 × 风险厌恶系数 × 波动率²。输出 `compositeAnnualRate` 与各惩罚项。不要将此自定义分数用作期末价值增长率。

## 理财情景与储蓄国债

### projected

必填 `initialValue`、`annualRate`、`horizonDays`；可选 `productTermDays`（正数）、`rollover`（默认 false）、`termCompounding`（默认 `simple`，也可 `compound`）。不填产品期限时按几何年化复利；填期限时按选定计息方式处理完整周期和剩余天数。若未选择续投，到期后资金闲置。提前退出仅为数学估算，须先确认合同规则。此模式未扣额外费用；实际现金流可直接用 XIRR。

### savings-bond

必填 `initialValue`、`annualRate`、`horizonDays`、`productTermDays`；可选 `rollover`（默认 false）。若首次持有期或续投最后一段未到期，额外必填 `earlyRedemptionFeeRate` 和覆盖该段天数的 `earlyRedemptionTiers`。

```json
{"action":"savings-bond","input":{"initialValue":10000,"annualRate":0.02,"horizonDays":200,"productTermDays":1095,"rollover":false,"earlyRedemptionFeeRate":0.001,"earlyRedemptionTiers":[{"minDays":0,"maxDays":180,"annualRate":0},{"minDays":180,"maxDays":1095,"annualRate":0.01}]}}
```

分档左闭右开，不可重叠；缺档报错，不自动按零息处理。输出期末价值、持有收益、折算年化、实际分档利率与手续费。模型将到期利息合并，实际票息现金流用 XIRR。

## 分红险

### insurance-table（图片识别后的多年度利益表）

用户上传利益演示表图片时，先读取 [insurance-images.md](insurance-images.md)，完成视觉提取与字段核对后生成 JSON。此模式支持缴费期内退保、多个年度、单一已显示口径及无真实起始日期的年度模型。脚本本身不识别图片。参数和完整示例均在该参考中。

### insurance

必填 `totalPremium`（总预算）、`paymentYears`（正整数）、`horizonDays`（正整数实际天数）、`guaranteedValue`、`illustratedValue`、`startDate`。

```json
{"action":"insurance","input":{"totalPremium":100000,"paymentYears":3,"horizonDays":3652,"guaranteedValue":115000,"illustratedValue":130000,"startDate":"2026-10-04"}}
```

起始日为第一笔缴费日，后续每年同日等额缴费；期末日期 = 起始日 + 实际天数。保证/演示利益须来自这个期末的同一利益表，期限变化后重新取得数值，不插值外推。输出两种利益和分别计算的 `guaranteedRate`、`illustratedRate` XIRR，以及未按缴费时间加权的总保费收益率。有中途领取或不规则缴费，使用实际现金流 XIRR。

## 统一比较

### compare

必填 `budget`、`horizonDays`、至少两个 `products`。产品须有 `name`、`action`、`input`，action 仅支持 `fund-cost`、`projected`、`savings-bond`、`insurance`。统一预算自动填入 `initialValue` 或保险的 `totalPremium`，期限填入 `horizonDays`；产品若另外填这两个字段则必须与统一值一致。

```json
{
  "action": "compare",
  "provenance": {"source": "演示假设，非实际报价"},
  "input": {
    "budget": 100000,
    "horizonDays": 365,
    "products": [
      {"name": "基金情景", "action": "fund-cost", "input": {"annualRate": 0.04, "managementFeeRate": 0.005, "redemptionFeeRate": 0.001, "rateBasis": "net"}},
      {"name": "30天理财到期闲置", "action": "projected", "input": {"annualRate": 0.02, "productTermDays": 30, "rollover": false}},
      {"name": "保险情景", "action": "insurance", "input": {"paymentYears": 1, "guaranteedValue": 99000, "illustratedValue": 101000, "startDate": "2026-10-04"}}
    ]
  }
}
```

每个产品有统一 `summary` 和完整 `result`、`warnings`；保险 summary 分 `guaranteed` 与 `illustrated`。不自动排序或选优。总保费统一不意味着资金占用一致，需说明缴费安排。产品来源可分别记录在顶层 `provenance` 中。
