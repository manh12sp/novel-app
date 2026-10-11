# -*- coding: utf-8 -*-
"""人物声音档案：让「谁在说话」在**文字上**分得出来。

为什么需要它：AI 写长篇最典型的崩点不是错字，是**所有角色一个腔**——
主角和反派都用同样的句子长度、同样的转折词、同样爱说「不是……而是……」。
现在的 568 条质检规则里，一条都管不到这个（它们只看"这段文字像不像 AI"，
看不出"这句台词像不像**这个人**"）。这个模块补的就是那一半。

三件事：
1. `profile` —— 每个角色的说话方式**结构化**存在 `entity.data_json.voice`：
   腔调 / 句长偏好 / 口头禅 / 常用词 / 忌用词 / 对谁怎么称呼 / 情绪外露 / 代表台词。
2. `analyze` —— 从正文里**按角色抽台词**（带出处：哪一章第几行），和档案比对：
   口头禅一次没出现、说了他不会说的话、句子长度和档案相反 —— 都挑出来。
3. `distinctiveness` —— 角色之间两两比「台词指纹」，谁和谁像一个模子刻的，
   给出相似度分数。这就是"所有角色一个腔"的量化证据，不是感觉。

全部本地计算，不调模型（断网也能跑）。
"""
from __future__ import annotations

import re

from .. import db as dbm
from ..store import chapter_files, read_text

# ── 档案字段（前端照这个渲染表单，后端照这个清洗，只有一份定义）────────────
VOICE_FIELDS: list[dict] = [
    {"key": "tone", "label": "Giọng điệu", "kind": "text",
     "hint": "Một câu nói rõ người này nói chuyện thế nào. VD: lạnh cứng, cộc lốc, thích dùng văn viết, mở miệng là giọng giang hồ"},
    {"key": "sentence", "label": "Độ dài câu ưa dùng", "kind": "choice",
     "options": ["Ngắn gọn", "Vừa phải", "Dài dòng", "Xen kẽ dài ngắn"],
     "hint": "Người này nói câu ngắn như chém, hay câu dài vòng vo. Người viết sẽ viết theo điều này."},
    {"key": "catchphrases", "label": "Câu cửa miệng", "kind": "lines",
     "hint": "Câu người này hay treo trên miệng, mỗi dòng một câu. Số lần xuất hiện trong chính văn sẽ được đối chiếu."},
    {"key": "lexicon", "label": "Từ hay dùng", "kind": "lines",
     "hint": "Từ người này thích dùng (xưng hô, chửi thề, tiếng nghề), mỗi dòng một từ."},
    {"key": "banned", "label": "Từ kiêng dùng", "kind": "lines",
     "hint": "Câu người này sẽ không bao giờ nói ra, mỗi dòng một câu. Nói ra tức là viết lẫn giọng."},
    {"key": "addresses", "label": "Cách gọi người khác", "kind": "pairs",
     "hint": "Mỗi dòng một mục: đối với ai=gọi thế nào. VD: Thẩm Nham=anh Nham"},
    {"key": "emotion", "label": "Bộc lộ cảm xúc", "kind": "scale",
     "hint": "0 đến 10. 0 = trời sập cũng chỉ nói「ừ」; 10 = cái gì cũng viết lên mặt."},
    {"key": "samples", "label": "Lời thoại tiêu biểu", "kind": "lines",
     "hint": "Hai ba câu dễ nhận diện nhất, mỗi dòng một câu. Đây là cái neo để viết theo người này."},
    {"key": "note", "label": "Ghi chú", "kind": "text", "hint": "Còn thói quen nói chuyện nào khác thì ghi ở đây."},
]
FIELD_KEYS = [f["key"] for f in VOICE_FIELDS]
_LINES = ("catchphrases", "lexicon", "banned", "samples")
_SCALE = ("emotion",)

