# -*- coding: utf-8 -*-
"""听书：按句分段合成。

为什么分段（踩过的坑，`docs/03` A 节）：整章一次性合成，4000 字要几十秒才出声，
用户以为坏了。分段之后**第一段 1~2 秒就响**，后面边播边取。
"""
from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response

from ..config import CFG
from ..security import current_user
from ..store import book_dir, read_text
from ..tts import get_engine, list_engines
from ..tts.base import norm_rate
from ..tts.cache import (preview_path, seg_path, size as cache_size, whole_path,
                        write_atomic)

router = APIRouter(tags=["tts"])

# 试听念的这句话（短、能听出音色差别、不涉及任何用户内容）
PREVIEW_TEXT = "Gió từ cửa núi thổi xuống, cuốn theo bụi đất suốt dọc đường. Anh dừng bước, ngẩng đầu nhìn sắc trời."
PREVIEW_TEXT_MAX = 60      # 试听念多长：太长等着急，太短听不出音色


def _engine(key: str):
    """引擎收口：认不出来的引擎是**用户的输入问题**（400），不是服务器崩了（500）。

    踩过的坑：`?engine=nosuch` 原来把 `get_engine` 的 KeyError 漏出去，变成 HTTP 500
    "服务器内部错误" —— 用户看到的是"App 坏了"，实际只是参数写错。
    """
    try:
        return get_engine(key)
    except KeyError as e:
        raise HTTPException(400, str(e).strip("'"))


def _voice(v: str) -> str:
    """音色收口：不在配置表里的音色说人话，别把 edge-tts 的英文报错丢给用户。"""
    want = (v or "").strip() or str(CFG.get("default_voice"))
    known = [str(x.get("id")) for x in (CFG.get("voices") or []) if isinstance(x, dict)]
    if known and want not in known:
        raise HTTPException(400, f"Không có giọng đọc này: {want} (có {len(known)} giọng dùng được, chọn trong bảng Nghe truyện)")
    return want

_SENT = re.compile(r"[^。！？!?…；;\n]+[。！？!?…；;]*")


def to_speech(md: str) -> str:
    """Markdown → 可朗读的纯文本（标题号、加粗、列表符号都去掉）。"""
    t = re.sub(r"^#{1,6}\s*", "", md or "", flags=re.M)
    t = re.sub(r"\*\*(.+?)\*\*", r"\1", t)
    t = re.sub(r"[*_`>|]", "", t)
    t = re.sub(r"^\s*[-–—]\s*", "", t, flags=re.M)
    t = re.sub(r"^\s*\d+[.)]\s*", "", t, flags=re.M)
    t = re.sub(r"\n{2,}", "\n", t)
    return t.strip()[:20000]


def split_segments(text: str, limit: int | None = None) -> list[str]:
    """把正文切成每段约 limit 字的碎片，尽量断在句末。"""
    limit = int(limit or CFG.get("tts_segment_chars", 220))
    parts: list[str] = []
    for para in (text or "").split("\n"):
        para = para.strip()
        if not para:
            continue
        if len(para) <= limit:
            parts.append(para)
            continue
        for piece in _SENT.findall(para):
            piece = piece.strip()
            if not piece:
                continue
            while len(piece) > limit:
                parts.append(piece[:limit])
                piece = piece[limit:]
            if not piece:
                continue
            # 太短的碎片并在上一段里，避免出现"他。"这种孤零零的段
            if parts and len(parts[-1]) < limit * 0.6 and len(parts[-1]) + len(piece) <= limit:
                parts[-1] += piece
            else:
                parts.append(piece)
    if not parts and (text or "").strip():
        return [text.strip()[:limit]]
    return parts


def _chapter_text(slug: str, path: str) -> str:
    from .books import require_book, require_path
    s = require_book(slug)
    p = require_path(s, path)
    try:
        return to_speech(read_text(s, p))
    except FileNotFoundError:
        raise HTTPException(404, "Không có chương này")
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))


