# 真实收益问答 Skill

面向支持 `SKILL.md` 和本地命令执行的 AI 助手。通过问答获取客户的理财产品投入、期限、收回金额和费用，在对话中按公式计算收益。

## 功能

- 基金、银行理财、储蓄国债的持有收益与复合折算年化。
- 分次投入、追加和领取的现金流 XIRR。
- 上传保险利益演示表图片后，提取缴费及保证/非保证退保利益，计算各年度 IRR 或 XIRR。
- 历史净值或日/周/月收益序列的夏普比率和年化波动率。
- 按客户需求计算最大回撤或自定义风险调整指标。
- 七组问答演示及缺失数据、提前退保、零波动等边界示例。

Skill 默认直接在聊天中回答，不制作网页或应用，不要求客户填写 JSON。JSON 和命令行仅供 AI 内部执行。

## 安装与使用

### 一句话安装

复制下面整句发送给 agent（代码块保留完整仓库地址）：

```text
请将 https://github.com/snakeninja110/finance-return-calculator-skill 仓库克隆或下载到当前 AI 的技能目录，文件夹命名为 finance-return-calculator，确保 SKILL.md 位于该文件夹根目录，检查 Node.js 18+ 环境并运行仓库中的计算示例验证安装。
```

### 手动安装与使用

需要 Node.js 18+，无 npm 依赖。

将本仓库整个目录复制到目标 AI 的技能目录，目录名使用 `finance-return-calculator`。Codex 可放在 `~/.codex/skills/finance-return-calculator/`。其他支持 `SKILL.md` 的 AI 使用其技能目录约定；没有自动发现能力时，让 AI 读取本目录的 `SKILL.md`。

对 AI 说：

> 帮我算一下理财收益。

安装并启用后，支持自动匹配技能的 AI 可根据中文需求调用。也可以说“算一下这只基金的年化”或“看看这份保险能赚多少”，不必记住英文 Skill 名称。

也支持“扣完费赚几个点”“定投实际年化多少”“算算夏普比例”“从高点跌了多少”“这张保单哪年退不亏”等说法。对话中可直接续问“那10年呢”“只看保证的”“回撤也看看”，AI 会沿用已确认信息并补充必要缺项。匹配规则与容易混淆的表达见[中文触发说明](references/invocation.md)。

保险可以直接附上利益演示表图片，图片读取依赖宿主 AI 的视觉能力。脚本本身只接收识别后的 JSON，不包含 OCR 服务。

## 文件

- [SKILL.md](SKILL.md)：触发条件、问答流程和计算路由。
- [中文触发说明](references/invocation.md)：口语、别称、续问、否定及误触发边界。
- [对话流程](references/conversation.md)：收集信息与公式选择。
- [七组演示案例](references/examples.md)：问答、假设数据及已核对结果。
- [保险图片](references/insurance-images.md)：字段提取、单位和现金流口径。
- [夏普比率](references/sharpe.md)：收益序列、无风险利率和年化假设。
- [最大回撤](references/drawdown.md)：适用条件、观察窗口和采样频率。
- [输入参考](references/inputs.md)：供 AI 内部调用的 JSON 参数。

## 内部调用示例

```bash
node scripts/calculate.mjs request.json
```

`request.json` 示例：

```json
{"action":"annualized","input":{"initialValue":100000,"endingValue":100800,"days":90}}
```

复合折算年化约3.28%。成功返回 `ok: true`；失败返回 `ok: false` 并以状态码1退出。省略文件参数时读取标准输入。

## 数据与计算边界

不附带当前产品报价，不会联网下载客户数据。模糊图片数字或缺失费用不补造；演示收益非保证。最大回撤不作为收益或夏普的必填项；只有本金和终值无法计算夏普，零波动时夏普未定义。自定义风险调整指标不等于实际年化收益率。

假设示例经过计算核对。实际图片识别仍须与原图复核，历史表现和情景测算不代表未来收益承诺。