# 引号里的就是台词。中英文引号都认（用户稿子里两种都出现过）。
_QUOTE = re.compile(r"[“\"「『]([^”\"」』\n]{1,300})[”\"」』]")
# 「……说/道/问/答」这种标签紧跟在他名字后面，最能说明是谁在说
_TAG = re.compile(r"^[\s，,。！？!?、]*(?:还|又|才|便|就|则|接着|然后|忽然|突然|轻轻|冷冷|低声|沉声|笑道|笑着说)*\s*"
                  r"(?:说|道|问|答|喊|叫|应|笑道|冷笑|低语|开口|反问|嘟囔|插嘴|接话)")
# 停用词：比"常用词"时要扔掉的高频虚词
_STOP = set("的了是我你他她它们这那和与就都也还不没在有一个不很又才把被让给对能会要说着"
            "什么怎么如果因为所以但是然后可是而且以及一个我们你们他们自己时候现在知道觉得"
            "样什么这些那些这个那个哪里为什么没有什么怎么那么这么起来出来过来上去下去")


# ── 档案读写 ────────────────────────────────────────────────────────────────
def clean(data: dict) -> dict:
    """把前端交来的东西洗干净再存 —— 空白项不要留，行文本按行切。"""
    out: dict = {}
    for f in VOICE_FIELDS:
        v = (data or {}).get(f["key"])
        if f["kind"] == "lines":
            if isinstance(v, str):
                v = re.split(r"[\n;；]+", v)
            items = [str(x).strip() for x in (v or []) if str(x).strip()]
            if items:
                out[f["key"]] = items[:40]
        elif f["kind"] == "pairs":
            if isinstance(v, str):
                v = re.split(r"[\n;；]+", v)
            pairs = {}
            for x in (v or []):
                s = str(x)
                if "=" not in s and "＝" not in s:
                    continue
                k, val = re.split(r"[=＝]", s, maxsplit=1)
                k, val = k.strip(), val.strip()
                if k and val:
                    pairs[k] = val
            if pairs:
                out[f["key"]] = pairs
        elif f["kind"] == "scale":
            try:
                n = int(v)
                out[f["key"]] = max(0, min(10, n))
            except (TypeError, ValueError):
                pass
        elif f["kind"] == "choice":
            s = str(v or "").strip()
            if s in f["options"]:
                out[f["key"]] = s
        else:
            s = str(v or "").strip()
            if s:
                out[f["key"]] = s[:600]
    return out


def get_profile(slug: str, name: str) -> dict:
    """读一个人的声音档案（名字或别名都对得上）。"""
    from .world import find_entity
    row = find_entity(slug, name)
    if not row:
        return {"name": name, "entityId": None, "voice": {}, "exists": False}
    data = dbm.db().jloads(row["data_json"], {}) or {}
    return {"name": row["name"], "entityId": row["id"], "kind": row["kind"],
            "voice": clean(data.get("voice") or {}), "exists": True}


def save_profile(slug: str, name: str, voice: dict, *, kind: str = "") -> dict:
    """存档案。名字不存在就顺手建一个角色实体 —— 用户填了就该有地方落。"""
    from .world import find_entity, upsert_entity
    cleaned = clean(voice)
    row = find_entity(slug, name)
    if row:
        eid = row["id"]
    else:
        eid = upsert_entity(slug, kind or "character", name, {}, [], source_path="voice")
    d = dbm.db()
    cur = d.one("SELECT data_json FROM entity WHERE id=?", (eid,))
    data = d.jloads(cur["data_json"], {}) if cur else {}
    if cleaned:
        data["voice"] = cleaned
    else:
        data.pop("voice", None)
    d.execute("UPDATE entity SET data_json=?, updated_at=? WHERE id=?", (d.jdumps(data), dbm.now_ms(), eid))
    return {"entityId": eid, "name": name, "voice": cleaned}


def all_profiles(slug: str) -> list[dict]:
    from .world import entity_list
    out = []
    for e in entity_list(slug):
        v = clean((e.get("data") or {}).get("voice") or {})
        if v or e["kind"] == "character":
            out.append({"entityId": e["id"], "name": e["name"], "kind": e["kind"],
                        "aliases": e.get("aliases") or [], "voice": v})
    return out


