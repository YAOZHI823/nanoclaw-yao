# China Stock Analysis - 新闻与政策增强实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 china-stock-analysis skill 添加新闻获取、政策分析、情感评分模块

**Architecture:** 新增3个独立Python脚本，遵循现有代码模式（argparse CLI、JSON输入输出、akshare数据源），通过 LLM 做情感分析

**Tech Stack:** Python 3, akshare, pandas, WebSearch (MCP工具)

---

## 文件结构

```
~/.agents/skills/china-stock-analysis/
├── scripts/
│   ├── news_fetcher.py      # [新建] 新闻获取
│   ├── policy_analyzer.py   # [新建] 政策分析
│   └── sentiment_scorer.py  # [新建] 情感评分
├── templates/
│   └── analysis_report.md    # [修改] 报告模板
└── SKILL.md                 # [修改] 更新文档
```

---

## Chunk 1: news_fetcher.py

### Task 1: 创建 news_fetcher.py

**Files:**
- Create: `~/.agents/skills/china-stock-analysis/scripts/news_fetcher.py`

- [ ] **Step 1: 编写新闻获取脚本框架**

```python
#!/usr/bin/env python3
"""
A股新闻获取模块
获取指定股票的公司新闻和行业新闻

依赖: pip install akshare pandas
"""

import argparse
import json
import sys
import time
from datetime import datetime, timedelta
from typing import Optional, List, Dict

try:
    import akshare as ak
    import pandas as pd
except ImportError:
    print("错误: 请先安装依赖库")
    print("pip install akshare pandas")
    sys.exit(1)


def retry_on_failure(max_retries: int = 3, delay: float = 1.0):
    """网络请求重试装饰器"""
    def decorator(func):
        def wrapper(*args, **kwargs):
            last_error = None
            for attempt in range(max_retries):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    last_error = e
                    if attempt < max_retries - 1:
                        time.sleep(delay * (attempt + 1))
            return {"error": f"重试{max_retries}次后失败: {str(last_error)}"}
        return wrapper
    return decorator


@retry_on_failure(max_retries=2, delay=1.0)
def get_company_news(code: str, days: int = 7) -> List[Dict]:
    """获取公司新闻"""
    try:
        df = ak.stock_news_em(symbol=code)
        if df is None or df.empty:
            return []

        news_list = []
        cutoff_date = (datetime.now() - timedelta(days=days)).strftime('%Y-%m-%d')

        for _, row in df.iterrows():
            date_str = str(row.get('发布时间', ''))
            if date_str >= cutoff_date:
                news_list.append({
                    "title": row.get('新闻标题', ''),
                    "date": date_str,
                    "source": row.get('文章来源', '未知'),
                    "url": row.get('新闻链接', ''),
                    "summary": row.get('新闻内容', '')[:200] if row.get('新闻内容') else ''
                })

        return news_list[:20]  # 最多返回20条
    except Exception as e:
        return [{"error": str(e)}]


@retry_on_failure(max_retries=2, delay=1.0)
def get_industry_news(industry: str, days: int = 7) -> List[Dict]:
    """获取行业新闻（使用搜索降级）"""
    # akshare 不直接提供行业新闻，使用 stock_news_em 搜索行业相关新闻
    try:
        # 尝试通过股票搜索间接获取
        df = ak.stock_news_em(symbol=industry)
        if df is None or df.empty:
            return []

        news_list = []
        cutoff_date = (datetime.now() - timedelta(days=days)).strftime('%Y-%m-%d')

        for _, row in df.iterrows():
            date_str = str(row.get('发布时间', ''))
            if date_str >= cutoff_date:
                news_list.append({
                    "title": row.get('新闻标题', ''),
                    "date": date_str,
                    "source": row.get('文章来源', '未知'),
                    "impact": "待分析"
                })

        return news_list[:10]
    except Exception as e:
        return [{"error": str(e)}]


def main():
    parser = argparse.ArgumentParser(description="A股新闻获取工具")
    parser.add_argument("--code", type=str, help="股票代码 (如: 600519)")
    parser.add_argument("--industry", type=str, help="行业名称 (如: 白酒)")
    parser.add_argument("--days", type=int, default=7, help="获取天数 (默认: 7)")
    parser.add_argument("--output", type=str, help="输出文件路径 (JSON)")

    args = parser.parse_args()

    result = {
        "fetch_time": datetime.now().isoformat(),
        "code": args.code,
        "industry": args.industry,
        "days": args.days
    }

    if args.code:
        print(f"正在获取 {args.code} 的公司新闻...")
        result["company_news"] = get_company_news(args.code, args.days)
        print(f"获取到 {len(result['company_news'])} 条公司新闻")

    if args.industry:
        print(f"正在获取 {args.industry} 的行业新闻...")
        result["industry_news"] = get_industry_news(args.industry, args.days)
        print(f"获取到 {len(result['industry_news'])} 条行业新闻")

    output = json.dumps(result, ensure_ascii=False, indent=2, default=str)

    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(output)
        print(f"\n数据已保存到: {args.output}")
    else:
        print(output)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 测试新闻获取**

Run: `python ~/.agents/skills/china-stock-analysis/scripts/news_fetcher.py --code 600519 --days 7 --output /tmp/news_test.json`
Expected: 输出 JSON 包含 company_news 数组

- [ ] **Step 3: 提交**

```bash
git add ~/.agents/skills/china-stock-analysis/scripts/news_fetcher.py
git commit -m "feat(china-stock-analysis): add news_fetcher.py for company/industry news"
```

---

## Chunk 2: policy_analyzer.py

### Task 2: 创建 policy_analyzer.py

**Files:**
- Create: `~/.agents/skills/china-stock-analysis/scripts/policy_analyzer.py`

- [ ] **Step 1: 编写政策分析脚本**

```python
#!/usr/bin/env python3
"""
A股政策分析模块
获取行业政策、宏观市场数据

依赖: pip install akshare pandas
"""