@router.get("/tts/selfcheck")
async def tts_selfcheck(request: Request, slug: str = "", path: str = "",
                        voice: str = "", rate: str = "+0%", engine: str = ""):
    """**听书自检**（）：把"点了听书没声"从**哑巴失败**变成逐项可见。

    此前的反馈是「App 里听书从来没有出过声音」，而界面上什么都不说 ——
    服务器侧当时实测是好的（合成成功、接口 200、公网反代也通），
    所以真正缺的是"**卡在哪一环、什么码、为什么**"这件事能在界面上看见。

    这个接口只回**服务器侧那几项的真数值**（引擎能不能用、这一章分几段、第 0 段多少字节、
    开头四个字节是不是合法 MPEG 帧头）。手机侧的加载与播放由前端那部分量
    （浏览器拿不到文件系统，也不该由服务器替它猜）。

    **故意永远回 200**：自检的结论放在 `ok` 里 —— 自检本身失败（404/500）就没法给用户看细节了。
    """
    current_user(request)
    out: dict = {"at": __import__("time").strftime("%Y-%m-%d %H:%M:%S"), "steps": [], "fails": []}

    def step(name: str, ok: bool, detail: dict):
        out["steps"].append({"name": name, "ok": bool(ok), "detail": detail})
        if not ok:
            out["fails"].append(name)

    # ① 引擎：装没装、认不认得
    try:
        eng = _engine(engine)
        step("Bộ máy đọc dùng được", True, {"engine": eng.key, "engines": list(list_engines()),
                                    "默认": CFG.get("tts_engine", "edge")})
    except HTTPException as e:
        step("Bộ máy đọc dùng được", False, {"engine": engine or CFG.get("tts_engine", "edge"),
                                     "错误": str(e.detail), "可选": list(list_engines())})
        out["ok"] = False
        out["结论"] = "Phần bộ máy đã không ổn: %s" % e.detail
        return out
    except Exception as e:
        step("Bộ máy đọc dùng được", False, {"错误": "%s: %s" % (type(e).__name__, e)})
        out["ok"] = False
        out["结论"] = "Bộ máy không khởi động được: %s" % e
        return out

    # ② 音色：认不认得（认不出来 = 用户挑的跟配置表对不上）
    try:
        v = _voice(voice)
        step("Giọng đọc dùng được", True, {"voice": v, "可选个数": len(CFG.get("voices") or [])})
    except HTTPException as e:
        step("Giọng đọc dùng được", False, {"voice": voice, "错误": str(e.detail)})
        out["ok"] = False
        out["结论"] = "Tên giọng đọc này không có trong bảng cấu hình: %s" % e.detail
        return out

    # ③ 这一章：读得到吗、分几段
    if not slug or not path:
        step("Chương này đọc được", False, {"slug": slug, "path": path, "错误": "Chưa chọn sách hoặc chương"})
        out["ok"] = False
        out["结论"] = "Chưa chỉ định sách/chương —— hãy mở một chương trong trình đọc rồi tự kiểm tra"
        return out
    try:
        text = _chapter_text(slug, path)
        segs = split_segments(text)
        step("Chương này đọc được", True, {"slug": slug, "path": path, "字数": len(text),
                                  "段落数": len(segs)})
    except HTTPException as e:
        step("Chương này đọc được", False, {"slug": slug, "path": path, "HTTP": e.status_code,
                                   "错误": str(e.detail)})
        out["ok"] = False
        out["结论"] = "Không đọc được chương này (%s): %s" % (e.status_code, e.detail)
        return out
    if not segs:
        step("Chương này có chữ để đọc", False, {"段落数": 0})
        out["ok"] = False
        out["结论"] = "Chương này không có chữ (chương trống / chỉ có tiêu đề), không có gì để đọc"
        return out

    # ④ 第 0 段音频：真合一次，看字节数和帧头 —— 这一步最能区分"没声"的两种原因
    r = norm_rate(rate)
    try:
        data = await eng.synth(segs[0], v, r)
        head = data[:4].hex(" ")
        mpeg = data[:2] == b"\xff\xf3" or data[:2] == b"\xff\xfb" or (len(data) > 1 and data[0] == 0xFF)
        step("Đoạn 0 tổng hợp được", bool(data) and mpeg,
             {"字节数": len(data), "开头四字节": head,
              "像MPEG帧头": mpeg, "第一段字数": len(segs[0]), "语速": r})
        if not data or not mpeg:
            out["ok"] = False
            out["结论"] = "Thứ tổng hợp ra không phải âm thanh (%d byte, mở đầu %s) —— bộ máy trên máy chủ có vấn đề" % (len(data), head)
            return out
    except Exception as e:
        step("Đoạn 0 tổng hợp được", False, {"错误": "%s: %s" % (type(e).__name__, e), "第一段字数": len(segs[0])})
        out["ok"] = False
        out["结论"] = "Tổng hợp thất bại: %s (bộ máy trên máy chủ không chạy thông đường này)" % e
        return out

    out["ok"] = True
    out["结论"] = ("Phía máy chủ thông hết (bộ máy %s / %s / chương này %d đoạn / đoạn 0 %d byte). "
                   "Nếu điện thoại vẫn không có tiếng, vấn đề nằm ở **khâu phát** —— xem mấy mục phía điện thoại trong phần tự kiểm tra."
                   % (eng.key, v, len(segs), len(data)))
    return out