# ── 从正文里按角色抽台词 ────────────────────────────────────────────────────
def _names(slug: str) -> list[tuple[str, str]]:
    """[(名字, 实体名)]，按长度倒序 —— 保证"主角"不会被"主"抢走。"""
    from .world import entity_list
    out: list[tuple[str, str]] = []
    for e in entity_list(slug):
        if e["kind"] not in ("character", "char", "角色", "person"):
            continue
        out.append((e["name"], e["name"]))
        for a in (e.get("aliases") or []):
            out.append((a, e["name"]))
    return sorted(set(out), key=lambda x: -len(x[0]))


def attributed(slug: str, *, limit_chars: int = 4_000_000) -> list[dict]:
    """把全书台词按角色归好：{speaker, line, path, line_no}。

    两种认人的办法，够用而且不猜：
    1. 台词**后面**紧跟「（他名字）+ 说/道/问/答」→ 最可靠；
    2. 台词**前面** 30 字内最近的那个角色名 → 常见写法（"主角皱眉：「……」"）。
    两边都没有就不归人（宁可不认，也不要安到错的人头上）。
    """
    names = _names(slug)
    if not names:
        return []
    out: list[dict] = []
    used = 0
    for ch in chapter_files(slug):
        try:
            text = read_text(slug, ch["path"])
        except Exception:
            continue
        if not text:
            continue
        used += len(text)
        if used > limit_chars:
            break
        # 逐行扫：台词的出处要精确到行，这是"能定位到行"的另一半
        base = 0
        for ln, raw in enumerate(text.split("\n"), 1):
            for m in _QUOTE.finditer(raw):
                line = m.group(1).strip()
                if len(line) < 2:
                    continue
                who = ""
                tail = raw[m.end():m.end() + 24]
                if _TAG.match(tail):
                    head = raw[:m.start()]
                    for nm, ent in names:
                        if head.endswith(nm):
                            who = ent
                            break
                    if not who:                      # 「说」前面隔了动作："主角愣了一下，说"
                        seg = re.split(r"[，,。！？!?；;]", head)[-1]
                        for nm, ent in names:
                            if nm in head[-24:] or nm in seg:
                                who = ent
                                break
                if not who:
                    head = raw[:m.start()]
                    cut = max(0, len(head) - 30)
                    window = head[cut:]
                    best = -1
                    for nm, ent in names:
                        p = window.rfind(nm)
                        if p > best:
                            best = p
                            who = ent
                if who:
                    out.append({"speaker": who, "line": line, "path": ch["path"],
                                "lineNo": ln, "at": base + m.start()})
            base += len(raw) + 1
    return out


def _sentences(text: str) -> list[str]:
    return [s for s in re.split(r"[。！？!?；;\n]+", text) if s.strip()]


def _bigram_counts(lines: list[str]) -> dict:
    """双字词频次（去虚词、去口头填空）。指纹和"候选口头禅"都靠它。"""
    from collections import Counter
    c: Counter = Counter()
    for s in lines:
        s = re.sub(r"[^\u4e00-\u9fff]", "", s)
        for i in range(len(s) - 1):
            bg = s[i:i + 2]
            if bg[0] in _STOP and bg[1] in _STOP:
                continue
            if bg in ("什么", "怎么", "他一", "一个"):
                continue
            c[bg] += 1
    return dict(c)


def _bigrams(lines: list[str], top: int = 24) -> list[str]:
    c = _bigram_counts(lines)
    return [w for w, _ in sorted(c.items(), key=lambda kv: -kv[1])[:top] if c[w] >= 2]


def fingerprint(lines: list[str]) -> dict:
    """一个人的「台词指纹」：能算的都在这里，前端画不画都能看懂。"""
    n = len(lines)
    if not n:
        return {"lines": 0}
    chars = [len(x) for x in lines]
    joined = "\n".join(lines)
    def ratio(pat):
        return round(sum(1 for x in lines if re.search(pat, x)) / n, 3)
    sents = _sentences(joined)
    return {
        "lines": n,
        "chars": sum(chars),
        "avgLen": round(sum(chars) / n, 1),
        "avgSentLen": round(sum(len(s) for s in sents) / max(1, len(sents)), 1),
        "askRatio": ratio(r"[？?]"),
        "exclaimRatio": ratio(r"[！!]"),
        "ellipsisRatio": ratio(r"…|\.\.\."),
        "dashRatio": ratio(r"——"),
        "topWords": _bigrams(lines),
    }