import argparse
import json
import sys
import time
from datetime import datetime, timedelta
from typing import Optional, List, Dict

try:
    import akshare as ak
    import pandas as pd
except ImportError:
    print("错误: 请先安装依赖库")
    print("pip install akshare pandas")
    sys.exit(1)


def retry_on_failure(max_retries: int = 3, delay: float = 1.0):
    """网络请求重试装饰器"""
    def decorator(func):
        def wrapper(*args, **kwargs):
            last_error = None
            for attempt in range(max_retries):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    last_error = e
                    if attempt < max_retries - 1:
                        time.sleep(delay * (attempt + 1))
            return {"error": f"重试{max_retries}次后失败: {str(last_error)}"}
        return wrapper
    return decorator


@retry_on_failure(max_retries=2, delay=1.0)
def get_macro_indicators() -> Dict:
    """获取宏观市场指标"""
    result = {}

    # 沪深300指数
    try:
        df = ak.stock_zh_index_spot_em(symbol="000300")
        if df is not None and not df.empty:
            latest = df.iloc[-1]
            result["csi300"] = {
                "price": float(latest.get('最新价', 0)),
                "change_pct": float(latest.get('涨跌幅', 0))
            }
    except Exception as e:
        result["csi300_error"] = str(e)

    # 北向资金
    try:
        df = ak.stock_north_em(indicator="北向资金")
        if df is not None and not df.empty:
            latest = df.iloc[-1]
            result["north_money"] = {
                "date": str(latest.get('日期', '')),
                "value": float(latest.get('北向资金', 0))
            }
    except Exception as e:
        result["north_money_error"] = str(e)

    return result


