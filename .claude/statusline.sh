#!/bin/bash
# Claude Code ステータスライン表示スクリプト
# stdinからJSON形式のセッションデータを受け取り、整形して表示する

input=$(cat)

# --- 値の取得 ---
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
model=$(echo "$input" | jq -r '.model.display_name // empty')
cost=$(echo "$input" | jq -r '.cost.total_cost_usd // empty')           # API利用時のみ存在
rate_5h=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')  # サブスクリプション時のみ存在
rate_7d=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')  # サブスクリプション時のみ存在
effort=$(echo "$input" | jq -r '.effort.level // empty')  # 推論effortレベル（対応モデルのみ存在）

# --- 表示 ---
if [ -n "$used" ]; then
  # コンテキスト使用率の色分け（50%以上:黄, 80%以上:赤, それ以外:緑）
  used_int=${used%.*}
  if [ "$used_int" -ge 80 ]; then
    ctx_color="\033[31m"
  elif [ "$used_int" -ge 50 ]; then
    ctx_color="\033[33m"
  else
    ctx_color="\033[32m"
  fi
  reset="\033[0m"
  printf "Context: ${ctx_color}${used}%%${reset}"

  # セッション累計コスト（USD）
  if [ -n "$cost" ]; then
    printf " | Cost: \$ %.2f" "$cost"
  fi

  # レート制限の消費率（色分けはコンテキストと同じ基準）
  if [ -n "$rate_5h" -o -n "$rate_7d" ]; then
      printf " | Rate:"
  fi
  if [ -n "$rate_5h" ]; then
    rate_5h_int=${rate_5h%.*}
    if [ "$rate_5h_int" -ge 80 ]; then
      printf "\033[31m %.0f%%\033[0m(5h)" "$rate_5h"
    elif [ "$rate_5h_int" -ge 50 ]; then
      printf "\033[33m %.0f%%\033[0m(5h)" "$rate_5h"
    else
      printf "\033[32m %.0f%%\033[0m(5h)" "$rate_5h"
    fi
  fi
  if [ -n "$rate_7d" ]; then
    rate_7d_int=${rate_7d%.*}
    if [ "$rate_7d_int" -ge 80 ]; then
      printf "\033[31m %.0f%%\033[0m(7d)" "$rate_7d"
    elif [ "$rate_7d_int" -ge 50 ]; then
      printf "\033[33m %.0f%%\033[0m(7d)" "$rate_7d"
    else
      printf "\033[32m %.0f%%\033[0m(7d)" "$rate_7d"
    fi
  fi

  # モデル名
  if [ -n "$model" ]; then
    # 推論effortレベル
    if [ -n "$effort" ]; then
      printf " | %s" "$model ($effort)"
    else
      printf " | %s" "$model"
    fi
  fi
else
  # コンテキスト情報が未取得の場合（セッション初期など）
  if [ -n "$model" ]; then
    # 推論effortレベル
    if [ -n "$effort" ]; then
      printf "%s" "$model ($effort)"
    else
      printf "%s" "$model"
    fi
  fi
fi
printf "\n"