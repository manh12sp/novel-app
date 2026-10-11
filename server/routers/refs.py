# -*- coding: utf-8 -*-
"""参考书架（18.5）：摘抄 / 心得 / 整篇范文 / **图片与文件** —— 放进来、搜得到、写的时候能带进提示词。

图片这一块是要的：
  「可以让他弄成支持文件输入，通过图片输入，比如说来告诉他这个人的具体感觉该怎么写，我可以发一个图片」。
所以一条参考可以是：文字（老样子）、一张图（png/jpg/webp/gif/avif，能多张）、或者一个文件（md/txt/json/csv）。
文件存在书自己的目录里（`<书>/.novel/refs/`），跟着书走；库里只记文件名与类型。

⚠️ 一句实话（别让用户误解）：**图片本身进不了纯文本模型的上下文**。
   进提示词的是它的**说明文字**（用户在面板里写的那段）+ 文件名，
   也就是"模型知道有这张图、照说明来"。要让它真的"看图"，得走能看图的模型通道，
   那是另一件事，不在这条里 —— 所以这里**不假装**模型看得到图（见 docs/自审清单）。
"""
from __future__ import annotations

import re
import uuid
from pathlib import Path

from fastapi import APIRouter, Body, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from .. import args
from .. import db as dbm
from ..args import num
from ..security import current_user
from ..store import book_dir
from .books import IMAGE_CT, require_book

router = APIRouter(tags=["refs"])

MAX_TEXT = 200_000
MAX_IMG = 20 * 1024 * 1024        # 一张图 20MB 上限（手机随手一拍也就 3~6MB）
MAX_FILE = 8 * 1024 * 1024        # 别的文件 8MB
DOC_EXT = {".md": "text/markdown", ".txt": "text/plain", ".json": "application/json",
           ".csv": "text/csv", ".yml": "text/yaml", ".yaml": "text/yaml", ".html": "text/html"}


def _refs_dir(slug: str) -> Path:
    d = book_dir(slug) / ".novel" / "refs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _slug(value) -> str:
    from .books import require_book
    return require_book(value or "")


def _row(r: dict) -> dict:
    d = dbm.Database
    file = ""
    mime = ""
    try:
        file = r["file"] or ""
        mime = r["mime"] or ""
    except Exception:
        pass                                  # 老库（没跑 0010 迁移）也不至于 500
    return {"id": r["id"], "title": r["title"], "author": r["author"], "source": r["source"],
            "kind": r["kind"], "tags": d.jloads(r["tags_json"], []) or [],
            "words": r["words"], "preview": re.sub(r"\s+", " ", (r["text"] or ""))[:160],
            "file": file, "mime": mime, "hasFile": bool(file),
            "updatedAt": r["updated_at"]}


@router.get("/refs")
async def list_refs(request: Request, slug: str, q: str = "", tag: str = "", limit: int = 200):
    current_user(request)
    s = _slug(slug)
    sql = "SELECT * FROM reference WHERE slug=?"
    p: list = [s]
    if tag:
        sql += " AND tags_json LIKE ?"
        p.append(f"%{tag}%")
    if q:
        sql += " AND (title LIKE ? OR text LIKE ? OR source LIKE ?)"
        p += [f"%{q}%"] * 3
    rows = dbm.db().query(sql + " ORDER BY id DESC LIMIT ?", (*p, max(1, min(1000, int(limit)))))
    tags = dbm.db().query("SELECT tags_json FROM reference WHERE slug=?", (s,))
    all_tags = sorted({t for r in tags for t in (dbm.Database.jloads(r["tags_json"], []) or [])})
    return {"items": [_row(r) for r in rows], "count": len(rows), "tags": all_tags}


@router.get("/refs/item")
async def get_ref(request: Request, slug: str, id: int):
    current_user(request)
    s = _slug(slug)
    r = dbm.db().one("SELECT * FROM reference WHERE slug=? AND id=?", (s, id))
    if not r:
        raise HTTPException(404, "Trên giá không có mục này")
    out = _row(r)
    out["text"] = r["text"]
    out["tags"] = dbm.Database.jloads(r["tags_json"], []) or []
    return out


