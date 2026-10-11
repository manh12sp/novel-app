# -*- coding: utf-8 -*-
"""edge-tts 引擎（默认）。"""
from __future__ import annotations

import asyncio

from .base import Engine, norm_rate, register

_SEM = asyncio.Semaphore(4)          # 同时最多合成 4 段，别把网络打爆


class EdgeEngine(Engine):
    key = "edge"
    label = "edge-tts (giọng trực tuyến của Microsoft, mặc định)"

    def available(self) -> tuple[bool, str]:
        try:
            import edge_tts  # noqa: F401
        except Exception:
            return False, "Chưa cài edge-tts (pip install edge-tts)"
        return True, ""

    async def synth(self, text: str, voice: str, rate: str) -> bytes:
        import edge_tts
        text = (text or "").strip()
        if not text:
            raise ValueError("Đoạn này không có chữ đọc được")
        r = norm_rate(rate)
        async with _SEM:
            com = edge_tts.Communicate(text, voice or "vi-VN-HoaiMyNeural", rate=r)
            buf = bytearray()
            async for chunk in com.stream():
                if chunk.get("type") == "audio" and chunk.get("data"):
                    buf += chunk["data"]
            if not buf:
                raise RuntimeError("Giọng đọc này không tổng hợp ra tiếng, hãy thử giọng khác")
            return bytes(buf)


register(EdgeEngine())
