/* ============================================================
   outline.js — 「大纲」面板（）

   为什么会有这个文件
   ------------------
   
     「我是想把**故事线**这个技能**在不改名字的情况下，把它的用处改成大纲**，
       它是用来放大纲的，所以点击这个故事线之后，它里面的前端和后端都要重做，
       就相当于删除了，把这个功能换成大纲」
     「剧情线可以继续叫这个名字，但它的作用需要改成『大纲』的作用」——
       **防忘 / 防 OOC / 防跑偏**，AI 和用户都能改，**用户改的以用户为准**。

   于是「大纲」这一块现在长这样：**一份实现（就是这个文件）· 两个入口**
     · 工具宫格 →「故事线」（名字一个字没改，点开就是大纲）
     · 「剧情」工具 →「剧情线」页签（名字也留着，内容换成同一块大纲）
   为什么抽成一份：以前每个入口各写一套，**两套并存**正是"UI 不统一"的来源；
   而且两处各改各的，早晚会有一处忘了改。

   数据全都走真接口（一个字节都不假造）：
     · GET    /api/plot/overview?slug=   → threads（每条带 origin：谁定的）
     · POST   /api/plot/thread           → 加一条 / 改一条（走过的就是"你定的"）
     · DELETE /api/plot/thread?slug&id   → 删一条
   「AI 不许覆盖用户改过的条目」那条规矩在后端 + 工具层（tools/check_outline.py 有判据），
   这里做的是：**把"谁定的"摆在明面上**，让用户一眼看见自己的改动生效了。
   ============================================================ */