@retry_on_failure(max_retries=2, delay=1.0)
def get_policy_news(industry: str, days: int = 30) -> List[Dict]:
    """获取行业政策新闻"""
    # 使用 akshare 的新闻接口，搜索行业相关政策
    try:
        df = ak.stock_news_em(symbol=industry)
        if df is None or df.empty:
            return []

        policy_keywords = ['政策', '监管', '改革', '规划', '意见', '通知', '财政部', '证监会', '国务院']
        policy_list = []
        cutoff_date = (datetime.now() - timedelta(days=days)).strftime('%Y-%m-%d')

        for _, row in df.iterrows():
            title = str(row.get('新闻标题', ''))
            date_str = str(row.get('发布时间', ''))

            # 简单关键词匹配判断是否是政策新闻
            is_policy = any(kw in title for kw in policy_keywords)
            if is_policy and date_str >= cutoff_date:
                policy_list.append({
                    "title": title,
                    "date": date_str,
                    "source": row.get('文章来源', '未知'),
                    "impact": "待分析",
                    "summary": str(row.get('新闻内容', ''))[:200] if row.get('新闻内容') else ''
                })

        return policy_list[:15]
    except Exception as e:
        return [{"error": str(e)}]


def analyze_policy_impact(policies: List[Dict], industry: str) -> List[Dict]:
    """分析政策影响（基于关键词）"""
    # 利好/利空关键词
    positive_keywords = ['支持', '鼓励', '促进', '发展', '扩大', '增加', '补贴', '优惠', '改革']
    negative_keywords = ['限制', '监管', '规范', '收紧', '加强', '打击', '整治', '禁止']

    for policy in policies:
        title = policy.get('title', '')
        summary = policy.get('summary', '')

        positive_count = sum(1 for kw in positive_keywords if kw in title or kw in summary)
        negative_count = sum(1 for kw in negative_keywords if kw in title or kw in summary)

        if positive_count > negative_count:
            policy['impact'] = '利好'
        elif negative_count > positive_count:
            policy['impact'] = '利空'
        else:
            policy['impact'] = '中性'

    return policies


def main():
    parser = argparse.ArgumentParser(description="A股政策分析工具")
    parser.add_argument("--industry", type=str, help="行业名称 (如: 白酒)")
    parser.add_argument("--days", type=int, default=30, help="获取天数 (默认: 30)")
    parser.add_argument("--output", type=str, help="输出文件路径 (JSON)")

    args = parser.parse_args()

    result = {
        "fetch_time": datetime.now().isoformat(),
        "industry": args.industry,
        "days": args.days
    }

    # 获取宏观指标
    print("正在获取宏观市场指标...")
    result["macro_indicators"] = get_macro_indicators()

    # 获取政策新闻
    if args.industry:
        print(f"正在获取 {args.industry} 相关政策...")
        policies = get_policy_news(args.industry, args.days)
        policies = analyze_policy_impact(policies, args.industry)
        result["policies"] = policies
        print(f"获取到 {len(policies)} 条政策")

    output = json.dumps(result, ensure_ascii=False, indent=2, default=str)

    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(output)
        print(f"\n数据已保存到: {args.output}")
    else:
        print(output)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 测试政策分析**

Run: `python ~/.agents/skills/china-stock-analysis/scripts/policy_analyzer.py --industry 白酒 --days 30 --output /tmp/policy_test.json`
Expected: 输出 JSON 包含 macro_indicators 和 policies 数组

- [ ] **Step 3: 提交**

```bash
git add ~/.agents/skills/china-stock-analysis/scripts/policy_analyzer.py
git commit -m "feat(china-stock-analysis): add policy_analyzer.py for industry policy tracking"
```

---

## Chunk 3: sentiment_scorer.py

### Task 3: 创建 sentiment_scorer.py

**Files:**
- Create: `~/.agents/skills/china-stock-analysis/scripts/sentiment_scorer.py`

- [ ] **Step 1: 编写情感评分脚本**

