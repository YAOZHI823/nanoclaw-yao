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
        df = ak.stock_zh_index_spot_em(symbol="沪深重要指数")
        if df is not None and not df.empty:
            # 筛选沪深300
            csi300_row = df[df.get('代码', '').astype(str).str.contains('000300|399300')]
            if not csi300_row.empty:
                latest = csi300_row.iloc[-1]
                result["csi300"] = {
                    "price": float(latest.get('最新价', 0)),
                    "change_pct": float(latest.get('涨跌幅', 0))
                }
            elif '最新价' in df.columns:
                # 如果找不到沪深300，返回第一行作为降级
                latest = df.iloc[0]
                result["csi300"] = {
                    "price": float(latest.get('最新价', 0)),
                    "change_pct": float(latest.get('涨跌幅', 0)),
                    "note": "沪深300数据获取失败，使用通用指数"
                }
    except Exception as e:
        result["csi300_error"] = str(e)

    # 北向资金 (沪深港通资金流向)
    try:
        df = ak.stock_hsgt_fund_flow_summary_em()
        if df is not None and not df.empty:
            latest = df.iloc[-1]
            # 尝试获取北向资金字段
            north_value = latest.get('北向资金', latest.get('净买入', 0))
            result["north_money"] = {
                "date": str(latest.get('日期', '')),
                "value": float(north_value)
            }
    except Exception as e:
        result["north_money_error"] = str(e)

    return result


@retry_on_failure(max_retries=2, delay=1.0)
def get_policy_news(industry: str, days: int = 30) -> List[Dict]:
    """获取行业政策新闻"""
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