(function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const qs = (o) => Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const get = (p, q) => window.API.nb(p + (q ? '?' + qs(q) : ''));
  const post = (p, b) => window.API.nb(p, { method: 'POST', body: b || {} });
  const del = (p, q) => window.API.nb(p + (q ? '?' + qs(q) : ''), { method: 'DELETE' });
  const ico = (n) => '<span class="tr-ico">' + window.iconHtml(n) + '</span>';
  const toast = (m) => { try { App.toast(m); } catch (e) {} };
  const hap = () => { try { App.haptic(6); } catch (e) {} };
  const uid = (n) => 'ol-' + String(n == null ? '' : n);

  const KIND = { main: 'Tuyến chính', sub: 'Tuyến phụ', romance: 'Tuyến tình cảm', mystery: 'Tuyến hồi hộp' };
  const ST = { open: 'Đang chạy', done: 'Đã khép', paused: 'Tạm gác' };
  /* 「谁定的」——后端每条 thread 都带 origin，缺省当用户定的（老数据都是用户建的） */
  const mineOf = (t) => ((t && t.origin) || 'user') === 'user';

  /* 反证钩子（只有判据用）：`window.__NB_STORY_FORCE`
       'nobadge' → 假装没有"谁定的"这个徽标（用户就看不见自己的改动生效了）
       'nostat'  → 假装没有统计行
     产品逻辑本身不依赖它，勾上它只是把界面退回到"没做这一版"的样子。 */
  const F = () => window.__NB_STORY_FORCE || '';

  const S = { slug: null, ov: null, err: null, filter: 'all', open: null, host: null, wired: false };

  /* ── 每本书各自记着"我筛到哪一档"（切书回来还是那一档；不串书） ── */
  const fkey = (slug) => 'outline.filter.' + (slug || '');

  function stateEl(o) {
    if (window.UI && UI.state) return UI.state(o);
    const d = document.createElement('div');
    d.className = 't-empty';
    d.textContent = o.title || '';
    return d;
  }

  function counts(ths) {
    const mine = ths.filter(mineOf).length;
    return { all: ths.length, mine: mine, ai: ths.length - mine };
  }

  function summaryLine(t) {
    return [KIND[t.kind] || t.kind || 'Tuyến chính', ST[t.status] || t.status || 'Đang chạy']
      .filter(Boolean).join(' · ');
  }

  function rowHtml(t) {
    const mine = mineOf(t);
    return '<div class="t-row ol-row" data-th="' + esc(t.id) + '">' + ico('bookmark') +
      '<div class="tr-main">' +
        '<div class="tr-title">' + esc(t.name || '(Chưa đặt tên)') +
          (F() === 'nobadge' ? '' : ' <span class="t-pill ' + (mine ? 'ok' : 'gray') + '">' +
            (mine ? 'Bạn đặt' : 'AI bổ sung') + '</span>') +
        '</div>' +
        '<div class="tr-sub">' + esc(summaryLine(t)) + '</div>' +
        /* 大纲正文**换行显示，不许截断**（用户：「手机上很多字儿都看不到」） */
        (t.summary ? '<div class="ol-sum">' + esc(t.summary) + '</div>' : '') +
      '</div>' +
      '<div class="ol-acts">' +
        '<button class="t-btn sm ol-act" data-oledit="' + esc(t.id) + '" aria-label="Sửa mục dàn ý này">Sửa</button>' +
        '<button class="t-btn sm dim ol-act" data-olrm="' + esc(t.id) + '" aria-label="Xóa mục dàn ý này">Xóa</button>' +
      '</div>' +
      '</div>' +
      /* 点开才看到的"这条线挂在哪"（默认不占地方） */
      '<div class="ol-scenes" data-olout="' + esc(t.id) + '" hidden></div>';
  }

  function render() {
    const host = S.host; if (!host) return;
    if (S.err) {
      const again = document.createElement('button');
      again.className = 'btn sm';
      again.textContent = 'Thử lại';
      again.onclick = () => reload();
      host.innerHTML = '';
      host.appendChild(stateEl({
        kind: 'error', icon: 'refresh',
        title: S.err.title || 'Không đọc được dàn ý', desc: S.err.desc || 'Bấm «Thử lại» để chạy lại.',
        actions: [again],
      }));
      return;
    }
    if (!S.ov) { host.innerHTML = ''; host.appendChild(stateEl({ kind: 'loading', title: 'Đang đọc dàn ý…' })); return; }
    const ths = S.ov.threads || [];
    const c = counts(ths);
    const shown = ths.filter((t) => S.filter === 'all' || (S.filter === 'mine' ? mineOf(t) : !mineOf(t)));
    host.innerHTML =
      '<div class="t-hint">Dàn ý lo ba việc:<b>Không quên</b> (khi viết dài, nhớ hộ AI các thiết lập phía trước), ' +
        '<b>Không lạc hướng</b> (cuốn sách đi về đâu, giọng điệu ra sao),<b>Không méo nhân vật</b> (nhân vật phải như thế nào). ' +
        '<b>Mục bạn đã sửa thì lấy theo bạn, AI không tự ghi đè.</b></div>' +
      (F() === 'nostat' ? '' :
        '<div class="ol-stat">Tổng <b>' + c.all + '</b> mục · bạn đặt <b>' + c.mine +
        '</b> mục · AI bổ sung <b>' + c.ai + '</b> mục</div>') +
      '<div class="t-chips ol-chips">' +
        [['all', 'Tất cả', c.all], ['mine', 'Bạn đặt', c.mine], ['ai', 'AI bổ sung', c.ai]].map(([k, label, n]) =>
          '<button class="t-pill' + (S.filter === k ? ' on' : ' gray') + '" data-olfilter="' + k + '">' +
          label + ' <b>' + n + '</b></button>').join('') +
      '</div>' +
      '<div class="t-bar"><button class="t-btn pri ol-add" data-olnew>Thêm một mục</button></div>' +
      (shown.length
        ? '<div class="t-list ol-list">' + shown.map(rowHtml).join('') + '</div>'
        : '<div class="t-empty">' +
            (S.filter === 'mine' ? 'Bạn chưa đặt mục nào — viết bằng «Thêm một mục» bên dưới đều tính là bạn đặt.'
              : S.filter === 'ai' ? 'Chưa có mục nào do AI bổ sung.'
                : 'Chưa có dàn ý — bấm «Thêm một mục» ở trên, viết rõ cuốn sách đi về đâu, ' +
                  ' ví dụ «Tuyến chính: nhân vật chính bị đuổi khỏi tông môn → một đường đánh trở về sơn môn»') + '</div>');
    wire();
  }

  function wire() {
    const host = S.host; if (!host) return;
    const ths = (S.ov && S.ov.threads) || [];
    const add = host.querySelector('[data-olnew]');
    if (add) add.onclick = async () => { hap(); if (await editOne(null)) reload(); };
    host.querySelectorAll('[data-olfilter]').forEach((b) => {
      b.onclick = () => {
        hap();
        S.filter = b.dataset.olfilter;
        try { localStorage.setItem(fkey(S.slug), S.filter); } catch (e) {}
        render();
      };
    });
    host.querySelectorAll('[data-oledit]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        hap();
        const t = ths.find((x) => String(x.id) === String(b.dataset.oledit));
        if (t && (await editOne(t))) reload();
      };
    });
    host.querySelectorAll('[data-olrm]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        App.confirm('Xóa mục dàn ý này? (chính văn không bị đụng chữ nào)', async () => {
          try { await del('/api/plot/thread', { slug: S.slug, id: b.dataset.olrm }); toast('Đã xóa'); hap(); }
          catch (err) { toast('Không xóa được: ' + err.message); return; }
          reload();
        });
      };
    });
    /* 点一行 = 看这条线挂在哪。**不换页、不弹窗**（手机上多一层就多一次返回） */
    host.querySelectorAll('[data-th]').forEach((r) => {
      r.onclick = () => {
        const out = host.querySelector('[data-olout="' + r.dataset.th + '"]');
        if (!out) return;
        hap();
        const show = out.hidden;
        host.querySelectorAll('[data-olout]').forEach((o) => { o.hidden = true; });
        if (!show) return;
        const t = ths.find((x) => String(x.id) === String(r.dataset.th)) || {};
        const sc = t.scenes || [];
        out.innerHTML = '<div class="t-hint">«' + esc(t.name || '') + '» gắn vào các cảnh này</div>' +
          (sc.length
            ? sc.map((sp) => '<div class="ol-scene">' + ico('layers') +
                '<span>' + esc(sp) + '</span></div>').join('')
            : '<div class="t-empty">Tuyến này chưa gắn cảnh nào (gắn trong thẻ «Cảnh» của công cụ «Cốt truyện»)</div>');
        out.hidden = false;
      };
    });
  }

  /* 加一条 / 改一条 —— 全站同一个表单（App.form），不另拼一套 markup */
  async function editOne(t) {
    const r = await App.form({
      title: t ? 'Sửa mục dàn ý này' : 'Thêm mục dàn ý mới',
      ok: 'Lưu lại',
      fields: [
        { key: 'name', label: 'Tên là gì', value: t ? (t.name || '') : '',
          placeholder: 'VD: Tuyến báo thù của nhân vật chính' },
        { key: 'summary', label: 'Tuyến này đi thế nào', value: t ? (t.summary || '') : '',
          multiline: true, rows: 4,
          placeholder: 'VD: Bị đuổi khỏi sư môn → bái nhập tông môn mới → chung kết gặp lại kẻ thù cũ' },
      ],
    });
    if (!r) return null;
    const name = (r.name || '').trim();
    if (!name) { toast('Phải đặt tên cho nó'); return null; }
    const body = {
      slug: S.slug, name: name, kind: (t && t.kind) || 'main',
      status: (t && t.status) || 'open', summary: (r.summary || '').trim(),
    };
    if (t) body.id = t.id;
    try {
      await post('/api/plot/thread', body);
      toast(t ? 'Đã sửa (mục này tính là bạn đặt)' : 'Đã thêm (mục này tính là bạn đặt)');
    } catch (e) { toast('Không lưu được: ' + e.message); return null; }
    return name;
  }

  async function reload() {
    if (!S.slug) return;
    S.err = null;
    S.ov = null;
    render();
    try {
      S.ov = await get('/api/plot/overview', { slug: S.slug });
    } catch (e) {
      const off = !!(e && (e.offline || e.status === 0));
      S.err = {
        title: off ? 'Không đọc được dàn ý: không kết nối được máy chủ' : 'Không đọc được dàn ý',
        desc: (off ? 'Kiểm tra xem điện thoại có mất mạng không, hoặc máy chủ đang khởi động lại.'
          : (e && e.message ? e.message + '. ' : '')) + ' Bấm «Thử lại» để chạy lại.',
      };
      S.ov = null;
    }
    render();
  }

  window.Outline = {
    /* host：往哪儿画；slug：哪本书；opts.title：可选的节标题（不传就不画） */
    mount(host, slug, opts) {
      S.host = host;
      S.slug = slug;
      S.filter = (function () { try { return localStorage.getItem(fkey(slug)) || 'all'; } catch (e) { return 'all'; } })();
      if (opts && opts.title) {
        const h = document.createElement('h3');
        h.className = 'ol-head';
        h.textContent = opts.title;
        host.innerHTML = '';
        host.appendChild(h);
      }
      return reload();
    },
    reload,
    quit() { S.host = null; S.ov = null; S.err = null; },
    state: S,
    /* 判据用：现在呈现出来的是大纲（而不是别的东西） */
    isOutline: (host) => !!(host && host.querySelector('[data-olnew]')),
  };
})();
