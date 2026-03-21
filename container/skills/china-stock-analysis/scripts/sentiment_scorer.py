#!/usr/bin/env python3
"""
A股情感评分模块
对新闻进行情感分析，计算舆情评分

依赖: pip install akshare pandas
输入: news_fetcher.py 和 policy_analyzer.py 的输出JSON
输出: 情感评分结果
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

        if abs(positive_hits - negative_hits) >= 2:
            key_events.append({
                "title": title[:50],
                "sentiment": sentiment,
                "score": score,
                "reason": f"命中关键词: {'+' if positive_hits > negative_hits else '-'}{abs(positive_hits - negative_hits)}"
            })

    total = len(news_list)
    sentiment_score = 50 + (positive_count - negative_count) * 20 / max(total, 1)
    sentiment_score = max(0, min(100, sentiment_score))

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
        "key_events": key_events[:5]
    }


def main():
    parser = argparse.ArgumentParser(description="A股情感评分工具")
    parser.add_argument("--news-input", type=str, required=True, help="新闻数据输入文件 (news_fetcher.py 输出)")
    parser.add_argument("--policy-input", type=str, help="政策数据输入文件 (policy_analyzer.py 输出)")
    parser.add_argument("--output", type=str, help="输出文件路径 (JSON)")

    args = parser.parse_args()

    with open(args.news_input, 'r', encoding='utf-8') as f:
        news_data = json.load(f)

    result = {
        "fetch_time": datetime.now().isoformat(),
        "news_sentiment": {},
        "policy_sentiment": {},
        "combined_sentiment": {}
    }

    company_news = news_data.get('company_news', [])
    if company_news:
        result['news_sentiment'] = analyze_sentiment(company_news)
        print(f"公司新闻情感: {result['news_sentiment']['overall_sentiment']} ({result['news_sentiment']['sentiment_score']})")

    industry_news = news_data.get('industry_news', [])
    if industry_news:
        result['industry_sentiment'] = analyze_sentiment(industry_news)
        print(f"行业新闻情感: {result['industry_sentiment']['overall_sentiment']} ({result['industry_sentiment']['sentiment_score']})")

    if args.policy_input:
        with open(args.policy_input, 'r', encoding='utf-8') as f:
            policy_data = json.load(f)

        policies = policy_data.get('policies', [])
        if policies:
            result['policy_sentiment'] = analyze_sentiment(policies)
            print(f"政策情感: {result['policy_sentiment']['overall_sentiment']} ({result['policy_sentiment']['sentiment_score']})")

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