@router.post("/refs/item")
async def save_ref(request: Request, payload: dict = Body(...)):
    """新增或改一条。`id` 给了就是改。文本超长会被拒（不是静默截断 —— 静默截断最坑人）。"""
    current_user(request)
    s = _slug(payload.get("slug") or "")
    title = args.s(payload.get("title"), name="Tiêu đề").strip()
    text = args.s(payload.get("text"), name="Nội dung")
    if not title:
        raise HTTPException(400, "Đặt tên cho mục này (sau này mới tìm được)")
    if len(text) > MAX_TEXT:
        raise HTTPException(400, f"Đoạn này quá dài ({len(text)} chữ), giới hạn {MAX_TEXT} chữ; tách thành vài mục sẽ dễ dùng hơn")
    tags = payload.get("tags")
    if tags is None:
        tags = []
    elif isinstance(tags, str):
        tags = [x.strip() for x in re.split(r"[，,;；\s]+", tags) if x.strip()]
    elif not isinstance(tags, (list, tuple)):
        # tags=[数字/布尔/对象] 以前会撞 `'int' object is not iterable` → 500
        raise HTTPException(400, f"Thẻ phải là chữ hoặc một mảng (nhận được {type(tags).__name__})")
    tags = [str(t)[:24] for t in tags][:12]
    d = dbm.db()
    now = dbm.now_ms()
    words = len(re.sub(r"\s", "", text))
    rid = payload.get("id")
    if rid:
        cur = d.one("SELECT id FROM reference WHERE slug=? AND id=?", (s, int(rid)))
        if not cur:
            raise HTTPException(404, "Mục cần sửa không còn nữa")
        d.execute("UPDATE reference SET title=?,author=?,source=?,kind=?,tags_json=?,text=?,"
                  "words=?,updated_at=? WHERE slug=? AND id=?",
                  (title, str(payload.get("author") or ""), str(payload.get("source") or ""),
                   str(payload.get("kind") or "excerpt"), d.jdumps(tags), text, words, now, s, num(rid, name="Mã mục")))
        return {"ok": True, "id": int(rid), "updated": True, "words": words}
    new_id = d.execute(
        "INSERT INTO reference(slug,title,author,source,kind,tags_json,text,words,created_at,updated_at)"
        " VALUES(?,?,?,?,?,?,?,?,?,?)",
        (s, title, str(payload.get("author") or ""), str(payload.get("source") or ""),
         str(payload.get("kind") or "excerpt"), d.jdumps(tags), text, words, now, now))
    return {"ok": True, "id": new_id, "updated": False, "words": words}


@router.delete("/refs/item")
async def del_ref(request: Request, slug: str = "", id: int = 0):
    current_user(request)
    s = _slug(slug)
    if not id:
        raise HTTPException(400, "Xóa mục nào (id không được trống)")
    # 先把磁盘上那份记下来：删了库里的行就再也找不到文件名了
    r = dbm.db().one("SELECT file FROM reference WHERE slug=? AND id=?", (s, id))
    n = dbm.db().rowcount("DELETE FROM reference WHERE slug=? AND id=?", (s, id))
    if not n:
        raise HTTPException(404, "Mục này không còn nữa")
    gone = ""
    fn = ""
    try:
        fn = (r or {}).get("file") or ""
    except Exception:
        fn = ""
    if fn:
        # 只删我们自己目录里的、且文件名是我们生成的（不带路径分隔符）—— 别让 file 字段指到别处去
        f = _refs_dir(s) / Path(fn).name
        if f.is_file():
            try:
                f.unlink()
                gone = f.name
            except OSError:
                gone = ""       # 删不掉（权限/占用）也别把这条操作判成失败：库里已经删干净了
    return {"ok": True, "deleted": n, "fileRemoved": gone}


