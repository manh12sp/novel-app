# -*- coding: utf-8 -*-
"""配置加载：`server/config.json` 是唯一入口，缺失时用安全默认值。

密钥规矩：`config.json` 里**不放任何明文密钥**（口令只存哈希，渠道 key 存在数据库里）。
"""
from __future__ import annotations

import json
import os
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parent
CONFIG_PATH = Path(os.environ.get("NOVELAPP_CONFIG", SERVER_DIR / "config.json"))

DEFAULTS = {
    "app_name": "Tiểu thuyết",
    "host": "127.0.0.1",
    "port": 8899,
    "data_root": "data",
    "log_dir": "logs",
    "frontend_dir": "frontend",
    "apk_dir": "apk",
    "default_voice": "vi-VN-HoaiMyNeural",
    "tts_engine": "edge",
    "tts_segment_chars": 220,
    "token_ttl_days": 180,
    "login_fail_limit": 8,
    "login_fail_window": 600,
    "log_level": "warning",
    # 可选音色（前端 audio 选择器直接渲染这个列表）
    "voices": [
        {"id": "vi-VN-HoaiMyNeural", "name": "Hoài My · giọng nữ (tiếng Việt)", "engine": "edge"},
        {"id": "vi-VN-NamMinhNeural", "name": "Nam Minh · giọng nam (tiếng Việt)", "engine": "edge"},
        {"id": "zh-CN-YunxiNeural", "name": "Vân Hi · giọng nam (tiếng Trung)", "engine": "edge"},
        {"id": "zh-CN-YunjianNeural", "name": "Vân Kiện · giọng nam trầm ổn (tiếng Trung)", "engine": "edge"},
        {"id": "zh-CN-XiaoxiaoNeural", "name": "Hiểu Hiểu · giọng nữ (tiếng Trung)", "engine": "edge"},
        {"id": "zh-CN-XiaoyiNeural", "name": "Hiểu Y · giọng nữ hoạt bát (tiếng Trung)", "engine": "edge"},
        {"id": "zh-CN-YunyangNeural", "name": "Vân Dương · giọng nam phát thanh (tiếng Trung)", "engine": "edge"},
        {"id": "zh-CN-liaoning-XiaobeiNeural", "name": "Hiểu Bắc · giọng nữ Đông Bắc (tiếng Trung)", "engine": "edge"},
        {"id": "zh-TW-HsiaoChenNeural", "name": "Hiểu Trăn · giọng nữ Đài Loan (tiếng Trung)", "engine": "edge"},
        {"id": "zh-HK-HiuMaanNeural", "name": "Hiểu Mạn · giọng nữ Quảng Đông", "engine": "edge"},
    ],
}


class Config(dict):
    def __init__(self, data: dict):
        super().__init__({**DEFAULTS, **data})

    def __getattr__(self, k):
        try:
            return self[k]
        except KeyError as e:
            raise AttributeError(k) from e


def load() -> Config:
    data = {}
    if CONFIG_PATH.exists():
        try:
            data = json.loads(CONFIG_PATH.read_text("utf-8"))
        except Exception as e:
            raise SystemExit(f"Không đọc được file cấu hình: {CONFIG_PATH} —— {e}")
    return Config(data)


def save(cfg: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


CFG = load()