```python
#!/usr/bin/env python3
"""
A股情感评分模块
对新闻进行情感分析，计算舆情评分

依赖: pip install akshare pandas
输入: news_fetcher.py 和 policy_analyzer.py 的输出JSON
输出: 情感评分结果（供 LLM 分析或直接使用关键词判断）
"""

import argparse
import json
import sys
from datetime import datetime
from typing import List, Dict, Optional

try:
    import pandas as pd
except ImportError:
    print("错误: 请先安装依赖库")
    print("pip install pandas")
    sys.exit(1)


# 情感关键词库
POSITIVE_KEYWORDS = [
    '增长', '盈利', '利润', '业绩', '超预期', '突破', '创新', '领先',
    '扩张', '合作', '签约', '中标', '获得', '荣誉', '获奖', '推荐',
    '买入', '增持', '利好', '上涨', '突破', '新高', '加速', '提升'
]

NEGATIVE_KEYWORDS = [
    '下降', '亏损', '风险', '警示', '调查', '处罚', '违规', '减持',
    '下跌', '利空', '下滑', '减少', '取消', '终止', '失败', '低于预期',
    '暴跌', '创新低', '恶化', '诉讼', '仲裁', '索赔'
]

IMPACT_KEYWORDS = {
    '利好': ['增长', '盈利', '合作', '中标', '补贴', '政策支持', '突破', '扩张'],
    '利空': ['调查', '处罚', '违规', '减持', '终止', '下跌', '风险', '诉讼']
}


def analyze_sentiment(news_list: List[Dict]) -> Dict:
    """分析新闻列表的情感"""
    if not news_list:
        return {
            "overall_sentiment": "中性",
            "sentiment_score": 50,
            "positive_count": 0,
            "negative_count": 0,
            "neutral_count": 0
        }

    positive_count = 0
    negative_count = 0
    neutral_count = 0
    key_events = []

    for news in news_list:
        title = news.get('title', '')
        summary = news.get('summary', '')

        # 合并标题和摘要进行情感判断
        text = title + ' ' + summary

        positive_hits = sum(1 for kw in POSITIVE_KEYWORDS if kw in text)
        negative_hits = sum(1 for kw in NEGATIVE_KEYWORDS if kw in text)

        if positive_hits > negative_hits:
            positive_count += 1
            sentiment = '利好'
            score = min(50 + positive_hits * 10, 100)
        elif negative_hits > positive_hits:
            negative_count += 1
            sentiment = '利空'
            score = max(50 - negative_hits * 10, 0)
        else:
            neutral_count += 1
            sentiment = '中性'
            score = 50

        news['sentiment'] = sentiment
        news['sentiment_score'] = score

        # 记录重要事件（高情感得分或高得分差异）
        if abs(positive_hits - negative_hits) >= 2:
            key_events.append({
                "title": title[:50],
                "sentiment": sentiment,
                "score": score,
                "reason": f"命中关键词: {'+' if positive_hits > negative_hits else '-'}{abs(positive_hits - negative_hits)}"
            })

    total = len(news_list)
    # 计算综合情感评分 (0-100, 50为中性)
    sentiment_score = 50 + (positive_count - negative_count) * 20 / max(total, 1)
    sentiment_score = max(0, min(100, sentiment_score))

    # 确定整体情感
    if sentiment_score >= 60:
        overall = "偏多"
    elif sentiment_score <= 40:
        overall = "偏空"
    else:
        overall = "中性"

    return {
        "overall_sentiment": overall,
        "sentiment_score": round(sentiment_score, 1),
        "positive_count": positive_count,
        "negative_count": negative_count,
        "neutral_count": neutral_count,
        "key_events": key_events[:5]  # 最多返回5个关键事件
    }


def main():
    parser = argparse.ArgumentParser(description="A股情感评分工具")
    parser.add_argument("--news-input", type=str, required=True, help="新闻数据输入文件 (news_fetcher.py 输出)")
    parser.add_argument("--policy-input", type=str, help="政策数据输入文件 (policy_analyzer.py 输出)")
    parser.add_argument("--output", type=str, help="输出文件路径 (JSON)")

    args = parser.parse_args()

    # 加载新闻数据
    with open(args.news_input, 'r', encoding='utf-8') as f:
        news_data = json.load(f)

    result = {
        "fetch_time": datetime.now().isoformat(),
        "news_sentiment": {},
        "policy_sentiment": {},
        "combined_sentiment": {}
    }

    # 分析公司新闻情感
    company_news = news_data.get('company_news', [])
    if company_news:
        result['news_sentiment'] = analyze_sentiment(company_news)
        print(f"公司新闻情感: {result['news_sentiment']['overall_sentiment']} ({result['news_sentiment']['sentiment_score']})")

    # 分析行业新闻情感
    industry_news = news_data.get('industry_news', [])
    if industry_news:
        result['industry_sentiment'] = analyze_sentiment(industry_news)
        print(f"行业新闻情感: {result['industry_sentiment']['overall_sentiment']} ({result['industry_sentiment']['sentiment_score']})")

    # 分析政策情感
    if args.policy_input:
        with open(args.policy_input, 'r', encoding='utf-8') as f:
            policy_data = json.load(f)

        policies = policy_data.get('policies', [])
        if policies:
            result['policy_sentiment'] = analyze_sentiment(policies)
            print(f"政策情感: {result['policy_sentiment']['overall_sentiment']} ({result['policy_sentiment']['sentiment_score']})")

    # 综合情感评分
    scores = []
    for key in ['news_sentiment', 'industry_sentiment', 'policy_sentiment']:
        if key in result and 'sentiment_score' in result[key]:
            scores.append(result[key]['sentiment_score'])

    if scores:
        combined_score = sum(scores) / len(scores)
        if combined_score >= 60:
            result['combined_sentiment'] = "偏多"
        elif combined_score <= 40:
            result['combined_sentiment'] = "偏空"
        else:
            result['combined_sentiment'] = "中性"
        result['combined_score'] = round(combined_score, 1)
        print(f"综合情感: {result['combined_sentiment']} ({result['combined_score']})")

    output = json.dumps(result, ensure_ascii=False, indent=2, default=str)

    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(output)
        print(f"\n数据已保存到: {args.output}")
    else:
        print(output)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 测试情感评分**

Run:
```bash
python ~/.agents/skills/china-stock-analysis/scripts/news_fetcher.py --code 600519 --days 7 --output /tmp/news_test.json
python ~/.agents/skills/china-stock-analysis/scripts/sentiment_scorer.py --news-input /tmp/news_test.json --output /tmp/sentiment_test.json
```
Expected: 输出 JSON 包含 sentiment_score 和 key_events

- [ ] **Step 3: 提交**

```bash
git add ~/.agents/skills/china-stock-analysis/scripts/sentiment_scorer.py
git commit -m "feat(china-stock-analysis): add sentiment_scorer.py for news sentiment analysis"
```

---

## Chunk 4: SKILL.md 更新

### Task 4: 更新 SKILL.md 文档

**Files:**
- Modify: `~/.agents/skills/china-stock-analysis/SKILL.md`

- [ ] **Step 1: 更新 Core Modules 部分**

在 "### 4. Valuation Calculator" 后添加：

```markdown
### 5. News Fetcher (新闻获取器)
获取公司新闻和行业新闻

