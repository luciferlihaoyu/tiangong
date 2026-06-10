#!/usr/bin/env python3
"""
天宫 Agent WebSocket 测试客户端
模拟单个 Agent 连接天宫，接收实时消息/任务。

用法：
  python3 scripts/ws_test_agent.py --base ws://localhost:3999 --agent-id 1 --token xxx --name 美智子
  python3 scripts/ws_test_agent.py --base wss://<your-domain> --agent-id 2 --token yyy --name 编程大师
"""

import asyncio
import argparse
import json
import websockets


def ws_url(base: str, agent_id: int, token: str) -> str:
    base = base.rstrip("/")
    return f"{base}/ws?agentId={agent_id}&token={token}"


async def agent_client(base: str, agent_id: int, token: str, name: str):
    """Agent WebSocket 客户端"""
    url = ws_url(base, agent_id, token)

    print(f"[{name}] 正在连接天宫: {base}/ws?agentId={agent_id}&token=***")
    try:
        async with websockets.connect(url) as ws:
            print(f"[{name}] ✅ 已连接天宫 WebSocket")

            async def heartbeat():
                while True:
                    await ws.send(json.dumps({"type": "ping"}))
                    await asyncio.sleep(30)

            async def receiver():
                while True:
                    try:
                        raw = await ws.recv()
                        data = json.loads(raw)
                        msg_type = data.get("type", "unknown")

                        if msg_type == "pong":
                            continue
                        if msg_type == "offline_messages":
                            msgs = data.get("messages", [])
                            print(f"[{name}] 📬 收到 {len(msgs)} 条离线消息")
                            for m in msgs:
                                print(f"  ← Agent#{m.get('fromAgent')}: {m.get('content', '')[:120]}")
                        elif msg_type == "message":
                            msg = data.get("message", {})
                            print(f"\n[{name}] 📩 新消息来自 Agent#{msg.get('fromAgent')}: {msg.get('content', '')[:160]}")
                        elif msg_type == "broadcast":
                            msg = data.get("message", {})
                            print(f"\n[{name}] 📣 广播来自 Agent#{msg.get('fromAgent')}: {msg.get('content', '')[:160]}")
                        elif msg_type == "task_assigned":
                            task = data.get("task", {})
                            print(f"[{name}] 🎯 收到任务: {task.get('name', 'unknown')}")
                        else:
                            print(f"[{name}] 📨 收到: {json.dumps(data, ensure_ascii=False)[:300]}")
                    except websockets.ConnectionClosed:
                        print(f"[{name}] ❌ 连接断开")
                        break

            hb_task = asyncio.create_task(heartbeat())
            recv_task = asyncio.create_task(receiver())
            print(f"[{name}] 🟢 在线，等待消息... (Ctrl+C 退出)")

            try:
                await recv_task
            except KeyboardInterrupt:
                print(f"\n[{name}] 断开连接...")
            finally:
                hb_task.cancel()

    except Exception as e:
        print(f"[{name}] ❌ 连接失败: {e}")


async def main():
    parser = argparse.ArgumentParser(description="天宫 Agent WebSocket 测试客户端")
    parser.add_argument("--base", default="ws://localhost:3999", help="WebSocket base，例如 ws://localhost:3999 或 wss://domain")
    parser.add_argument("--agent-id", type=int, required=True, help="Agent 在天宫中的数字 ID")
    parser.add_argument("--token", required=True, help="该 Agent 绑定的 MCP API Key")
    parser.add_argument("--name", default="Agent", help="显示名称")
    args = parser.parse_args()

    await agent_client(args.base, args.agent_id, args.token, args.name)


if __name__ == "__main__":
    asyncio.run(main())
