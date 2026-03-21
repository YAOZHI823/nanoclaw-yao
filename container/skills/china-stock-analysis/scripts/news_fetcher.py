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
    """获取行业新闻"""
    try:
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