### 6. Policy Analyzer (政策分析器)
获取行业政策动态和宏观市场指标

### 7. Sentiment Scorer (情感评分器)
对新闻进行情感分析，计算舆情评分
```

- [ ] **Step 2: 更新 Workflow 2**

在 "### Step 1: Collect Stock Information" 后，在 "### Step 2: Fetch Stock Data" 前添加：

```markdown
### Step 1.5: Fetch News Data

```bash
python scripts/news_fetcher.py \
    --code "600519" \
    --days 7 \
    --output news_data.json
```

**参数说明：**
- `--code`: 股票代码
- `--industry`: 行业名称（可选）
- `--days`: 获取天数（默认7天）
- `--output`: 输出文件路径

### Step 1.6: Fetch Policy Data

```bash
python scripts/policy_analyzer.py \
    --industry "白酒" \
    --days 30 \
    --output policy_data.json
```

**参数说明：**
- `--industry`: 行业名称
- `--days`: 获取天数（默认30天）
- `--output`: 输出文件路径

### Step 1.7: Analyze Sentiment

```bash
python scripts/sentiment_scorer.py \
    --news-input news_data.json \
    --policy-input policy_data.json \
    --output sentiment_result.json
```

**参数说明：**
- `--news-input`: 新闻数据输入文件
- `--policy-input`: 政策数据输入文件（可选）
- `--output`: 输出文件路径
```

- [ ] **Step 3: 更新报告结构**

将 "报告结构（标准级）" 更新为：

```markdown
报告结构（标准级）：
1. **公司概况**：基本信息、主营业务
2. **当日/近期重大新闻摘要 + 情绪评分** ← 新增
3. **行业政策动态 + 影响分析** ← 新增
4. **宏观市场环境** ← 新增（从 policy_analyzer 获取）
5. **财务健康**：资产负债表分析
6. **盈利能力**：杜邦分析、利润率趋势
7. **成长性分析**：营收/利润增长趋势
8. **估值分析**：DCF/DDM/相对估值
9. **风险提示**：财务异常检测 + 舆情风险 ← 增强
10. **综合结论**：财务估值 + 舆情 + 政策面综合判断 ← 增强
```

- [ ] **Step 4: 提交**

```bash
git add ~/.agents/skills/china-stock-analysis/SKILL.md
git commit -m "docs(china-stock-analysis): update SKILL.md with news/policy modules"
```

---

## Chunk 5: 集成测试

### Task 5: 完整流程测试

- [ ] **Step 1: 运行完整分析流程**

```bash
# 1. 获取新闻
python ~/.agents/skills/china-stock-analysis/scripts/news_fetcher.py --code 600519 --days 7 --output /tmp/news_600519.json