def _similarity(a: dict, b: dict) -> float:
    """两个角色像不像。字面特征 + 用词集合，各占一半。"""
    if not a.get("lines") or not b.get("lines"):
        return 0.0
    def near(x, y, scale):
        return max(0.0, 1.0 - abs(x - y) / float(scale))
    feat = (
        near(a["avgLen"], b["avgLen"], 18) +
        near(a["askRatio"], b["askRatio"], 0.5) +
        near(a["exclaimRatio"], b["exclaimRatio"], 0.5) +
        near(a["ellipsisRatio"], b["ellipsisRatio"], 0.4)
    ) / 4.0
    # 用「重叠系数」而不是 Jaccard：Jaccard 会因为一个人词多、一个人词少而低估相似度，
    # 而我们要回答的是"他们说的是不是同一套话" —— 分母取两人中小的那个更贴近这个问题。
    wa, wb = set(a.get("topWords") or []), set(b.get("topWords") or [])
    ov = len(wa & wb) / float(min(len(wa), len(wb))) if (wa and wb) else 0.0
    return round(0.5 * feat + 0.5 * ov, 3)


# ── 一个角色的体检 ──────────────────────────────────────────────────────────
def check_one(name: str, prof: dict, fp: dict, lines: list[dict]) -> list[dict]:
    """他这一个人有什么问题。每条都要指得出证据（哪一句、哪儿不对）。"""
    issues: list[dict] = []
    voice = prof.get("voice") or {}
    if not voice:
        issues.append({"level": "info", "key": "no_profile",
                       "text": "Chưa có hồ sơ giọng nói: người viết chỉ có thể dựa vào lối viết chung, dễ trùng giọng với người khác",
                       "advice": "Điền「Giọng điệu + Độ dài câu ưa dùng + Câu cửa miệng」, ba mục là đủ dùng"})
        return issues
    if not lines:
        issues.append({"level": "info", "key": "no_lines",
                       "text": "Không tìm thấy lời thoại của người này trong chính văn (hoặc lời thoại không ghi ai nói)",
                       "advice": "Sau lời thoại thêm một câu「XX nói」, vừa rõ vừa dễ đọc"})
        return issues
    cps = voice.get("catchphrases") or []
    if cps:
        hit = [c for c in cps if any(c in l["line"] for l in lines)]
        if not hit:
            issues.append({"level": "warn", "key": "catch_missing",
                           "text": "Câu cửa miệng「%s」trong hồ sơ không xuất hiện lần nào trong %d câu thoại" % (cps[0], len(lines)),
                           "advice": "Hoặc cho người này nói một lần, hoặc thừa nhận câu cửa miệng này là bạn tự nghĩ, sửa hồ sơ"})
    elif len(lines) >= 8:
        issues.append({"level": "info", "key": "catch_empty",
                       "text": "Có %d câu thoại, nhưng hồ sơ chưa ghi câu cửa miệng nào" % len(lines),
                       "advice": "Chọn một từ trong「Từ hay xuất hiện」bên dưới điền vào, người này lập tức có bản sắc"})
    for w in (voice.get("banned") or []):
        for l in lines:
            if w in l["line"]:
                issues.append({"level": "warn", "key": "banned_used",
                               "text": "Người này đã nói từ kiêng dùng「%s」: %s (%s dòng %d)" % (w, l["line"][:40], l["path"], l["lineNo"]),
                               "advice": "Đổi sang cách nói của người này, hoặc bỏ mục này khỏi hồ sơ"})
                break
    want = voice.get("sentence")
    if want and fp.get("lines", 0) >= 6:
        avg = fp["avgLen"]
        real = "Ngắn gọn" if avg <= 9 else ("Dài dòng" if avg >= 26 else "Vừa phải")
        if want in ("Ngắn gọn", "Dài dòng") and real != want:
            issues.append({"level": "warn", "key": "sentence_mismatch",
                           "text": "Hồ sơ ghi「%s」, thực tế trung bình mỗi câu %.1f chữ, đọc lên là「%s」" % (want, avg, real),
                           "advice": "Sửa lời thoại theo hồ sơ, hoặc sửa hồ sơ theo thực tế"})
    for other, call in (voice.get("addresses") or {}).items():
        mine = [l for l in lines if l["line"]]
        if mine and not any(call in l["line"] for l in lines):
            issues.append({"level": "info", "key": "address_unused",
                           "text": "Hồ sơ ghi người này gọi「%s」là「%s」, nhưng trong lời thoại chưa từng gọi như vậy" % (other, call),
                           "advice": "Cho người này gọi một lần (xưng hô là gợi ý quan hệ tiết kiệm nhất), hoặc xóa mục này"})
            break
    return issues


