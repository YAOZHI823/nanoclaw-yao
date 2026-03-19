# China Stock Analysis Skill - 新闻与政策增强设计

**日期**: 2026-03-18
**状态**: 设计中
**目标**: 为 china-stock-analysis skill 添加新闻、政策、宏观市场分析模块

---

## 背景

当前 skill 纯量化分析，缺失新闻/政策维度，A 股市场受政策和新闻影响极大，导致预测准确度低。

---

## 目标

在现有 Workflow 2（个股分析）中新增：
1. 新闻获取模块
2. 政策分析模块
3. 宏观市场数据
4. 情感评分

---

## 新增模块

### 1. `scripts/news_fetcher.py`

**功能**: 获取股票相关新闻

**输入**:
- `--code`: 股票代码
- `--industry`: 行业名称（用于行业新闻）
- `--days`: 获取天数（默认7天）

**输出**:
```json
{
  "code": "600519",
  "company_news": [
    {
      "title": "贵州茅台发布2025年业绩预告",
      "date": "2026-03-15",
      "source": "东方财富",
      "url": "...",
      "summary": "公司预计2025年净利润增长15%..."
    }
  ],
  "industry_news": [
    {
      "title": "白酒行业迎来消费升级政策",
      "date": "2026-03-14",
      "source": "财联社",
      "impact": "利好"
    }
  ]
}
```

**数据来源**:
- akshare: `ak.stock_news_em(symbol=code)` - 公司新闻
- akshare: `ak.stock_individual_info_em` - 获取行业后搜行业新闻
- 搜索引擎降级: 当 akshare 失败时使用 WebSearch 补充

---

### 2. `scripts/policy_analyzer.py`

**功能**: 获取行业政策并分析影响

**输入**:
- `--industry`: 行业名称
- `--days`: 天数（默认30天）

**输出**:
```json
{
  "industry": "白酒",
  "policies": [
    {
      "title": "消费税改革方案征求意见",
      "date": "2026-03-10",
      "source": "财政部",
      "impact": "利空",
      "summary": "可能对高端白酒征收更高消费税..."
    },
    {
      "title": "促消费政策出台",
      "date": "2026-03-05",
      "source": "国务院",
      "impact": "利好",
      "summary": "鼓励消费升级，利好高端消费品..."
    }
  ],
  "macro_indicators": {
    "csi300_change": "+0.85%",
    "north_money_flow": "+23.5亿",
    "market_sentiment": "偏多"
  }
}
```

**数据来源**:
- akshare: 行业政策新闻
- WebSearch: 财联社政策专题
- akshare: `ak.stock_index_spot_em()` - 大盘指数
- akshare: `ak.stock_north_em()` - 北向资金

---

### 3. `scripts/sentiment_scorer.py`

**功能**: 对新闻进行情感评分

**输入**: news_fetcher.py 输出

**输出**:
```json
{
  "overall_sentiment": "偏多",
  "sentiment_score": 65,
  "key_events": [
    {
      "title": "...",
      "sentiment": "利好",
      "score": 80,
      "reason": "业绩超预期"
    }
  ]
}
```

**实现方式**:
- 将新闻标题+摘要发送给 LLM 分析
- 情感评分 0-100，50为中性
- 输出关键事件列表

---

## 报告结构优化

**优化后 Workflow 2**:

```
Step 1: 收集股票信息（不变）
Step 1.5: 获取新闻 → news_fetcher.py
Step 1.6: 获取政策 → policy_analyzer.py
Step 1.7: 情感评分 → sentiment_scorer.py
Step 2: 获取财务数据（不变）
Step 3: 财务分析（不变）
Step 4: 估值计算（不变）
Step 5: 生成报告（整合所有维度）
```

**报告新结构**:
1. **公司概况** - 基本信息、主营业务
2. **当日/近期重大新闻摘要 + 情绪评分** ← 新增
3. **行业政策动态 + 影响分析** ← 新增
4. **宏观市场环境** ← 新增
5. **财务健康** - 资产负债表、盈利能力
6. **估值分析** - DCF/DDM/相对估值
7. **风险提示** - 财务异常 + 舆情风险
8. **综合结论** - 财务估值 + 舆情 + 政策面综合判断

---

## 关键设计决策

1. **独立脚本 vs 集成**: 采用独立脚本，职责清晰，可独立调用
2. **情感分析**: 由 LLM 完成，不依赖额外 NLP 库
3. **数据降级**: akshare 失败时自动降级到 WebSearch
4. **缓存**: 当天数据缓存，避免重复请求

---

## 文件变更

| 操作 | 文件路径 |
|------|----------|
| 新增 | `scripts/news_fetcher.py` |
| 新增 | `scripts/policy_analyzer.py` |
| 新增 | `scripts/sentiment_scorer.py` |
| 修改 | `SKILL.md` - 新增模块说明、更新 Workflow 2 |

---

## 测试计划

1. 对贵州茅台(600519)运行完整分析流程
2. 验证新闻获取数量和质量
3. 验证政策分析输出
4. 验证情感评分合理性
5. 生成完整报告检查格式

---

## 风险与限制

1. **新闻完整性**: akshare 新闻接口可能不覆盖所有来源
2. **政策时效性**: 政策信息可能存在延迟
3. **情感主观性**: LLM 情感评分有主观性，需结合其他因素判断
4. **网络稳定性**: 外部 API 调用可能失败，需降级处理
