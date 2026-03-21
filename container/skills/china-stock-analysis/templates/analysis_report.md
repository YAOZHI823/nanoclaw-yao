# {{stock_name}} ({{stock_code}}) 投资分析报告

**分析日期**: {{analysis_date}}
**分析级别**: {{analysis_level}}
**综合评分**: {{overall_score}}/100
**舆情评分**: {{sentiment_score}}/100 ({{sentiment_label}})

---

## 一、公司概况

| 项目 | 内容 |
|------|------|
| 股票代码 | {{stock_code}} |
| 股票名称 | {{stock_name}} |
| 所属行业 | {{industry}} |
| 总市值 | {{market_cap}} |
| 流通市值 | {{float_cap}} |
| 上市日期 | {{listing_date}} |

### 主营业务

{{main_business}}

---

## 二、当日/近期重大新闻摘要 + 情绪评分

### 舆情概览

| 项目 | 数据 |
|------|------|
| 综合情感 | {{sentiment_label}} |
| 情感评分 | {{sentiment_score}}/100 |
| 利好新闻 | {{positive_news_count}} 条 |
| 利空新闻 | {{negative_news_count}} 条 |
| 中性新闻 | {{neutral_news_count}} 条 |

### 重大新闻列表

{{#if key_events}}
| 日期 | 新闻标题 | 情感 | 评分 |
|------|----------|------|------|
{{#each key_events}}
| {{this.date}} | {{this.title}} | {{this.sentiment}} | {{this.score}} |
{{/each}}
{{else}}
近期无重大新闻
{{/if}}

### 新闻摘要

{{news_summary}}

---

## 三、行业政策动态 + 影响分析

### 政策列表

{{#if policies}}
| 日期 | 政策标题 | 来源 | 影响 | 摘要 |
|------|----------|------|------|------|
{{#each policies}}
| {{this.date}} | {{this.title}} | {{this.source}} | {{this.impact}} | {{this.summary}} |
{{/each}}
{{else}}
近期无重大政策新闻
{{/if}}

### 政策影响分析

{{policy_analysis}}

---

## 四、宏观市场环境

### 大盘指标

| 指标 | 数值 | 涨跌幅 |
|------|------|--------|
| 沪深300指数 | {{csi300_price}} | {{csi300_change}}% |
| 北向资金 | {{north_money_value}}亿 | - |

### 市场情绪

| 项目 | 状态 |
|------|------|
| 市场情绪 | {{market_sentiment}} |
| 资金流向 | {{money_flow}} |

### 行业环境

{{industry_environment}}

---

## 五、财务健康分析

### 5.1 资产负债表

| 项目 | 数值 | 评价 |
|------|------|------|
| 资产总计 | {{total_assets}} | - |
| 负债合计 | {{total_liabilities}} | - |
| 资产负债率 | {{debt_ratio}}% | {{debt_ratio_status}} |

### 5.2 偿债能力

| 指标 | 当前值 | 参考标准 | 状态 |
|------|--------|----------|------|
| 资产负债率 | {{debt_ratio}}% | < 60% | {{debt_ratio_status}} |
| 流动比率 | {{current_ratio}} | > 1.5 | {{current_ratio_status}} |
| 速动比率 | {{quick_ratio}} | > 1 | {{quick_ratio_status}} |

---

## 六、盈利能力分析

### 6.1 关键指标

| 指标 | 当前值 | 行业均值 | 评价 |
|------|--------|----------|------|
| ROE | {{roe}}% | {{industry_roe}}% | {{roe_assessment}} |
| ROA | {{roa}}% | {{industry_roa}}% | {{roa_assessment}} |
| 毛利率 | {{gross_margin}}% | {{industry_gross_margin}}% | {{gross_margin_assessment}} |
| 净利率 | {{net_margin}}% | {{industry_net_margin}}% | {{net_margin_assessment}} |

### 6.2 杜邦分析

- 净利率: {{net_margin}}%
- 资产周转率: {{asset_turnover}}
- 权益乘数: {{equity_multiplier}}
- **ROE驱动因素**: {{roe_driver}}

---

## 七、成长性分析

### 7.1 增长指标

| 指标 | 最近一期 | 近3年平均 | 趋势 |
|------|----------|-----------|------|
| 营收增长率 | {{revenue_growth}}% | {{avg_revenue_growth}}% | {{revenue_trend}} |
| 净利润增长率 | {{profit_growth}}% | {{avg_profit_growth}}% | {{profit_trend}} |

### 7.2 成长性评估

{{growth_assessment}}

---

## 八、估值分析

### 8.1 当前估值

| 指标 | 当前值 | 历史分位数 | 行业均值 |
|------|--------|------------|----------|
| PE (TTM) | {{pe_ttm}} | {{pe_percentile}}% | {{industry_pe}} |
| PB | {{pb}} | {{pb_percentile}}% | {{industry_pb}} |

### 8.2 内在价值估算

| 估值方法 | 每股价值 | 说明 |
|----------|----------|------|
| DCF现金流折现 | ¥{{dcf_value}} | 折现率{{discount_rate}}% |
| 相对估值 | ¥{{relative_value}} | 基于历史PE均值 |
| **综合估值** | **¥{{avg_value}}** | - |

### 8.3 安全边际

| 项目 | 数值 |
|------|------|
| 当前价格 | ¥{{current_price}} |
| 内在价值 | ¥{{avg_value}} |
| 安全边际 | {{margin_of_safety}}% |

---

## 九、风险提示

### 9.1 财务异常检测

**风险等级**: {{risk_level}}

{{#if anomalies}}
| 异常类型 | 描述 | 严重程度 |
|----------|------|----------|
{{#each anomalies}}
| {{this.type}} | {{this.description}} | {{this.severity}} |
{{/each}}
{{else}}
未检测到明显财务异常
{{/if}}

### 9.2 舆情风险

{{#if sentiment_risks}}
{{#each sentiment_risks}}
- {{this}}
{{/each}}
{{else}}
- 暂无明显舆情风险
{{/if}}

### 9.3 行业/政策风险

{{industry_risks}}

### 9.4 深度尽调检查（短线推荐必查）

> ⚠️ **注意**: 本节为2026年3月20日新增，基于600186莲花控股推荐失败教训制定

#### 6项必查检查项

| 检查项 | 检查内容 | 结果 | 状态 |
|--------|----------|------|------|
| 重大合同履约 | 近3个月合同公告、取消/终止比例 | {{contract_status}} | {{contract_status_icon}} |
| 关联方风险 | 大股东关联交易、担保余额、质押比例 | {{related_party_status}} | {{related_party_status_icon}} |
| 现金流验证 | 经营现金流 vs 净利润匹配度 | {{cash_flow_status}} | {{cash_flow_status_icon}} |
| 控股股东财务 | 债务违约、连续亏损、平仓风险 | {{controlling_shareholder_status}} | {{controlling_shareholder_status_icon}} |
| 隐藏负债 | 有息负债变化、担保余额、或有负债 | {{hidden_debt_status}} | {{hidden_debt_status_icon}} |
| 异常波动历史 | 异常波动公告频率、监管问询 | {{volatility_status}} | {{volatility_status_icon}} |

#### 红哨指标（发现任一则建议回避）

| 红哨指标 | 阈值 | 当前值 |
|----------|------|--------|
| 合同取消比例 | >30% | {{contract_cancellation_rate}} |
| 大股东质押比例 | >50% | {{pledge_ratio}} |
| 经营现金流 | 连续为负 | {{cash_flow_negative}} |
| 有息负债变化 | >100%激增 | {{debt_increase_rate}} |
| 异常波动公告 | 频繁 | {{abnormal_volatility_count}} |
| 大股东债务违约 | 存在 | {{debt_default_exists}} |

#### 尽调结论

{{#if red_flag_count}}
⚠️ **发现 {{red_flag_count}} 项红哨指标**，{{red_flag_recommendation}}
{{else}}
✅ **通过深度尽调检查**，{{no_red_flag_conclusion}}
{{/if}}

---

## 十、综合结论

### 多维度评分

| 维度 | 评分 | 权重 | 加权得分 |
|------|------|------|----------|
| 舆情面 | {{sentiment_score}}/100 | 15% | {{sentiment_weighted}} |
| 政策面 | {{policy_score}}/100 | 10% | {{policy_weighted}} |
| 财务面 | {{financial_score}}/100 | 25% | {{financial_weighted}} |
| 估值面 | {{valuation_score}}/100 | 20% | {{valuation_weighted}} |
| 成长性 | {{growth_score}}/100 | 15% | {{growth_weighted}} |
| 技术面 | {{technical_score}}/100 | 15% | {{technical_weighted}} |
| **综合评分** | **{{overall_score}}/100** | - | - |

### 投资建议

{{investment_recommendation}}

### 关键观察点

{{#each key_observations}}
- {{this}}
{{/each}}

---

## 免责声明

本报告基于公开财务数据和新闻信息分析，仅供参考，不构成投资建议。投资有风险，入市需谨慎。

**数据来源**: akshare (公开财务数据)、东方财富网 (新闻数据)
**分析工具**: china-stock-analysis skill
**报告生成时间**: {{report_time}}
