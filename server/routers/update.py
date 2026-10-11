# -*- coding: utf-8 -*-
"""在网页里自己更新（后端 + 前端一起）。

为什么需要：别人 clone 下来部署完，想拿新版本不用再登服务器敲命令 ——
网页里点一下就行。前端本来就跟后端同一个端口发出去的，所以**重启一次两边都生效**。

怎么做的（本机就是一份 git 副本，所以"更新"= 三件事）：
  ① 看远端有没有新提交（`git ls-remote`，带超时；连不上 GitHub 就明说，不装作最新）
  ② 有新的 → `git pull --ff-only`（**只快进**，绝不产生合并；有本地改动就原话返回）
  ③ 重启服务让新代码生效（`systemctl --user restart <服务名>`，
     服务名可以用环境变量 NOVELAPP_SERVICE 改；重启是"先回话再重启"，不然界面看到的是出错）

安全：
  · 只有**登录后**能用（current_user）
  · 更新前把当前提交号返回出来（出事了知道自己原来在哪一版）
  · pull 失败不吞错误，git 的原话直接给用户看
  · 只认快进合并：别人本地改过代码时不会把改动冲掉
"""
from __future__ import annotations

import os
import shutil
import subprocess

from fastapi import APIRouter, Body, HTTPException, Request

from ..config import CFG
from ..paths import Paths
from ..security import current_user

router = APIRouter()

GIT = shutil.which("git") or "git"
SERVICE = os.environ.get("NOVELAPP_SERVICE", "novelapp")


def _repo() -> str:
    return str(Paths(CFG).repo)


def _proxy() -> str:
    """有没有可用的代理。国内直连 GitHub 常常超时，所以留一条自动走代理的路：
      ① 环境变量 NOVELAPP_PROXY / https_proxy / HTTPS_PROXY 指定
      ② 没有的话，看看本机 本地代理 有没有在听（常见的本地代理端口）
    都没有就返回空串 —— 直连能不能通就听天由命，连不上会**明说**，不会假装最新。"""
    for k in ("NOVELAPP_PROXY", "https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"):
        v = (os.environ.get(k) or "").strip()
        if v:
            return v
    try:
        import socket
        sk = socket.socket()
        sk.settimeout(0.25)
        ok = sk.connect_ex(("127.0.0.1", PORT)) == 0
        sk.close()
        if ok:
            return "http://proxy-cuc-bo"
    except Exception:
        pass
    return ""


def _git(args: list, timeout: int = 30, proxy: str = "") -> tuple:
    """跑一条 git 命令 → (返回码, 输出)。超时/没装 git 都算失败，不抛。"""
    env = None
    if proxy:
        env = dict(os.environ)
        env["http_proxy"] = proxy
        env["https_proxy"] = proxy
    try:
        p = subprocess.run([GIT, "-C", _repo()] + args, capture_output=True,
                           text=True, timeout=timeout, env=env)
        out = ((p.stdout or "") + (p.stderr or "")).strip()
        return p.returncode, out
    except subprocess.TimeoutExpired:
        return 124, "Quá thời gian (không kết nối được GitHub?)"
    except FileNotFoundError:
        return 127, "Máy này chưa cài git"
    except Exception as e:
        return 1, str(e)[:200]


def _git_net(args: list, timeout: int = 30) -> tuple:
    """要联网的 git 命令：直连不行就自动换代理再试一次。"""
    code, out = _git(args, timeout=timeout)
    if code == 0:
        return code, out
    px = _proxy()
    if px:
        code2, out2 = _git(args, timeout=timeout, proxy=px)
        if code2 == 0:
            return code2, out2
        return code2, out2 + " (qua proxy %s cũng không thông)" % px
    return code, out


def _local() -> str:
    return _git(["rev-parse", "--short", "HEAD"])[1]


def _branch() -> str:
    code, out = _git(["rev-parse", "--abbrev-ref", "HEAD"])
    return out if code == 0 and out else "main"


@router.get("/update/check")
async def update_check(request: Request):
    """看有没有新版本。**不联网也能用**：连不上就明说，不会假装是最新。"""
    current_user(request)
    if not os.path.isdir(os.path.join(_repo(), ".git")):
        return {"ok": False, "canUpdate": False, "reason": "Đây không phải bản sao git (có thể là gói nén tải về), chỉ có thể cập nhật thủ công",
                "local": "", "remote": "", "hasUpdate": False}
    branch = _branch()
    local = _local()
    # **fetch 之后再比落后数**：直接比 ls-remote 的哈希会在"本地领先远端"时误报有新版本
    # （自己刚提交还没推的时候，就属这种情况）。
    # **超时 10 秒**：以前给 60 秒，用户点一下要干等一分钟（还一句提示都没有，
    # 看着就像卡死）。宁可明说"查不到"，也不要让人等。
    code, out = _git_net(["fetch", "--quiet", "origin", branch], timeout=10)
    if code != 0:
        return {"ok": False, "canUpdate": True, "hasUpdate": False, "local": local, "remote": "",
                "branch": branch,
                "reason": "Không kiểm tra được (mạng không kết nối được GitHub, quá 10 giây). Không ảnh hưởng việc dùng, cập nhật thủ công trước cũng được."}
    code2, out2 = _git(["rev-list", "--count", "HEAD..origin/" + branch], timeout=20)
    behind = out2.strip() if code2 == 0 and out2.strip().isdigit() else "0"
    code3, out3 = _git(["rev-parse", "--short", "origin/" + branch], timeout=20)
    remote = out3.strip() if code3 == 0 else ""
    has = behind.isdigit() and int(behind) > 0
    return {"ok": True, "canUpdate": True, "hasUpdate": has, "local": local,
            "remote": remote, "branch": branch, "behind": behind, "service": SERVICE}


@router.post("/update/apply")
async def update_apply(request: Request):
    """拉最新代码，然后重启服务（前端跟着后端一起生效）。

    重启放在**回话之后**：先把结果返回给界面，再 detached 地去重启，
    否则界面等的是一个必然断掉的连接，会显示"出错"吓人。
    """
    current_user(request)
    repo = _repo()
    if not os.path.isdir(os.path.join(repo, ".git")):
        raise HTTPException(400, "Đây không phải bản sao git, không tự cập nhật được —— hãy thay bản mới thủ công")
    before = _local()
    # 本地有改动就先别动，免得把人家改的东西冲了
    code, dirty = _git(["status", "--porcelain"])
    if code == 0 and dirty:
        raise HTTPException(409, "Máy này đã sửa mã nguồn (git status không sạch), "
                                 "tự cập nhật sợ ghi đè mất thay đổi của bạn. Hãy tự git stash hoặc commit trước rồi mới bấm cập nhật.")
    code, out = _git_net(["pull", "--ff-only", "origin", _branch()], timeout=120)
    if code != 0:
        raise HTTPException(400, "Kéo về thất bại: " + out[:300])
    after = _local()
    changed = after != before
    if changed:
        # 先回话，再重启：setsid 起一个 2 秒后执行的重启，脱离本进程
        cmd = ("sleep 2; systemctl --user restart %s || sudo -n systemctl restart %s || true"
               % (SERVICE, SERVICE))
        try:
            subprocess.Popen(["setsid", "bash", "-lc", cmd],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
        except Exception:
            pass
    return {"ok": True, "from": before, "to": after, "changed": changed,
            "restarting": changed, "service": SERVICE,
            "note": ("Đã kéo bản mới, 2 giây nữa tự khởi động lại; đợi mười mấy giây rồi làm mới trang là được"
                     if changed else "Đã là bản mới nhất, không cần làm gì")}