def report(slug: str) -> dict:
    """整本书的声音体检：档案覆盖率 + 台词指纹差异度 + 逐人问题。"""
    lines = attributed(slug)
    by: dict[str, list[dict]] = {}
    for l in lines:
        by.setdefault(l["speaker"], []).append(l)
    profiles = all_profiles(slug)
    chars = [p for p in profiles if p["kind"] in ("character", "char", "角色", "person")]
    if not chars:                       # 没有角色实体，但正文里有台词提到的人
        seen = sorted(by)
        chars = [{"entityId": None, "name": n, "kind": "character", "voice": {}} for n in seen]
    people = []
    for p in chars:
        lines_of = by.get(p["name"], [])
        fp = fingerprint([l["line"] for l in lines_of])
        people.append({
            "name": p["name"], "entityId": p.get("entityId"),
            "hasProfile": bool(p.get("voice")),
            "voice": p.get("voice") or {},
            "fingerprint": fp,
            "samples": [{"line": l["line"], "path": l["path"], "lineNo": l["lineNo"]}
                        for l in lines_of[:6]],
            "issues": check_one(p["name"], p, fp, lines_of),
        })
    people.sort(key=lambda x: (-(x["fingerprint"].get("lines") or 0), x["name"]))
    # 两两比指纹：谁和谁像一个模子刻的
    pairs = []
    for i in range(len(people)):
        for j in range(i + 1, len(people)):
            a, b = people[i], people[j]
            if (a["fingerprint"].get("lines") or 0) < 4 or (b["fingerprint"].get("lines") or 0) < 4:
                continue
            sim = _similarity(a["fingerprint"], b["fingerprint"])
            if sim >= 0.5:
                pairs.append({"a": a["name"], "b": b["name"], "similarity": sim,
                              "shared": sorted(set(a["fingerprint"].get("topWords") or []) &
                                               set(b["fingerprint"].get("topWords") or []))[:8],
                              "why": "Độ dài câu trung bình %.1f / %.1f chữ, trùng %d từ" % (
                                  a["fingerprint"].get("avgLen", 0), b["fingerprint"].get("avgLen", 0),
                                  len(set(a["fingerprint"].get("topWords") or []) &
                                      set(b["fingerprint"].get("topWords") or [])))})
    pairs.sort(key=lambda x: -x["similarity"])
    # 评分：档案覆盖率 40 + 差异度 40 + 逐人问题 20（和质检同一套阈值口径）
    with_prof = sum(1 for p in people if p["hasProfile"])
    with_lines = sum(1 for p in people if (p["fingerprint"].get("lines") or 0) >= 4)
    cover = (with_prof / len(people)) if people else 0.0
    sampled = (with_lines / len(people)) if people else 0.0
    worst_sim = pairs[0]["similarity"] if pairs else 0.0
    distinct = max(0.0, 1.0 - max(0.0, worst_sim - 0.35) / 0.65)
    bad = sum(len(p["issues"]) for p in people)
    penalty = min(1.0, bad / max(4.0, len(people) * 2.0))
    score = int(round(100 * (0.4 * cover + 0.25 * sampled + 0.25 * distinct + 0.10 * (1 - penalty))))
    from .lint import GRADE_BANDS, grade_of
    return {
        "slug": slug, "score": score, "grade": grade_of(score),
        "bands": [{"min": lo, "name": nm} for lo, nm in GRADE_BANDS],
        "people": people, "pairs": pairs[:8],
        "stats": {"characters": len(people), "withProfile": with_prof,
                  "withSamples": with_lines, "dialogueLines": len(lines),
                  "worstSimilarity": worst_sim, "issues": bad},
        "advice": _advice(people, pairs),
    }