@router.post("/refs/upload")
async def upload_refs(request: Request, slug: str = Form(""), title: str = Form(""), tags: str = Form(""),
                      note: str = Form(""), kind: str = Form(""),
                      files: list[UploadFile] = File(default=[])):
    """**要的那条**：把图片 / 文件直接丢进参考书架（一次最多 6 个）。

    - 每张图 = 一条参考：说明文字（`note`，可不写）就是它的正文 —— 以后写作时进提示词的就是这段话；
    - `title` 给了就统一用它（多张时自动加 `1/2/3`），没给就用原文件名；
    - 存到 `<书>/.novel/refs/` 里，跟着这本书走；库里只记文件名与类型。
    """
    current_user(request)
    s = _slug(slug)
    if not files:
        raise HTTPException(400, "Không nhận được file (chọn một ảnh hoặc một file rồi tải lên)")
    if len(files) > 6:
        raise HTTPException(400, f"Mỗi lần tối đa 6 file (nhận được {len(files)}); chia đợt tải sẽ dễ quản lý hơn")
    tag_list = [x.strip() for x in re.split(r"[，,;；\\s]+", tags or "") if x.strip()][:12]
    note_txt = args.s(note, name="Mô tả").strip()
    if len(note_txt) > MAX_TEXT:
        raise HTTPException(400, f"Mô tả quá dài ({len(note_txt)} chữ), giới hạn {MAX_TEXT} chữ")
    if kind and kind not in ("image", "file"):
        raise HTTPException(400, "Loại phải là image hoặc file")
    d = dbm.db()
    out = []
    multi = len(files) > 1
    for i, up in enumerate(files, 1):
        data = await up.read()
        if not data:
            raise HTTPException(400, f"File thứ {i} trống")
        ext = Path(up.filename or "").suffix.lower()
        ctype = (up.content_type or "").split(";")[0].strip().lower()
        is_img = ext in IMAGE_CT or ctype.startswith("image/")
        if is_img and len(data) > MAX_IMG:
            raise HTTPException(413, f"Ảnh quá lớn ({len(data) // 1024 // 1024}MB), mỗi ảnh tối đa {MAX_IMG // 1024 // 1024}MB")
        if not is_img and len(data) > MAX_FILE:
            raise HTTPException(413, f"File quá lớn ({len(data) // 1024 // 1024}MB), mỗi file tối đa {MAX_FILE // 1024 // 1024}MB")
        if is_img:
            if ext not in IMAGE_CT:
                # 手机相册导出来的有时候没有扩展名（或写着 .jpg 其实是 png）—— 按文件头认
                head = data[:12]
                if head[:4] == b"\x89PNG":
                    ext = ".png"
                elif head[:4] == b"RIFF" and head[8:12] == b"WEBP":
                    ext = ".webp"
                elif head[:3] == b"GIF":
                    ext = ".gif"
                elif head[4:12] in (b"ftypavif", b"ftypavis"):
                    ext = ".avif"
                else:
                    ext = ".jpg"
            mime = IMAGE_CT.get(ext, "image/jpeg")
            rk = "image"
        else:
            if ext not in DOC_EXT:
                raise HTTPException(400, f"Không nhận ra file này ({ext or 'không có phần mở rộng'}); "
                                         f"loại văn bản chỉ có thể là {'/'.join(sorted(DOC_EXT))}, loại ảnh png/jpg/webp/gif/avif")
            mime = DOC_EXT[ext]
            rk = "file"
        if kind:
            rk = kind
        name = uuid.uuid4().hex + ext
        _refs_dir(s).joinpath(name).write_bytes(data)
        base = title.strip() or (up.filename or "Tham khảo").strip() or "Tham khảo"
        base = re.sub(r"\.[A-Za-z0-9]{1,6}$", "", base)          # 标题里不留扩展名
        t = f"{base} {i}/{len(files)}" if multi else base
        text = note_txt
        if not text and rk == "image":
            # 用户没写说明就先留一句占位 —— 空正文会让"搜得到"这件事失效；
            # 并**明确**告诉用户"图本身模型看不到，看到的是你写的字"，不装。
            text = f"({up.filename or 'ảnh này'}: chưa viết mô tả. Ý mà bức ảnh muốn diễn đạt hãy viết ở đây, khi viết chính văn mới được mang theo.)"
        now = dbm.now_ms()
        rid = d.execute(
            "INSERT INTO reference(slug,title,author,source,kind,tags_json,text,words,file,mime,"
            "created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (s, t, "", "", rk, d.jdumps(tag_list), text, len(re.sub(r"\s", "", text)),
             name, mime, now, now))
        out.append({"id": rid, "title": t, "kind": rk, "file": name, "mime": mime,
                    "bytes": len(data), "name": up.filename or name})
    return {"ok": True, "count": len(out), "items": out}


@router.get("/refs/file")
async def refs_file(request: Request, slug: str, id: int):
    """把存进来的那张图 / 那个文件读出来（前端用 `API.media()` 拼带口令的地址）。"""
    current_user(request)
    s = _slug(slug)
    r = dbm.db().one("SELECT file,mime FROM reference WHERE slug=? AND id=?", (s, id))
    fn = ""
    mime = ""
    try:
        fn = (r or {}).get("file") or ""
        mime = (r or {}).get("mime") or ""
    except Exception:
        fn = ""
    if not r or not fn:
        raise HTTPException(404, "Mục này không có file (có thể chỉ là đoạn trích văn bản)")
    f = _refs_dir(s) / Path(fn).name                  # 只认我们自己生成的文件名，别让 file 指到别处
    if not f.is_file():
        raise HTTPException(404, "File không còn nữa (có thể đã bị xóa tay trong thư mục sách)")
    return FileResponse(str(f),
                        media_type=mime or IMAGE_CT.get(f.suffix.lower(), "application/octet-stream"),
                        filename=None if mime.startswith("image/") else fn,
                        headers={"Cache-Control": "public, max-age=60"})


@router.get("/refs/snippets")
async def snippets(request: Request, slug: str, ids: str = "", q: str = "", limit: int = 3):
    """给写作链路用：按 id（用户挑的）或按关键词挑几段出来。"""
    current_user(request)
    s = _slug(slug)
    d = dbm.db()
    want = [int(x) for x in re.split(r"[,\s]+", ids or "") if x.strip().isdigit()]
    rows: list[dict] = []
    if want:
        qs = ",".join("?" * len(want))
        rows = d.query(f"SELECT * FROM reference WHERE slug=? AND id IN ({qs})", (s, *want))
    elif q:
        rows = d.query("SELECT * FROM reference WHERE slug=? AND (title LIKE ? OR text LIKE ?)"
                       " ORDER BY id DESC LIMIT ?", (s, f"%{q}%", f"%{q}%", max(1, min(10, int(limit)))))
    return {"items": [{"id": r["id"], "title": r["title"], "source": r["source"],
                       "text": (r["text"] or "")[:1500],
                       "truncated": len(r["text"] or "") > 1500} for r in rows]}