@router.get("/tts/voices")
async def tts_voices(request: Request):
    current_user(request)
    return {"voices": CFG.get("voices") or [],
            "engines": list_engines(),
            "engine": CFG.get("tts_engine", "edge")}


@router.get("/tts/segments")
async def tts_segments(slug: str, path: str, request: Request,
                       voice: str = "", rate: str = "+0%", engine: str = ""):
    """只回"有几段、每段多少字"，很轻；前端据此知道要播几段、跟读到第几页。"""
    current_user(request)
    segs = split_segments(_chapter_text(slug, path))
    return {"count": len(segs), "chars": [len(s) for s in segs], "rate": norm_rate(rate),
            "voice": voice or CFG.get("default_voice"), "engine": engine or CFG.get("tts_engine", "edge")}


@router.get("/tts/seg")
async def tts_seg(slug: str, path: str, i: int, request: Request,
                  voice: str = "", rate: str = "+0%", engine: str = ""):
    """第 i 段的音频，逐段缓存。"""
    current_user(request)
    text = _chapter_text(slug, path)
    segs = split_segments(text)
    # 空章（比如新建书自带的那一章）要说人话：不是"没有这一段"，是"这一章没字可以念"。
    if not segs:
        raise HTTPException(400, "Chương này không có chữ đọc được, không có gì để đọc")
    if i < 0 or i >= len(segs):
        raise HTTPException(404, f"Không có đoạn này (chương này có tổng {len(segs)} đoạn, đếm từ 0)")
    eng = _engine(engine)
    v = _voice(voice)
    r = norm_rate(rate)
    out = seg_path(slug, path, i, v, r, len(segs[i]), eng.key)
    if not out.exists():
        try:
            data = await eng.synth(segs[i], v, r)
        except (KeyError, ValueError) as e:
            raise HTTPException(400, str(e))
        except Exception as e:
            raise HTTPException(502, f"Tổng hợp thất bại: {e}")
        write_atomic(out, data)
    return FileResponse(str(out), media_type="audio/mpeg")


@router.get("/tts")
async def tts_whole(slug: str, path: str, request: Request,
                    voice: str = "", rate: str = "+0%", engine: str = ""):
    """整章一段音频（兜底接口，前端现在不用它；保留是为了兼容旧链接）。"""
    current_user(request)
    text = _chapter_text(slug, path)
    if not text.strip():
        raise HTTPException(400, "Chương này không có chữ đọc được")
    eng = _engine(engine)
    v = _voice(voice)
    r = norm_rate(rate)
    out = whole_path(slug, path, v, r, eng.key)
    if not out.exists():
        try:
            data = await eng.synth(text, v, r)
        except (KeyError, ValueError) as e:
            raise HTTPException(400, str(e))
        except Exception as e:
            raise HTTPException(502, f"Tổng hợp thất bại: {e}")
        write_atomic(out, data)
    return FileResponse(str(out), media_type="audio/mpeg")


@router.get("/tts/preview")
async def tts_preview(request: Request, voice: str = "", rate: str = "+0%",
                      engine: str = "", text: str = ""):
    """试听：点一下喇叭就出声。

    为什么要有它（用户的可用性缺口）：音色列表原来只能"选"，不能"听"，
    左侧那个喇叭图标长得像播放键却点不动 —— 挑音色只能靠名字猜。
    这里合成很短一句（默认 `PREVIEW_TEXT`），并且**逐句缓存**，第二下点立刻响。
    """
    current_user(request)
    t = (text or "").strip()[:PREVIEW_TEXT_MAX] or PREVIEW_TEXT
    eng = _engine(engine)
    v = _voice(voice)
    r = norm_rate(rate)
    out = preview_path(v, r, t, eng.key)
    if not out.exists():
        try:
            data = await eng.synth(t, v, r)
        except (KeyError, ValueError) as e:
            raise HTTPException(400, str(e))
        except Exception as e:
            raise HTTPException(502, f"Tổng hợp thất bại: {e}")
        write_atomic(out, data)
    return FileResponse(str(out), media_type="audio/mpeg",
                        headers={"cache-control": "no-store"})


@router.get("/tts/cache")
async def tts_cache(request: Request):
    current_user(request)
    return cache_size()
