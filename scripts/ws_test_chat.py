#!/usr/bin/env python3
"""
天宫 Agent 互发消息 WebSocket 测试
两个 Agent 连接后，A 通过 tRPC message.send 给 B 发消息，验证 B 实时收到。

用法：
  python3 scripts/ws_test_chat.py \
    --http http://localhost:3999 --ws ws://localhost:3999 \
    --from-agent 1 --from-token xxx --to-agent 2 --to-token yyy
"""

import asyncio
import json
import argparse
import urllib.request
import websockets


def trpc_payload(input_obj):
    # tRPC non-batch POST accepts raw input JSON for procedure in this project.
    return json.dumps(input_obj).encode()


def ws_url(base: str, agent_id: int, token: str) -> str:
    return f"{base.rstrip('/')}/ws?agentId={agent_id}&token={token}"


async def recv_until_message(ws, timeout=8):
    deadline = asyncio.get_event_loop().time() + timeout
    events = []
    while asyncio.get_event_loop().time() < deadline:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=deadline - asyncio.get_event_loop().time())
        except asyncio.TimeoutError:
            break
        data = json.loads(raw)
        events.append(data)
        if data.get("type") == "message":
            return data, events
    return None, events


async def test_chat(args):
    http = args.http.rstrip("/")
    ws_base = args.ws.rstrip("/")

    print("=" * 70)
    print("天宫 Agent WebSocket 互发消息测试")
    print("=" * 70)

    print(f"\n[1/4] 连接 Agent A #{args.from_agent}...")
    ws_a = await websockets.connect(ws_url(ws_base, args.from_agent, args.from_token))
    print("  ✅ Agent A 已连接")

    print(f"[2/4] 连接 Agent B #{args.to_agent}...")
    ws_b = await websockets.connect(ws_url(ws_base, args.to_agent, args.to_token))
    print("  ✅ Agent B 已连接")

    await asyncio.sleep(0.5)

    content = args.content
    print(f"\n[3/4] Agent A → Agent B: {content}")
    req = urllib.request.Request(
        f"{http}/api/trpc/message.send",
        data=trpc_payload({
            "fromAgent": args.from_agent,
            "toAgent": args.to_agent,
            "content": content,
            "type": args.type,
        }),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        result = json.loads(resp.read())
    print(f"  ✅ HTTP 发送完成: {json.dumps(result, ensure_ascii=False)[:300]}")

    print("\n[4/4] 等待 Agent B WebSocket 实时推送...")
    msg, events = await recv_until_message(ws_b, timeout=8)
    if msg:
        print(f"  ✅ Agent B 实时收到: {json.dumps(msg, ensure_ascii=False)[:500]}")
    else:
        print("  ❌ 超时，未收到 message 事件")
        print(f"  已收到事件: {json.dumps(events, ensure_ascii=False)[:500]}")

    await ws_a.close()
    await ws_b.close()
    print("\n测试完成")


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--http", default="http://localhost:3999", help="HTTP base")
    parser.add_argument("--ws", default="ws://localhost:3999", help="WebSocket base")
    parser.add_argument("--from-agent", type=int, required=True)
    parser.add_argument("--from-token", required=True)
    parser.add_argument("--to-agent", type=int, required=True)
    parser.add_argument("--to-token", required=True)
    parser.add_argument("--content", default="你好，我是 Agent A。请确认收到，并准备执行任务。")
    parser.add_argument("--type", default="command", choices=["command", "response", "broadcast", "system"])
    args = parser.parse_args()
    await test_chat(args)


if __name__ == "__main__":
    asyncio.run(main())