def _advice(people: list[dict], pairs: list[dict]) -> list[str]:
    out = []
    if not people:
        return ["Cuốn sách này chưa có thực thể nhân vật, cũng chưa có lời thoại xác định được người nói. Hãy tạo vài nhân vật trong bảng Thế giới trước."]
    no_prof = [p["name"] for p in people if not p["hasProfile"]]
    if no_prof:
        out.append("Chưa có hồ sơ giọng nói: " + "、".join(no_prof[:6]) + "(người viết chỉ có thể dựa vào lối viết chung)")
    if pairs:
        p = pairs[0]
        out.append("「%s」và「%s」như đúc từ một khuôn (độ giống %.0f%%): %s" % (
            p["a"], p["b"], p["similarity"] * 100, p["why"]))
    thin = [p["name"] for p in people if 0 < (p["fingerprint"].get("lines") or 0) < 4]
    if thin:
        out.append("Lời thoại quá ít, dấu vân giọng không đáng tin: " + "、".join(thin[:6]))
    if not out:
        out.append("Cách nói chuyện của mỗi nhân vật đều phân biệt được, phần giọng nói không phát hiện vấn đề.")
    return out


def sample_words(slug: str, name: str, limit: int = 12) -> list[dict]:
    """给他挑口头禅用：从他的台词里数出高频词（本地统计，不调模型）。"""
    lines = [l["line"] for l in attributed(slug) if l["speaker"] == name]
    if not lines:
        return []
    from collections import Counter
    c: Counter = Counter()
    for s in _sentences("\n".join(lines)):
        s = s.strip()
        if 2 <= len(s) <= 12:
            c[s] += 1
    # 双字词按**真实出现次数**计数（早先写成 +1，结果重复出现的词也只算一次，
    # 一个候选都挑不出来 —— 实测抓到的）
    for w, n in _bigram_counts(lines).items():
        c[w] += n
    return [{"word": w, "count": n} for w, n in c.most_common(limit) if n >= 2]


def voice_brief(slug: str, names: list[str], *, limit: int = 6) -> str:
    """给写作链路用的「你们这么说话」小抄。出场角色每人一段，没有档案的不占地方。"""
    if not names:
        return ""
    blocks = []
    for nm in names[:limit]:
        p = get_profile(slug, nm)
        v = p.get("voice") or {}
        if not v:
            continue
        bits = []
        if v.get("tone"):
            bits.append("Giọng điệu: " + v["tone"])
        if v.get("sentence"):
            bits.append("Độ dài câu: " + v["sentence"])
        if v.get("catchphrases"):
            bits.append("Câu cửa miệng: " + "／".join(v["catchphrases"][:4]))
        if v.get("lexicon"):
            bits.append("Từ hay dùng: " + "／".join(v["lexicon"][:6]))
        if v.get("banned"):
            bits.append("Kiêng dùng: " + "／".join(v["banned"][:4]))
        if v.get("addresses"):
            bits.append("Xưng hô: " + "，".join(f"{k} gọi là「{x}」" for k, x in list(v["addresses"].items())[:5]))
        if v.get("emotion") is not None:
            bits.append("Bộc lộ cảm xúc: %s/10" % v["emotion"])
        if v.get("samples"):
            bits.append("Lời thoại tiêu biểu: " + "／".join("「%s」" % s for s in v["samples"][:2]))
        if v.get("note"):
            bits.append("Ghi chú: " + v["note"])
        if bits:
            blocks.append("· " + p["name"] + "：" + "；".join(bits))
    if not blocks:
        return ""
    return ("【Cách nói chuyện của các nhân vật xuất hiện (lời thoại phải phân biệt được theo đây, đừng để ai cũng một giọng)】\n" + "\n".join(blocks))
