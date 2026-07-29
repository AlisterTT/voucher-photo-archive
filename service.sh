#!/bin/sh

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PID_FILE="$SCRIPT_DIR/.voucher-server.pid"
LOG_FILE="$SCRIPT_DIR/service.log"
SERVER_FILE="$SCRIPT_DIR/server.mjs"
CONFIG_FILE="$SCRIPT_DIR/config.json"

configured_port() {
  if [ -n "${PORT:-}" ]; then
    printf "%s" "$PORT"
    return
  fi
  if command -v node >/dev/null 2>&1 && [ -f "$CONFIG_FILE" ]; then
    node -e '
      const fs = require("node:fs");
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).port;
      if (!Number.isInteger(value) || value < 1 || value > 65535) process.exit(1);
      process.stdout.write(String(value));
    ' "$CONFIG_FILE" 2>/dev/null && return
  fi
  printf "3000"
}

read_pid() {
  if [ -f "$PID_FILE" ]; then
    tr -cd '0-9' < "$PID_FILE"
  fi
}

is_our_process() {
  target_pid=$1
  [ -n "$target_pid" ] || return 1
  kill -0 "$target_pid" 2>/dev/null || return 1
  process_command=$(ps -p "$target_pid" -o command= 2>/dev/null || true)
  case "$process_command" in
    *"$SERVER_FILE"*|*"node server.mjs"*) return 0 ;;
    *) return 1 ;;
  esac
}

show_addresses() {
  service_port=$(configured_port)
  echo "电脑访问：http://localhost:$service_port"
  if command -v ipconfig >/dev/null 2>&1; then
    lan_ip=$(ipconfig getifaddr en0 2>/dev/null || true)
    if [ -n "$lan_ip" ]; then
      echo "手机访问：http://$lan_ip:$service_port"
    fi
  elif command -v hostname >/dev/null 2>&1; then
    lan_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    if [ -n "$lan_ip" ]; then
      echo "手机访问：http://$lan_ip:$service_port"
    fi
  fi
}

start_service() {
  current_pid=$(read_pid)
  if is_our_process "$current_pid"; then
    echo "服务已经在运行，进程号：$current_pid"
    show_addresses
    return 0
  fi

  if [ -f "$PID_FILE" ]; then
    rm -f "$PID_FILE"
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "启动失败：没有找到 Node.js，请先安装 Node.js 18 或更高版本。"
    return 1
  fi
  if ! node -e "require.resolve('jszip')" >/dev/null 2>&1; then
    echo "启动失败：依赖尚未安装。请先在本目录执行 npm install。"
    return 1
  fi

  nohup node "$SERVER_FILE" >> "$LOG_FILE" 2>&1 &
  new_pid=$!
  echo "$new_pid" > "$PID_FILE"
  sleep 1

  if is_our_process "$new_pid"; then
    echo "服务已启动，进程号：$new_pid"
    show_addresses
    echo "运行日志：$LOG_FILE"
  else
    echo "启动失败，请查看日志：$LOG_FILE"
    rm -f "$PID_FILE"
    return 1
  fi
}

stop_service() {
  current_pid=$(read_pid)
  if [ -z "$current_pid" ]; then
    echo "服务当前没有运行。"
    return 0
  fi

  if ! is_our_process "$current_pid"; then
    echo "记录的进程不是本系统，已清理无效状态，不会终止该进程。"
    rm -f "$PID_FILE"
    return 0
  fi

  kill "$current_pid"
  wait_count=0
  while kill -0 "$current_pid" 2>/dev/null && [ "$wait_count" -lt 30 ]; do
    sleep 0.1
    wait_count=$((wait_count + 1))
  done

  if kill -0 "$current_pid" 2>/dev/null; then
    kill -KILL "$current_pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  echo "服务已关闭。"
}

show_status() {
  current_pid=$(read_pid)
  if is_our_process "$current_pid"; then
    echo "服务正在运行，进程号：$current_pid"
    show_addresses
  else
    echo "服务当前没有运行。"
  fi
}

show_menu() {
  echo ""
  echo "================================"
  echo "  凭证照片归档系统 · 服务开关"
  echo "================================"
  echo "  1. 启动服务"
  echo "  2. 关闭服务"
  echo "  3. 重启服务"
  echo "  4. 查看状态"
  echo "  0. 退出"
  echo "================================"
  printf "请选择功能 [0-4]："
  IFS= read -r menu_choice
  echo ""

  case "$menu_choice" in
    1) start_service ;;
    2) stop_service ;;
    3)
      stop_service
      start_service
      ;;
    4) show_status ;;
    0) echo "已退出，没有执行任何操作。" ;;
    *) echo "输入无效，请重新运行脚本并输入 0、1、2、3 或 4。" ;;
  esac
}

action=${1:-menu}
case "$action" in
  start)
    start_service
    ;;
  stop)
    stop_service
    ;;
  restart)
    stop_service
    start_service
    ;;
  status)
    show_status
    ;;
  menu)
    show_menu
    ;;
  *)
    echo "用法：$0 [start|stop|restart|status]"
    exit 2
    ;;
esac