# 2. 获取政策
python ~/.agents/skills/china-stock-analysis/scripts/policy_analyzer.py --industry 白酒 --days 30 --output /tmp/policy_baijiu.json

# 3. 情感评分
python ~/.agents/skills/china-stock-analysis/scripts/sentiment_scorer.py \
    --news-input /tmp/news_600519.json \
    --policy-input /tmp/policy_baijiu.json \
    --output /tmp/sentiment_600519.json

# 4. 获取财务数据
python ~/.agents/skills/china-stock-analysis/scripts/data_fetcher.py \
    --code 600519 \
    --data-type all \
    --years 5 \
    --output /tmp/stock_600519.json

# 5. 财务分析
python ~/.agents/skills/china-stock-analysis/scripts/financial_analyzer.py \
    --input /tmp/stock_600519.json \
    --level standard \
    --output /tmp/analysis_600519.json

# 6. 估值计算
python ~/.agents/skills/china-stock-analysis/scripts/valuation_calculator.py \
    --input /tmp/stock_600519.json \
    --methods dcf,ddm,relative \
    --discount-rate 10 \
    --growth-rate 8 \
    --output /tmp/valuation_600519.json
```

- [ ] **Step 2: 验证输出**

检查各输出文件是否包含有效数据，特别是：
- `sentiment_600519.json` 中的 `sentiment_score` 和 `key_events`
- `policy_baijiu.json` 中的 `macro_indicators`

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "test(china-stock-analysis): add news/policy integration test"
```

---

## 验收标准

1. `news_fetcher.py --code 600519 --days 7` 返回最近7天新闻
2. `policy_analyzer.py --industry 白酒 --days 30` 返回政策列表和宏观指标
3. `sentiment_scorer.py` 能对新闻进行情感评分
4. SKILL.md 包含新模块说明和更新后的报告结构
5. 完整流程可运行，无报错

---

## 风险与限制

1. akshare 新闻接口可能不覆盖所有来源，降级方案使用 WebSearch
2. 情感关键词判断较粗糙，更精确的情感分析需 LLM
3. 政策影响分析目前基于关键词，未来可结合 LLM 做深度分析
