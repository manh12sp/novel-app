/* ============================================================
   tools.js — 「工具」区：原网页（小说软件本体）的能力，一件一屏搬进 App。

   这里的原则：
   1. 每一项都对着平台的**真实接口**写，不凭空造。路径以 nb/api/... 开头，
      走 server.py 的 /nb 透传（它已经替我们处理了登录、项目未打开自愈、SSE 流）。
   2. 平台没有的接口不做界面。做之前先探过真实返回结构（tools/probe_shapes.py）。
   3. 界面只用 tools.css 里的通用件，不各自造轮子。

   返回：顶部返回键在层级里往上退一级，退到底回书架。
   ============================================================ */
(function () {
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const nb = (p, o) => window.API.nb(p, o);
  const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const toast = (m) => { try { App.toast(m); } catch (e) {} };
  const hap = () => { try { App.haptic(8); } catch (e) {} };
  const ico = (n) => '<span class="tr-ico">' + window.iconHtml(n) + '</span>';
  const bytes = (n) => {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  };
  /* 平台的时间戳两种形态都有：毫秒数字，和 ISO 字符串。
     以前只认前者，ISO 的会算成 NaN 显示「Invalid Date」。 */
  const ts = (t) => {
    if (t == null || t === '') return 0;
    if (typeof t === 'number') return t;
    const n = Number(t);
    if (!isNaN(n)) return n;
    const p = Date.parse(String(t));
    return isNaN(p) ? 0 : p;
  };
  const ago = (t) => {
    t = ts(t);
    if (!t) return '';
    const d = (Date.now() - Number(t)) / 1000;
    if (d < 60) return 'Vừa xong';
    if (d < 3600) return Math.floor(d / 60) + ' phút trước';
    if (d < 86400) return Math.floor(d / 3600) + ' giờ trước';
    if (d < 2592000) return Math.floor(d / 86400) + ' ngày trước';
    return new Date(ts(t)).toLocaleDateString('vi-VN');
  };

  /* ── 弹一个输入框（改名字、建文件都用它）──
     实现搬到 app.js 的 `App.ask` 了（聊天那边的"常用指令"也要用同一个框，
     不许两边各写一份）。这里保留同名函数，工具面板里的调用一行都不用改。 */
  const ask = (title, value, opts = {}) => window.App.ask(title, value, opts);

  const confirmBox = (title, danger) => new Promise((res) => {
    const wrap = document.createElement('div');
    wrap.className = 't-dialog';
    wrap.innerHTML = '<h3>' + esc(title) + '</h3>' +
      '<div class="t-acts"><button class="t-btn" data-no>Hủy</button>' +
      '<button class="t-btn ' + (danger ? 'dan' : 'pri') + '" data-yes>Xác nhận</button></div>';
    $('[data-no]', wrap).onclick = () => { wrap.remove(); res(false); };
    $('[data-yes]', wrap).onclick = () => { wrap.remove(); res(true); };
    (document.getElementById('tool-body') || document.body).appendChild(wrap);
  });

  /* ── 详情页的层级栈：返回键一级一级往上退 ── */
  const stack = [];
  function push(title, render) {
    stack.push({ title, render });
    App.show('tool', { hashExtra: '?t=' + stack.length });
  }
  function paint() {
    const top = stack[stack.length - 1];
    const body = document.getElementById('tool-body');
    const t = document.getElementById('tool-title');
    if (t) t.textContent = top ? top.title : 'Công cụ';
    if (!body) return;
    body.innerHTML = '';
    /* 吸底主操作条是面板自己挂的（听书的「开始听」）；换屏时必须摘掉，
       否则会跟着跑到别的面板上面去。 */
    body.classList.remove('has-foot');
    body.scrollTop = 0;
    if (top) {
      try { top.render(body); } catch (e) {
        body.innerHTML = errHtml('Không vẽ được màn hình này', e, ((e && e.message) ? e.message + '. ' : '') +
          ' Thoát ra rồi vào lại thử xem; nếu cứ thế thì vào «Công cụ · Phiên bản và nhật ký» xem nhật ký.');
      }
    }
  }
  /* ── 三态：跟全站同一套（reader/书架/预设 都用这个） ────────────────────
     统一。以前这里是 `.t-load` / `.t-empty` 两套自己的写法，
     而且**出错也走"空"** —— 用户看到一句灰字"读不到：xxx"，既分不清是"没东西"
     还是"出错了"，也没有「重试」，只能自己退出去再进来。
     现在：
       loading(host,msg)  → 骨架 + 「正在读…」（带 data-state，判据看得见）
       empty(host,msg,ic) → 空态：一句人话 + 说明
       failed(host,what,e,again) → 出错态：说人话 + 一个「重试」（真的重新拉一次）
     `loading/empty` 两个老名字留着（别处调得到）。 */
  /* ── 内联串里要画"空/出错"时用它 ────────────────────────────────────
     面板里大部分地方是拼 HTML 串的（`list.innerHTML = '…'`），没法直接 append 元素。
     那就把**全站那一个 UI.state** 转成 HTML —— 实现还是只有一份，
     外貌（圆角/字号/间距/图标/data-state 标记）全站一致。
     以前这里是散在 20 处的 `'<div class="t-empty">…'`：同一个"空"，字大小、间距、
     有没有说明、有没有图标各写各的 —— 此处说明"不统一"就是这么攒出来的。 */
  const asHtml = (node) => (node && node.outerHTML) ? node.outerHTML
    : '<div class="t-empty">' + esc('(Thành phần giao diện chưa chạy, hãy thoát ra vào lại một lần)') + '</div>';
  const emptyHtml = (title, desc, ico2) =>
    asHtml(window.UI && UI.state ? UI.state({ kind: 'empty', icon: ico2 || 'list', title: title, desc: desc || '' }) : null);
  const errHtml = (what, e, desc2) => asHtml(window.UI && UI.state ? UI.state({
    kind: 'error', icon: 'refresh', title: what + ' không đọc được',
    desc: desc2 || (((e && e.message) ? e.message + '. ' : '') + ' Thoát ra rồi vào lại thử xem.'),
  }) : null);

  /* ：**实现搬去了 UI 一份**（`UI.paintState/loadingIn/emptyIn/failedIn`），
     这里只留三个薄壳给面板里 30 多处老调用点用 —— 全站只此一份实现，
     换皮/两组实现并存是明令禁止的。`failed` 的 `again` 是**真重试**（重跑那个拉取函数）。 */
  const loading = (host, msg) => (window.UI && UI.loadingIn ? UI.loadingIn(host, msg) : null);
  const empty = (host, msg, icon, desc) => (window.UI && UI.emptyIn ? UI.emptyIn(host, msg, desc, icon) : null);
  const failed = (host, what, e, again) =>
    (window.UI && UI.failedIn ? UI.failedIn(host, what, e, again) : null);

  /* ── 作品列表（各工具选书用） ── */
  let _projects = null;
  /* 服务器口令只在这一次会话里记着（换书重渲染时不该把刚打的抹掉），不落盘 */
  let _peerPass = '';
  async function projects(force) {
    if (_projects && !force) return _projects;
    const d = await nb('api/projects');
    _projects = (d && d.projects) || [];
    return _projects;
  }
  const bookName = (slug) => {
    const p = (_projects || []).find((x) => x.projectRoot === slug);
    return (p && p.title) || slug;
  };

  /* ── 当前书：跟书有关的面板，顶上都要有那一条统一切换（） ──
     谁要书就读 BookCtx —— 全站唯一的一份「现在在写哪本」，
     不再每个面板自己弹书单、也不再"没选就摔给第一本"。 */
  const curSlug = () => (window.BookCtx ? BookCtx.slug() : '');
  const mountBook = (host, render, titleOf, opts) => {
    const slug = curSlug();
    host.innerHTML = '';
    if (!slug) { empty(host, 'Chưa có tác phẩm · hãy tạo một cuốn trên giá sách trước', 'book'); return; }
    /* 那个「当前书」入口长在这一屏的**顶栏**上（不是正文里占一行）：
       所以要把内容宿主当成锚点传进去，它才知道"这一屏"是哪一个。 */
    host.appendChild(window.BookCtx.bar(slug, (s) => {
      const t = typeof titleOf === 'function' ? titleOf(s) : titleOf;
      const top = stack[stack.length - 1];
      if (top) top.title = t;
      const el = document.getElementById('tool-title');
      if (el) el.textContent = t;
      mountBook(host, render, titleOf, opts);         // 就地重渲染 → 内容立刻换成新书那套
    }, Object.assign({}, opts, { anchor: host })));
    const inner = document.createElement('div');
    host.appendChild(inner);
    try { render(inner, slug); } catch (e) { inner.innerHTML = errHtml('Không vẽ được phần này', e); }
  };
  /** pushBook：面板标题 + 顶部切书条 + 内容是"当前书"的。
      没书时先让用户选一本（选完就成为"当前书"，全站跟着走）。 */
  function pushBook(titleOf, render, opts) {
    push(typeof titleOf === 'function' ? titleOf(curSlug()) : titleOf, (h) => {
      if (curSlug()) { mountBook(h, render, titleOf, opts); return; }
      loading(h, 'Đang đọc tác phẩm…');
      /* 还没立起「当前书」：先兜一本（跟其它面板同一个来源），兜不到才让人挑 */
      const p = window.BookCtx ? BookCtx.ensure().catch(() => '') : Promise.resolve('');
      p.then((s) => {
        if (s) { BookCtx.set(s, bookName(s)); mountBook(h, render, titleOf, opts); return; }
        pickProject(h, (slug) => {
          window.BookCtx.set(slug, bookName(slug));
          mountBook(h, render, titleOf, opts);
        });
      });
    });
  }

  /* 选书：给了 slug 直接用，没给就弹一张书单 */
  function pickProject(host, cb) {
    loading(host, 'Đang đọc tác phẩm…');
    projects().then((ps) => {
      if (!ps.length) { empty(host, 'Chưa có tác phẩm', 'book'); return; }
      if (ps.length === 1) { cb(ps[0].projectRoot); return; }
      host.innerHTML = '<div class="t-list">' + ps.map((p) =>
        '<div class="t-row" data-slug="' + esc(p.projectRoot) + '">' + ico('book') +
        '<div class="tr-main"><div class="tr-title">' + esc(p.title || p.projectRoot) + '</div>' +
        '<div class="tr-sub">' + esc(p.summary || p.projectRoot) + '</div></div>' +
        '<span class="tr-go">' + window.iconHtml('chevron') + '</span></div>').join('') + '</div>';
      $$('[data-slug]', host).forEach((r) => {
        r.onclick = () => { hap(); cb(r.dataset.slug); };
      });
    }).catch((e) => failed(host, 'Danh sách tác phẩm', e));
  }

  /* ══════════════════════════════════════════════════════════
     1. 文件：作品的每一个文件都能看、能改、能删
     ══════════════════════════════════════════════════════════ */
  function openFiles(host) { pushBook('Tệp', (h, slug) => fileBrowse(h, slug, ''), {}); }

  async function fileBrowse(host, slug, dir) {
    loading(host, 'Đang đọc cây tệp…');
    let d;
    try { d = await nb('api/workspace-files/tree?' + qs({ projectRoot: slug })); }
    catch (e) { failed(host, 'Cây tệp', e, () => fileBrowse(host, slug, dir)); return; }
    const nodes = d.nodes || [];
    paintBrowse(host, slug, dir, nodes);
  }

  function paintBrowse(host, slug, dir, nodes) {
    /* 进到子目录时，返回键先退一层目录（而不是直接弹回宫格）——
       以前这里是原地重绘、没有层级，按返回会一口气跳回宫格，中间那层就丢了。 */
    const topEntry = stack[stack.length - 1];
    if (topEntry) {
      topEntry.onBack = dir
        ? () => { paintBrowse(host, slug, dir.replace(/[^/]+\/$/, ''), nodes); return true; }
        : null;
    }
    /* 树是扁平的（98 个节点一口气给全），靠 path 前缀切出当前这一层 */
    const kids = [];
    const seenDir = {};
    nodes.forEach((n) => {
      const p = n.path;
      if (!p.startsWith(dir)) return;
      const rest = p.slice(dir.length);
      if (!rest) return;
      const seg = rest.split('/')[0];
      if (rest.indexOf('/') >= 0) {
        if (!seenDir[seg]) {
          seenDir[seg] = true;
          kids.push({ dir: true, name: seg, path: dir + seg + '/', words: n.words, icon: 'folder' });
        }
      } else {
        kids.push({ dir: false, name: seg, path: p, node: n });
      }
    });
    kids.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'vi'));

    const crumbs = ['<button data-crumb="">Thư mục gốc</button>'];
    let acc = '';
    dir.split('/').filter(Boolean).forEach((s) => {
      acc += s + '/';
      crumbs.push('<span class="sep">/</span><button data-crumb="' + esc(acc) + '">' + esc(s) + '</button>');
    });

    const names = kids.map((k) => (k.dir ? k.name + '/' : k.name)).join('\n');
    host.innerHTML =
      '<div class="fb-crumb">' + crumbs.join('') + '</div>' +
      '<div class="t-bar">' +
      '<button class="t-btn sm" data-newf>Tạo tệp</button>' +
      '<button class="t-btn sm" data-newd>Tạo thư mục</button>' +
      '<button class="t-btn sm" data-up>Tải tệp lên</button>' +
      '<button class="t-btn sm" data-names>Đường dẫn đầy đủ</button>' +
      '</div>' +
      (kids.length
        ? '<div class="t-list">' + kids.map((k, i) =>
          '<div class="t-row" data-i="' + i + '">' +
          '<span class="tr-ico">' + window.iconHtml(k.dir ? 'folder' : ((k.node && k.node.icon) || 'file')) + '</span>' +
          '<div class="tr-main"><div class="tr-title">' + esc(k.name) + (k.dir ? '/' : '') + '</div>' +
          '<div class="tr-sub">' + (k.dir ? 'Thư mục'
            : bytes(k.node && k.node.size) + (k.node && k.node.words ? ' · ' + k.node.words + ' chữ' : '') +
              (k.node && k.node.mtimeMs ? ' · ' + ago(k.node.mtimeMs) : '')) + '</div></div>' +
          (k.dir ? '<span class="tr-go">' + window.iconHtml('chevron') + '</span>' : '') +
          '</div>').join('') + '</div>'
        : emptyHtml('Thư mục này trống', 'Xem thư mục khác, hoặc bấm nút ở trên để tải một tệp lên.', 'folder'));

    $$('[data-crumb]', host).forEach((b) => { b.onclick = () => { hap(); paintBrowse(host, slug, b.dataset.crumb, nodes); }; });
    $$('.t-row', host).forEach((r) => {
      const k = kids[Number(r.dataset.i)];
      r.onclick = () => {
        hap();
        if (k.dir) paintBrowse(host, slug, k.path, nodes);
        else openFileEditor(host, slug, k.path, nodes);
      };
    });
    $('[data-names]', host).onclick = () => ask('Toàn bộ đường dẫn ở tầng này', names, { multiline: true, host });
    $('[data-newf]', host).onclick = async () => {
      const v = await ask('Tạo tệp (đường dẫn tương đối)', dir, { host, placeholder: dir + 'tep-moi.md' });
      if (!v) return;
      try { await nb('api/workspace-files/create-file', { method: 'POST', body: { projectRoot: slug, path: v } }); toast('Đã tạo xong'); hap(); fileBrowse(host, slug, dir); }
      catch (e) { toast('Không tạo được: ' + e.message); }
    };
    $('[data-newd]', host).onclick = async () => {
      const v = await ask('Tạo thư mục (đường dẫn tương đối)', dir, { host });
      if (!v) return;
      try { await nb('api/workspace-files/create-directory', { method: 'POST', body: { projectRoot: slug, path: v } }); toast('Đã tạo xong'); hap(); fileBrowse(host, slug, dir); }
      catch (e) { toast('Không tạo được: ' + e.message); }
    };
    $('[data-up]', host).onclick = () => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.onchange = async () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        const fd = new FormData();
        fd.append('file', f);
        fd.append('projectRoot', slug);
        fd.append('path', dir + f.name);
        loading(host, 'Đang tải lên…');
        try {
          const r = await fetch(window.API.abs('nb/api/workspace-files/upload-file'), { method: 'POST', body: fd, credentials: 'include' });
          if (!r.ok) throw new Error((await r.text()).slice(0, 120));
          toast('Đã tải lên'); hap(); fileBrowse(host, slug, dir);
        } catch (e) { toast('Không tải lên được: ' + e.message); fileBrowse(host, slug, dir); }
      };
      inp.click();
    };
  }

  async function openFileEditor(host, slug, path, nodes) {
    loading(host, 'Mở ' + path.split('/').pop() + '…');
    let d, raw = null;
    try {
      d = await nb('api/workspace-files/read?' + qs({ projectRoot: slug, path }));
    } catch (e) {
      try {
        const r = await fetch(window.API.abs('nb/api/workspace-files/download?' + qs({ projectRoot: slug, path })), { credentials: 'include' });
        if (!r.ok) throw new Error('Không đọc được tệp này');
        raw = URL.createObjectURL(await r.blob());
      } catch (e2) { failed(host, 'Tệp này', e, () => fileBrowse(host, slug, path.split('/').slice(0, -1).join('/'))); return; }
    }
    const back = () => fileBrowse(host, slug, path.split('/').slice(0, -1).join('/') + (path.indexOf('/') >= 0 ? '/' : ''));
    if (raw) {
      host.innerHTML = '<div class="t-hint" style="margin:0 0 var(--sp-3)">Đây là tệp nhị phân (kiểu hình ảnh), không sửa được, có thể tải về hoặc xóa.</div>' +
        '<div class="t-bar"><button class="t-btn" data-dl>Tải về</button>' +
        '<button class="t-btn dan" data-del>Xóa</button>' +
        '<button class="t-btn" data-back>Quay lại</button></div>';
      $('[data-dl]', host).onclick = () => { const a = document.createElement('a'); a.href = raw; a.download = path.split('/').pop(); a.click(); };
      $('[data-back]', host).onclick = () => { hap(); back(); };
      $('[data-del]', host).onclick = async () => {
        if (!(await confirmBox('Xóa ' + path + '? ', true))) return;
        try { await nb('api/workspace-files/delete?' + qs({ projectRoot: slug, path }), { method: 'DELETE', body: { projectRoot: slug, path } }); toast('Đã xóa'); hap(); back(); }
        catch (e) { toast('Không xóa được: ' + e.message); }
      };
      return;
    }
    const editable = d.editable !== false;
    const size = (d.content || '').length;
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-2)">' + esc(path) + ' · ' + size + ' chữ ' +
      (d.mtimeMs ? ' · ' + ago(d.mtimeMs) : '') + (editable ? '' : ' · chỉ đọc') + '</div>' +
      (editable ? '<textarea class="t-area mono" spellcheck="false" style="min-height:46vh">' + esc(d.content || '') + '</textarea>'
        : '<div class="t-pre">' + esc(d.content || '') + '</div>') +
      '<div class="t-bar" style="margin-top:var(--sp-3)">' +
      (editable ? '<button class="t-btn pri" data-tsave>Lưu</button>' : '') +
      '<button class="t-btn" data-rename>Đổi tên</button>' +
      '<button class="t-btn" data-download>Tải về</button>' +
      '<button class="t-btn dan" data-del>Xóa</button>' +
      '<button class="t-btn" data-back>Quay lại</button>' +
      '</div>';

    const ta = $('.t-area', host);
    if (ta && editable) {
      ta.addEventListener('input', () => {
        const b = $('[data-tsave]', host);
        if (b) { b.textContent = 'Lưu ●'; b.classList.add('pri'); }
      });
    }
    if (editable) {
      $('[data-tsave]', host).onclick = async () => {
        const btn = $('[data-tsave]', host);
        btn.disabled = true; btn.textContent = 'Đang lưu…';
        try {
          // 带着「我打开时它长这样」去存：别处改过就 409，先问人，不许闷头覆盖
          await nb('api/workspace-files/write?' + qs({ projectRoot: slug, path }), {
            method: 'PUT',
            body: { projectRoot: slug, path, content: ta.value, baseContent: d.content },
          });
          toast('Đã lưu'); hap(); btn.textContent = 'Đã lưu'; btn.classList.remove('pri');
          setTimeout(() => { btn.disabled = false; }, 500);
        } catch (e) {
          btn.disabled = false; btn.textContent = 'Lưu';
          if (e.offline) {
            window.Offline && Offline.queueWrite(slug, path, ta.value, 0);
            toast('Hiện không có mạng, tạm lưu trên máy; có mạng sẽ tự đẩy lên');
            return;
          }
          if (e.status === 409) {
            const yes = await confirmBox('Tệp này đã bị sửa ở nơi khác. Tải bản trên máy chủ (bản của tôi sẽ mất)?', true);
            if (yes) {
              const fresh = await nb('api/workspace-files/read?' + qs({ projectRoot: slug, path }));
              d.content = fresh.content;
              ta.value = fresh.content || '';
              toast('Đã tải bản trên máy chủ');
            } else {
              toast('Vậy khoan lưu: sao chép bản của bạn ra trước, rồi tải bản mới để gộp');
            }
            return;
          }
          toast('Không lưu được: ' + e.message);
        }
      };
    }
    $('[data-back]', host).onclick = () => { hap(); back(); };
    $('[data-download]', host).onclick = () => {
      const a = document.createElement('a');
      a.href = 'nb/api/workspace-files/download?' + qs({ projectRoot: slug, path });
      a.download = path.split('/').pop();
      a.click();
    };
    $('[data-rename]', host).onclick = async () => {
      const v = await ask('Đổi tên thành gì (đường dẫn tương đối)', path, { host });
      if (!v || v === path) return;
      try { await nb('api/workspace-files/rename', { method: 'PATCH', body: { projectRoot: slug, from: path, to: v } }); toast('Đã sửa xong'); hap(); back(); }
      catch (e) { toast('Không đổi được: ' + e.message); }
    };
    $('[data-del]', host).onclick = async () => {
      if (!(await confirmBox('Xóa ' + path + '? ', true))) return;
      try { await nb('api/workspace-files/delete?' + qs({ projectRoot: slug, path }), { method: 'DELETE', body: { projectRoot: slug, path } }); toast('Đã xóa'); hap(); back(); }
      catch (e) { toast('Không xóa được: ' + e.message); }
    };
  }

  /* ══════════════════════════════════════════════════════════
     2. 封面
     ══════════════════════════════════════════════════════════ */
  function openCover(host) { pushBook('Bìa sách', (h, slug) => coverView(h, slug), {}); }

  /* 封面这一屏。**先问再取图**：以前不管有没有封面都直接 <img src=...>，
     没有封面的书（比如新建的）会让浏览器打一条 404 —— 用户看不见，但那是响当当的错误。
     现在先问一遍 projects 有没有封面，没有就画空态，不发那个请求。 */
  async function coverView(host, slug) {
    const url = 'nb/api/projects/cover?' + qs({ projectRoot: slug });
    loading(host, 'Đang xem bìa…');
    let has = false, canDel = false;
    try {
      const d = await API.shelf();                      // /api/shelf 才带 hasCover 这个字段
      const p = (d.projects || []).find((x) => x.slug === slug);
      has = !!(p && p.hasCover);
      canDel = has;
    } catch (e) { failed(host, 'Bìa sách', e, () => coverView(host, slug)); return; }
    host.innerHTML =
      '<div class="cv-wrap"><div class="cv-box" id="cv-box">' +
      (has
        ? '<img src="' + url + '&_=' + Date.now() + '" alt="">'
        /* 空态带上 data-state：全站三态判据只认这个标记 —— 不然脚本会说
           "封面这屏没有空态"，而用户明明看到了一句「还没有封面」（）。 */
        : '<div class="cv-none" data-state="empty"><div class="cv-none-t">Chưa có bìa</div>'
          + '<div class="cv-none-d">Chọn một ảnh dọc (khoảng 3:4 là giống sách nhất), giá sách cũng đổi theo.</div></div>') +
      '</div><div class="cv-side">' +
      '<button class="t-btn pri" data-pick>Chọn một ảnh</button>' +
      (canDel ? '<button class="t-btn dan" data-del>Xóa bìa</button>' : '') +
      '<div class="t-hint">Nên dùng ảnh dọc, tỷ lệ khoảng 3:4 là giống sách nhất. Tải lên xong giá sách và trang tuyển tập sẽ đổi theo.</div>' +
      '</div></div>' +
      '<div class="t-hint">' + esc(bookName(slug)) + '</div>';
    $('[data-pick]', host).onclick = () => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*';
      inp.onchange = async () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        try { await window.API.coverUpload(slug, f); toast('Đã đổi bìa'); hap(); coverView(host, slug); }
        catch (e) { toast('Không đổi được: ' + e.message); }
      };
      inp.click();
    };
    const del = $('[data-del]', host);
    if (del) del.onclick = async () => {
      if (!(await confirmBox('Xóa bìa của cuốn này?', true))) return;
      try { await nb('api/projects/cover?' + qs({ projectRoot: slug }), { method: 'DELETE' }); toast('Đã xóa'); hap(); coverView(host, slug); }
      catch (e) { toast('Không xóa được: ' + e.message); }
    };
  }

  /* ══════════════════════════════════════════════════════════
     3. 记忆（RAG）：AI 记住了什么
     ══════════════════════════════════════════════════════════ */
  function openMemory(host) { pushBook('Trí nhớ', (h, slug) => memoryView(h, slug), {}); }

  async function memoryView(host, slug) {
    loading(host, 'Đang đọc kho trí nhớ…');
    let ins;
    try { ins = await nb('api/projects/rag/inspector?' + qs({ projectRoot: slug, limit: 200 })); }
    catch (e) { failed(host, 'Kho trí nhớ', e, () => memoryView(host, slug)); return; }
    const subs = ins.subjects || [];
    const emb = ins.embedding || {};
    const idx = ins.index || {};
    host.innerHTML =
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + (subs.length || 0) + '</b><span>Chủ thể trí nhớ</span></div>' +
      '<div class="t-stat"><b>' + (idx.vectorCount != null ? idx.vectorCount : '—') + '</b><span>Mục vector</span></div>' +
      '<div class="t-stat"><b>' + (emb.enabled ? 'Bật' : 'Tắt') + '</b><span>Tìm theo ngữ nghĩa</span></div>' +
      '</div>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">Trí nhớ là thứ AI tự tích lũy về «những gì đã xảy ra trong sách». Sửa chính văn xong hãy cho nó xây lại một lần, AI sẽ không nhớ nhầm.</div>' +
      '<div class="t-field" style="background:var(--card);border:1px solid var(--line-2);border-radius:var(--radius);padding:var(--sp-3) var(--sp-3);margin-bottom:var(--sp-3)">' +
      '<input class="t-input" id="mem-q" type="search" placeholder="Hỏi nó một câu, ví dụ «nhân vật chính tên gì»"></div>' +
      '<div class="t-bar">' +
      '<button class="t-btn pri" data-search>Tìm thử</button>' +
      '<button class="t-btn" data-rebuild>Xây lại trí nhớ</button>' +
      '<button class="t-btn" data-debug>Khám tổng quát</button>' +
      '</div>' +
      '<div id="mem-hit"></div>' +
      '<div id="mem-list"></div>' +
      '<div id="mem-out"></div>';

    const list = $('#mem-list', host);
    if (!subs.length) {
      list.innerHTML = emptyHtml('Chưa có chủ thể trí nhớ', 'Viết đến một lượng nhất định, AI chạy qua một lượt là sẽ tự tích lũy.', 'database');
    } else {
      list.innerHTML = '<div class="t-list">' + subs.map((s, i) =>
        '<div class="t-row" data-i="' + i + '">' + ico('database') +
        '<div class="tr-main"><div class="tr-title">' + esc(((s.metadata && s.metadata.name) || s.subjectId || (s.subjectPath || '').replace('simulation/subjects/', '')) ) + '</div>' +
        '<div class="tr-sub">' + esc([((s.metadata && s.metadata.kind) || ''), s.memoryCount != null ? s.memoryCount + ' mục trí nhớ' : '', s.eventCount != null ? s.eventCount + ' sự kiện' : ''].filter(Boolean).join(' · ')) + '</div></div>' +
        '<span class="tr-go">' + window.iconHtml('chevron') + '</span></div>').join('') + '</div>';
      $$('.t-row', list).forEach((r) => {
        r.onclick = () => {
          hap();
          const s = subs[Number(r.dataset.i)];
          memorySubject(host, slug, s.subjectPath || s.path, (s.metadata && s.metadata.name) || s.subjectId || '');
        };
      });
    }
    // 平台的记忆搜索是**按主体**的（subjectPath + query），没有全书一次搜。
    // 这里有多个主体就依次搜、合并；一个主体都没有就直说，别让用户对着空框发呆。
    $('[data-search]', host).onclick = async () => {
      const q = ($('#mem-q', host).value || '').trim();
      const hit = $('#mem-hit', host);
      if (!q) { hit.innerHTML = ''; return; }
      if (!subs.length) {
        hit.innerHTML = emptyHtml('Cuốn này chưa có chủ thể trí nhớ', 'Hãy để AI viết vài lượt, hoặc bấm «Xây lại trí nhớ» bên dưới; có chủ thể rồi mới tìm được.', 'database');
        return;
      }
      hit.innerHTML = '<div class="t-load"><i></i></div>';
      const found = [];
      for (const s of subs) {
        const sp = s.subjectPath || s.path;
        if (!sp) continue;
        try {
          const r = await nb('api/projects/rag/search?' + qs({ projectRoot: slug }),
            { method: 'POST', body: { subjectPath: sp, query: q, limit: 8 } });
          ((r && r.candidates) || []).forEach((c) => found.push(Object.assign({ _sp: sp }, c)));
        } catch (e) { /* 单个主体搜不动不影响其它的 */ }
      }
      found.sort((a, b) => (a.rank || 99) - (b.rank || 99));
      hit.innerHTML = found.length
        ? '<h2 style="font:600 var(--t-md)/1 var(--ui-font);color:var(--ink-3);margin:var(--sp-3) var(--sp-1) var(--sp-2)">Tìm thấy ' + found.length + ' mục</h2><div class="t-list">' +
          found.map((x) => '<div class="t-row static">' + ico('search') +
            '<div class="tr-main"><div class="tr-title" style="white-space:normal;font-weight:var(--w-normal);font-size:var(--t-base);line-height:1.55">' +
            esc(x.text || '') + '</div>' +
            '<div class="tr-sub">' + esc([x._sp.replace('simulation/subjects/', ''), x.topic || '', x.source || '', x.rank ? 'hạng ' + x.rank + '' : ''].filter(Boolean).join(' · ')) + '</div></div></div>').join('') + '</div>'
        : emptyHtml('Không tìm thấy trí nhớ liên quan', 'Thử từ khác, hoặc xóa ô tìm kiếm để xem tất cả.', 'database');
    };
    const mq = $('#mem-q', host);
    if (mq) mq.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('[data-search]', host).click(); });
    $('[data-rebuild]', host).onclick = async () => {
      if (!(await confirmBox('Để AI đọc lại chính văn, xây lại toàn bộ trí nhớ? Chạy xong mới được đóng trang.'))) return;
      loading(host, 'Đang xây lại… (có thể mất một hai phút)');
      try { const r = await nb('api/projects/rag/rebuild?' + qs({ projectRoot: slug }), { method: 'POST', body: {} }); toast('Đã xây lại xong'); hap(); memoryView(host, slug); }
      catch (e) { toast('Xây lại thất bại: ' + e.message); memoryView(host, slug); }
    };
    $('[data-debug]', host).onclick = async () => {
      const out = $('#mem-out', host);
      out.innerHTML = '<div class="t-load"><i></i></div>';
      try {
        const r = await nb('api/projects/rag/debug?' + qs({ projectRoot: slug }), { method: 'POST', body: {} });
        out.innerHTML = '<div class="t-pre">' + esc(JSON.stringify(r, null, 2).slice(0, 4000)) + '</div>';
      } catch (e) { out.innerHTML = errHtml('Khám không chạy được', e); }
    };
  }

  async function memorySubject(host, slug, subjectPath, title) {
    loading(host, 'Đang đọc trí nhớ của chủ thể này…');
    let d;
    try { d = await nb('api/projects/rag/subject?' + qs({ projectRoot: slug, subjectPath })); }
    catch (e) { failed(host, 'Trí nhớ của chủ thể này', e, () => memorySubject(host, slug, subjectPath, title)); return; }
    const mem = d.memories || [];
    const ev = d.events || [];
    const H = (t, n) => '<h2 style="font:600 var(--t-md)/1 var(--ui-font);color:var(--ink-3);margin:var(--sp-4) var(--sp-1) var(--sp-2)">' + t + ' ' + n + '</h2>';

    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-1)">' + esc(title || subjectPath) + '</div>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-3);opacity:.7">' + esc(subjectPath) + '</div>' +

      H('Những điều nhớ được', mem.length) +
      '<div class="t-list">' + (mem.length ? mem.map((m, i) =>
        '<div class="t-row static">' + ico('database') +
        '<div class="tr-main"><div class="tr-title">' + esc(m.topic || '') + '</div>' +
        '<div class="tr-sub wrap" style="color:var(--ink-2)">' + esc(m.view || '') + '</div>' +
        ((m.aliases && m.aliases.length) ? '<div class="tr-sub">Còn gọi là ' + esc(m.aliases.join(', ')) + '</div>' : '') +
        '</div><button class="t-btn sm dan" data-delmem="' + i + '">Quên đi</button></div>').join('')
        : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">Chủ thể này chưa có mục trí nhớ nào</div></div></div>') + '</div>' +

      H('Những việc đã xảy ra', ev.length) +
      '<div class="t-list">' + (ev.length ? ev.map((e2) =>
        '<div class="t-row static">' + ico('clock') +
        '<div class="tr-main"><div class="tr-title" style="white-space:normal;font-weight:var(--w-normal);font-size:var(--t-base);line-height:1.55">' +
        esc(e2.text || '') + '</div>' +
        '<div class="tr-sub">' + esc([e2.tick || '', e2.time || ''].filter(Boolean).join(' · ')) + '</div></div></div>').join('')
        : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">Chưa có sự kiện</div></div></div>') + '</div>' +

      '<div class="t-hint" style="margin-top:var(--sp-4)">«Quên đi» chỉ xóa mục trí nhớ này của AI, chính văn không bị động chữ nào. Xóa nhầm thì xây lại trí nhớ một lần.</div>';

    $$('[data-delmem]', host).forEach((b) => {
      b.onclick = async () => {
        const m = mem[Number(b.dataset.delmem)];
        if (!(await confirmBox('Để AI quên «' + (m.topic || '') + '» việc này?'))) return;
        try {
          await nb('api/projects/rag/memories?' + qs({ projectRoot: slug }),
            { method: 'DELETE', body: { subjectPath, topic: m.topic } });
          toast('Đã quên'); hap(); memorySubject(host, slug, subjectPath, title);
        } catch (e) { toast('Không xóa được: ' + e.message); }
      };
    });
  }

  /* ══════════════════════════════════════════════════════════
     4. 模型 / 供应商
     ══════════════════════════════════════════════════════════ */
  function openModels(host) { pushBook('Mô hình và nhà cung cấp', (h) => modelsView(h), { global: true }); }

  async function modelsView(host) {
    loading(host, 'Đang đọc kho mô hình…');
    let lib, tpl, snap;
    try {
      lib = await nb('api/config/models/library');
      tpl = await nb('api/config/models/provider-templates');
    } catch (e) { failed(host, 'Danh sách mô hình', e, () => modelsView(host)); return; }
    const models = (lib && lib.models) || [];
    const templates = (tpl && tpl.templates) || [];
    let provs = {};
    try { const p = await projects(); snap = await nb('api/config/snapshot?' + qs({ projectRoot: p[0] && p[0].projectRoot })); provs = (snap && snap.effective && snap.effective.models && snap.effective.models.providers) || {}; } catch (e) {}
    const provList = Object.entries(provs);

    host.innerHTML =
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + models.length + '</b><span>Mô hình có thể chọn</span></div>' +
      '<div class="t-stat"><b>' + provList.length + '</b><span>Nhà cung cấp đã cấu hình</span></div>' +
      '<div class="t-stat"><b>' + templates.length + '</b><span>Nhà cung cấp có thể thêm</span></div>' +
      '</div>' +
      '<h2 style="font:600 var(--t-md)/1 var(--ui-font);color:var(--ink-3);margin:0 var(--sp-1) var(--sp-2)">Có kết nối được không</h2>' +
      '<div class="t-bar"><button class="t-btn pri" id="mdl-testdef">Thử mô hình đang dùng</button></div>' +
      '<div id="mdl-testres" class="t-hint" style="margin:calc(-1 * var(--sp-2)) 0 var(--sp-4)">Gửi một câu đi, xem mô hình có trả lời không. ' +
      ' Không kết nối được sẽ ghi rõ lý do (khóa sai / địa chỉ không thông / tên mô hình sai), không cần đoán.</div>' +
      '<h2 style="font:600 var(--t-md)/1 var(--ui-font);color:var(--ink-3);margin:0 var(--sp-1) var(--sp-2)">Nhà cung cấp đã cấu hình</h2>' +
      (provList.length
        ? '<div class="t-list">' + provList.map(([k, v]) =>
          '<div class="t-row static">' + ico('cpu') + '<div class="tr-main"><div class="tr-title">' + esc(v.name || k) + '</div>' +
          '<div class="tr-sub">' + esc(k + ' · ' + (v.modelApi || '') + (v.enabled === false ? ' · Đã tắt' : '')) + '</div></div>' +
          '<span class="t-pill ' + (v.enabled === false ? 'gray' : 'ok') + '">' + (v.enabled === false ? 'Đã tắt' : 'Đang dùng') + '</span></div>').join('') + '</div>'
        : emptyHtml('Chưa cấu hình nhà cung cấp nào', 'Vào «Cài đặt · Kênh mô hình» thêm một cái; thêm xong ở đây sẽ liệt kê ra, và có thể thử kết nối từng cái.', 'cpu')) +
      '<h2 style="font:600 var(--t-md)/1 var(--ui-font);color:var(--ink-3);margin:var(--sp-4) var(--sp-1) var(--sp-2)">Kho mô hình</h2>' +
      '<div class="t-field" style="background:var(--card);border:1px solid var(--line-2);border-radius:var(--radius);padding:var(--sp-3) var(--sp-3);margin-bottom:var(--sp-3)">' +
      '<input class="t-input" id="mdl-q" type="search" placeholder="Tìm tên mô hình, ví dụ gemini / deepseek"></div>' +
      '<div id="mdl-list"></div>' +
      '<h2 style="font:600 var(--t-md)/1 var(--ui-font);color:var(--ink-3);margin:var(--sp-5) var(--sp-1) var(--sp-2)">Nhóm mô hình (chia theo mục đích)</h2>' +
      '<div id="ms-box"></div>';

    const draw = (kw) => {
      const list = $('#mdl-list', host);
      const hit = models.filter((m) => !kw || (m.name + ' ' + m.id).toLowerCase().indexOf(kw.toLowerCase()) >= 0);
      const top = hit.slice(0, 60);
      list.innerHTML = top.length
        ? '<div class="t-list">' + top.map((m) =>
          '<div class="t-row static">' + ico('cpu') + '<div class="tr-main"><div class="tr-title">' + esc(m.name || m.id) + '</div>' +
          '<div class="tr-sub">' + esc([m.source, m.contextWindowTokens ? Math.round(m.contextWindowTokens / 1000) + 'K ngữ cảnh' : '', m.reasoning ? 'biết suy nghĩ' : ''].filter(Boolean).join(' · ')) + '</div></div>' +
          (m.reasoning ? '<span class="t-pill">Suy nghĩ</span>' : '') +
          '<button class="t-btn sm dim" data-tm="' + esc(m.source + '/' + m.id) + '">Thử</button></div>').join('') + '</div>' +
          (hit.length > 60 ? '<div class="t-hint" style="text-align:center">Còn ' + (hit.length - 60) + ' mô hình nữa, gõ thêm vài chữ để thu hẹp</div>' : '')
        /* 分两种"空"：**库里本来就没有** ≠ **搜索没搜到** —— 一句话说错，用户会以为是自己打错了字。 */
        : (models.length
          ? emptyHtml('Không tìm thấy mô hình này', 'Thử từ khác, ví dụ gemini / deepseek / claude.', 'cpu')
          : emptyHtml('Kho mô hình còn trống', 'Hãy vào «Cài đặt · Kênh mô hình» cấu hình kênh trước; xong rồi ở đây sẽ liệt kê các mô hình dùng được.', 'cpu'));
    };
    draw('');
    $('#mdl-q', host).addEventListener('input', (e) => draw(e.target.value.trim()));
    bindTests(host);
    const defBtn = $('#mdl-testdef', host);
    if (defBtn) defBtn.onclick = async () => {
      await runTest(defBtn, '', $('#mdl-testres', host));
    };
    renderSets(host);
  }

  /* 连通自检（· 接上本来"有接口、界面没入口"的 POST /api/config/models/test）
     为什么要它：用户最想知道的一件事就是"现在这个模型到底通不通"。
     以前只能靠"发一条消息试试"，失败了也看不出是网络、密钥还是模型名的锅。 */
  function bindTests(host) {
    $$('[data-tm]', host).forEach((b) => {
      if (b.__bound) return;
      b.__bound = 1;
      b.onclick = async (ev) => {
        ev.stopPropagation();
        const key = b.getAttribute('data-tm') || '';
        /* 这一行没读到模型 id 就**别发**：后端在 key 为空时会回落到「现在用的那个」，
           那用户以为测的是这一行、其实测的是默认模型 —— 假绿。宁可说一句人话。 */
        if (!key) { toast('Dòng này không đọc được id mô hình, thoát ra vào lại rồi thử'); return; }
        await runTest(b, key, $('#mdl-testres', document));
      };
    });
  }

  function testLine(ok, key, ms, text) {
    return '<div class="t-row static">' + ico(ok ? 'check' : 'close') +
      '<div class="tr-main"><div class="tr-title">' + esc(ok ? ('Thông · ' + (ms / 1000).toFixed(1) + ' giây') : 'Không kết nối được') + '</div>' +
      '<div class="tr-sub wrap">' + esc(text) + '</div></div>' +
      '<span class="t-pill ' + (ok ? 'ok' : 'warn') + '">' + esc(key ? String(key).split('/').pop().slice(0, 16) : 'đang dùng') + '</span></div>';
  }

  async function runTest(btn, key, resBox) {
    if (btn && btn.disabled) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Đang thử…'; }
    if (resBox) resBox.innerHTML = '<div class="t-load"><i></i><div class="t-hint" style="margin-top:var(--sp-2)">Gửi một câu đi, chờ nó trả lời…</div></div>';
    let r = null, err = '';
    try { r = await nb('api/config/models/test', { method: 'POST', body: { modelKey: key || '' } }); }
    catch (e) { err = e.message || String(e); }
    const ok = !!(r && r.ok);
    const ms = (r && r.ms) || 0;
    if (btn) {
      btn.disabled = false;
      btn.textContent = ok ? 'Thông' : 'Thử lại';
      btn.className = 't-btn sm ' + (ok ? 'dim' : 'dan');
    }
    if (ok) hap();
    const why = ok ? ('Nó trả lời: ' + ((r.reply || '').trim() || '(trống)'))
      : (err || (r && r.error) || 'Không rõ nguyên nhân');
    const hint = !ok && /还没选模型|Chưa chọn mô hình/.test(why)
      ? 'Chưa chọn mô hình: bấm «Thử» ở kho mô hình bên dưới để thử một cái, hoặc chọn một cái trong preset làm mặc định.' : why;
    if (resBox) resBox.innerHTML = testLine(ok, key, ms, hint);
    toast(ok ? ('Thông · ' + (ms / 1000).toFixed(1) + ' giây') : ('Không kết nối được: ' + hint.slice(0, 40)));
    return ok;
  }

  /* ── 模型组：按用途指定模型（规划用大模型、润色用快模型）── */
  const PURPOSE_NAME = { planner: 'Lên kế hoạch', writer: 'Viết chính văn', polish: 'Trau chuốt, viết lại', fast: 'Việc vặt' };

  async function renderSets(host) {
    const box = $('#ms-box', host || document);
    if (!box) return;
    box.innerHTML = '<div class="t-load"><i></i><div class="t-hint" style="margin-top:var(--sp-3)">Đang đọc nhóm mô hình…</div></div>';
    let d;
    try { d = await window.API.modelSets(); }
    catch (e) { box.innerHTML = errHtml('Nhóm mô hình', e); return; }
    const sets = (d && d.sets) || [];
    const active = (d && d.active) || '';
    box.innerHTML =
      '<div class="t-bar"><button class="t-btn pri" data-msnew>Tạo nhóm mô hình</button>' +
      (active ? '<button class="t-btn" data-msoff>Tắt «' + esc(active) + '»</button>' : '') + '</div>' +
      '<div class="t-hint" style="margin:calc(-1 * var(--sp-1)) 0 var(--sp-3)">Bật nhóm nào thì viết/trau chuốt/lên kế hoạch sẽ theo mô hình nhóm đó chỉ định; ' +
      ' khi không bật thì như trước (mô hình chọn trong preset).</div>' +
      (sets.length
        ? '<div class="t-list">' + sets.map((x, i) => {
          const keys = x.keys || {};
          const sub = Object.keys(PURPOSE_NAME).filter((k) => keys[k])
            .map((k) => PURPOSE_NAME[k] + ' → ' + keys[k].split('/').pop()).join(' · ') || 'vẫn trống';
          return '<div class="t-row" data-set="' + i + '">' + ico('cpu') +
            '<div class="tr-main"><div class="tr-title">' + esc(x.name) + '</div>' +
            '<div class="tr-sub wrap">' + esc(sub) + '</div></div>' +
            (x.name === active ? '<span class="t-pill ok">Đang dùng</span>' : '<span class="tr-go">' + window.iconHtml('chevron') + '</span>') +
            '</div>';
        }).join('') + '</div>'
        : emptyHtml('Chưa có nhóm mô hình', 'Tạo một nhóm là có thể chia mô hình theo mục đích, ví dụ lên kế hoạch dùng mô hình lớn, trau chuốt dùng loại rẻ.', 'sliders'));

    $$('[data-set]', box).forEach((r) => {
      r.onclick = () => { hap(); const x = sets[Number(r.dataset.set)]; push('Nhóm mô hình · ' + x.name, (h) => modelSetEdit(h, x)); };
    });
    const nbBtn = $('[data-msnew]', box);
    if (nbBtn) nbBtn.onclick = async () => {
      const name = await ask('Nhóm mô hình tên là gì', '', { placeholder: 'VD: Combo tiết kiệm', host: host });
      if (!name) return;
      push('Nhóm mô hình · ' + name, (h) => modelSetEdit(h, { name: name, keys: {} }));
    };
    const offBtn = $('[data-msoff]', box);
    if (offBtn) offBtn.onclick = async () => {
      try { await window.API.modelSetActivate(''); toast('Đã tắt, quay về mô hình chọn trong preset'); hap(); renderSets(host); }
      catch (e) { toast('Không tắt được: ' + e.message); }
    };
  }

  async function modelSetEdit(host, set) {
    const members = Object.assign({}, set.keys || {});
    const draft = { note: set.note || '' };
    let lib = [];
    try { const d = await nb('api/models'); lib = (d && d.models) || []; } catch (e) {}
    const paintSet = () => {
      host.innerHTML =
        '<div class="t-hint" style="margin:0 0 var(--sp-3)">Chọn một mô hình cho mỗi mục đích. Chọn xong bấm Lưu; muốn bộ này có hiệu lực, ' +
        ' bấm «Bật nhóm này» — bật rồi nó sẽ thay cho mô hình chọn trong preset.</div>' +
        '<div class="t-list">' + Object.keys(PURPOSE_NAME).map((k) =>
          '<div class="t-row" data-p="' + k + '">' + ico('cpu') +
          '<div class="tr-main"><div class="tr-title">' + PURPOSE_NAME[k] + '</div>' +
          '<div class="tr-sub">' + esc(members[k] || 'Bấm để chọn một mô hình') + '</div></div>' +
          (members[k] ? '<span class="t-pill gray">' + esc(String(members[k]).split('/').pop().slice(0, 14)) + '</span>'
                      : '<span class="tr-go">' + window.iconHtml('chevron') + '</span>') + '</div>').join('') + '</div>' +
        '<div class="t-bar" style="margin-top:var(--sp-4)"><button class="t-btn pri" data-save>Lưu</button>' +
        '<button class="t-btn" data-act>' + (set.name === (window.__activeSet || '') ? 'Đang dùng ảnh' : 'Bật nhóm này') + '</button></div>' +
        (set.id ? '<div class="t-bar"><button class="t-btn dan" data-del>Xóa nhóm này</button></div>' : '');
      $$('[data-p]', host).forEach((r) => {
        r.onclick = async () => {
          hap();
          const cur = members[r.dataset.p] || '';
          const picked = await pickModel('Chọn mô hình cho «' + PURPOSE_NAME[r.dataset.p] + '»', cur, lib);
          if (picked === null) return;
          if (picked === '') delete members[r.dataset.p]; else members[r.dataset.p] = picked;
          paintSet();
        };
      });
      $('[data-save]', host).onclick = async () => {
        try {
          const r = await window.API.modelSetSave(set.name, members, draft.note);
          set.id = (r && r.detail && r.detail.id) || set.id || 1; set.keys = Object.assign({}, members);
          toast('Đã lưu'); hap(); paintSet();
        } catch (e) { toast('Không lưu được: ' + e.message); }
      };
      $('[data-act]', host).onclick = async () => {
        try {
          const d = await window.API.modelSets();
          window.__activeSet = (d && d.active) || '';
          if (window.__activeSet === set.name) { await window.API.modelSetActivate(''); toast('Đã tắt'); }
          else { await window.API.modelSetActivate(set.name); toast('Đã bật: ' + set.name); }
          hap(); paintSet();
        } catch (e) { toast('Không bật được: ' + e.message); }
      };
      const del = $('[data-del]', host);
      if (del) del.onclick = async () => {
        if (!(await confirmBox('Xóa nhóm mô hình «' + set.name + '»? ', true))) return;
        try { await window.API.modelSetDelete(set.name); toast('Đã xóa'); back(); }
        catch (e) { toast('Không xóa được: ' + e.message); }
      };
    };
    try { const d = await window.API.modelSets(); window.__activeSet = (d && d.active) || ''; } catch (e) {}
    paintSet();
  }

  /* 挑模型：从真实模型库里选（key 就是「组名/模型id」，模型组存的就是它） */
  function pickModel(title, current, lib) {
    return new Promise((res) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; res(v); };
      App.sheet('<div class="sheet-head"><h3>' + esc(title) + '</h3><button class="btn sm" data-close>Đóng</button></div>' +
        '<div class="t-field" style="margin:0 var(--sp-4) var(--sp-3);background:var(--card)">' +
        '<input class="t-input" id="pm-q" type="search" placeholder="Tìm tên mô hình, ví dụ gemini / deepseek"></div>' +
        '<div class="pk-list"><div class="t-list" id="pm-list"></div></div>');
      const panel = document.getElementById('sheet-panel');
      panel.addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) finish(null);
      });
      const list = $('#pm-list', panel);
      const drawPm = (kw) => {
        const hit = lib.filter((m) => !kw || (m.name + ' ' + m.key).toLowerCase().indexOf(kw.toLowerCase()) >= 0).slice(0, 80);
        list.innerHTML = (current ? '<div class="t-row" data-k="" data-clear="1">' + ico('close') +
          '<div class="tr-main"><div class="tr-title">Không chỉ định</div><div class="tr-sub">Mục đích này theo lớp dưới</div></div></div>' : '') +
          (hit.length ? hit.map((m) => '<div class="t-row" data-k="' + esc(m.key) + '">' + ico('cpu') +
            '<div class="tr-main"><div class="tr-title">' + esc(m.name || m.key) + '</div>' +
            '<div class="tr-sub">' + esc([m.provider, m.key].filter(Boolean).join(' · ')) + '</div></div>' +
            (m.key === current ? '<span class="t-pill ok">Hiện tại</span>' : '') + '</div>').join('')
            : emptyHtml('Không tìm thấy', 'Thử từ khác.', 'cpu'));
        $$('[data-k]', list).forEach((r) => {
          r.onclick = () => { hap(); App.closeSheet(); finish(r.dataset.clear ? '' : r.dataset.k); };
        });
      };
      drawPm('');
      $('#pm-q', panel).addEventListener('input', (e) => drawPm(e.target.value.trim()));
    });
  }

  /* ── 后台任务：盯着跑，进度和每一步的结果都摊开 ── */
  function watchJob(jid, onTick, onDone) {
    let stop = false;
    App.keepAlive && App.keepAlive(true);
    const tick = async () => {
      if (stop) return;
      let d = null, err = null;
      try { d = await window.API.jobDetail(jid); } catch (e) { err = e; }
      if (err) { stop = true; App.keepAlive && App.keepAlive(false); onDone && onDone(null, err); return; }
      onTick && onTick(d);
      if (d && ['done', 'failed', 'canceled'].indexOf(d.status) >= 0) {
        stop = true; App.keepAlive && App.keepAlive(false); onDone && onDone(d); return;
      }
      // 暂停时不用那么勤地问（省电），继续跑起来再回到 1.5 秒一问
      setTimeout(tick, d && d.status === 'paused' ? 4000 : 1500);
    };
    tick();
    return () => { stop = true; App.keepAlive && App.keepAlive(false); };
  }

  /* 把一条后台任务的进度画在一块区域里（流水线、批量都用它）。
     按钮自己就能用：暂停 / 继续 / 停 / 刷新，都在这里接好，省得每个面板各接一遍。 */
  function paintJob(box, d, opts) {
    opts = opts || {};
    const st = (d && d.status) || 'running';
    const name = { running: 'Đang chạy', paused: 'Tạm dừng', done: 'Chạy xong', failed: 'Có chỗ bị lỗi',
                   canceled: 'Đã dừng' }[st] || st;
    const steps = (d && d.steps) || [];
    const jid = (d && d.jobId) || opts.jobId || '';
    box.innerHTML =
      '<h2 class="st-h">' + esc((d && d.title) || 'Tác vụ nền') + '</h2>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-2)">' + esc(name) + ' · ' + (d ? d.progress : 0) + '%</div>' +
      '<div class="t-bar"><button class="t-btn" data-refresh>Làm mới</button>' +
      (st === 'running' ? '<button class="t-btn" data-pause>Tạm dừng</button>' : '') +
      (st === 'paused' ? '<button class="t-btn" data-resume>Tiếp tục</button>' : '') +
      (st === 'running' || st === 'paused' ? '<button class="t-btn dan" data-stop>Dừng</button>' : '') + '</div>' +
      (steps.length ? '<div class="t-list">' + steps.map((x) => {
        const bad = !!x.error;
        const sub = bad ? x.error
          : [x.kind, x.words ? x.words + ' chữ' : '', x.issues != null ? 'Dính lỗi ' + x.issues : '',
             x.score != null ? 'Điểm ' + x.score : '', x.applied ? 'Đã ghi vào «Thay đổi»' : '',
             x.outlineId ? 'Dàn ý chi tiết chờ xác nhận' : ''].filter(Boolean).join(' · ');
        return '<div class="t-row static">' + ico(bad ? 'close' : 'check') +
          '<div class="tr-main"><div class="tr-title">' + esc(stepName(x.kind)) + ' · ' + esc(String(x.path || '').split('/').pop()) + '</div>' +
          '<div class="tr-sub wrap">' + esc(sub) + '</div></div></div>';
      }).join('') + '</div>' : '') +
      ((d && d.error) ? '<div class="t-hint" style="color:var(--danger)">' + esc(d.error) + '</div>' : '');
    const call = (act, word) => async () => {
      try {
        await nb('api/agent/jobs/' + jid + '/' + act, { method: 'POST', body: {} });
        toast(word); hap();
      } catch (e) { toast(word + ' không được: ' + e.message); }
      await repaint();
    };
    const repaint = async () => {
      if (opts.onTick) { opts.onTick(); return; }
      try { paintJob(box, await window.API.jobDetail(jid), opts); } catch (e) {}
    };
    const wire = (sel, fn) => { const b = $(sel, box); if (b) b.onclick = fn; };
    wire('[data-refresh]', repaint);
    wire('[data-pause]', call('pause', 'Đã tạm dừng'));
    wire('[data-resume]', call('resume', 'Chạy tiếp'));
    wire('[data-stop]', async () => {
      try { await nb('api/agent/jobs/' + jid + '/cancel', { method: 'POST', body: {} }); toast('Đã dừng'); }
      catch (e) { toast('Không tắt được: ' + e.message); }
      await repaint();
    });
    return box;
  }
  const stepName = (k) => ({ outline: 'Viết dàn ý chi tiết', write: 'Viết chính văn', continue: 'Viết tiếp', polish: 'Trau chuốt',
                             summary: 'Viết tóm tắt', lint: 'Soát lỗi' }[k] || k || 'Một bước');

  /* ── 同步冲突：两边都改过，让用户挑一版 ── */
  function conflictAsk(info) {
    return new Promise((res) => {
      const local = info.localText != null ? info.localText : (info.content || '');
      const server = info.serverText || '';
      const pick = (v) => { App.closeSheet(); res(v); };
      const block = (t) => '<div class="t-pre selectable" style="max-height:34vh;overflow:auto">' + esc(t || '(trống)') + '</div>';
      App.sheet(
        '<div class="sheet-head"><h3>Chương này bị sửa ở cả hai bên</h3><button class="btn sm" data-close>Đóng</button></div>' +
        '<div style="padding:0 var(--sp-4) calc(var(--safe-b) + var(--sp-4))">' +
        '<div class="t-hint" style="margin:0 0 var(--sp-3)">Cả hai bản đều được giữ, bản thảo của bạn không bị động. Chọn một bản, ' +
        ' chọn xong vẫn có thể lấy lại bản kia trong «Thay đổi → Lịch sử».</div>' +
        '<h2 class="st-h">Bản của tôi (' + local.length + ' chữ)</h2>' + block(local) +
        '<h2 class="st-h">Bản trên máy chủ (' + server.length + ' chữ)</h2>' + block(server) +
        '<div class="t-bar" style="margin-top:var(--sp-4)"><button class="t-btn pri" data-my>Dùng bản của tôi</button>' +
        '<button class="t-btn" data-sv>Dùng bản máy chủ</button></div>' +
        '<div class="t-bar"><button class="t-btn" data-merge>Tôi tự gộp một bản</button></div></div>');
      const panel = document.getElementById('sheet-panel');
      panel.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) res(null); });
      $('[data-my]', panel).onclick = () => pick('local');
      $('[data-sv]', panel).onclick = () => pick('server');
      $('[data-merge]', panel).onclick = async () => {
        const text = await ask('Chính văn sau khi gộp (đã điền sẵn bản máy chủ, sửa xong rồi lưu)', server,
                               { multiline: true, host: panel });
        if (text === null) return;
        App.sheet('<div class="sheet-head"><h3>Chương này bị sửa ở cả hai bên</h3><button class="btn sm" data-close>Đóng</button></div>' +
          '<div style="padding:0 var(--sp-4) var(--sp-5)"><div class="t-hint">Bản gộp này sẽ được lưu vào.</div>' +
          block(text) + '<div class="t-bar" style="margin-top:var(--sp-3)"><button class="t-btn pri" data-ok>Lưu bản này</button></div></div>');
        const p2 = document.getElementById('sheet-panel');
        p2.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) res(null); });
        $('[data-ok]', p2).onclick = () => pick({ merged: text });
      };
    });
  }

  /* 把冲突处理的结果落到服务器上 */
  async function conflictResolve(info, choice) {
    if (!info || !info.id) return null;
    const body = { id: info.id };
    if (choice && choice.merged != null) { body.choice = 'merged'; body.text = choice.merged; }
    else body.choice = choice;
    return window.API.syncResolve(body);
  }

  /* ══════════════════════════════════════════════════════════
     5. 档案（预设人格）
     ══════════════════════════════════════════════════════════ */
  function openProfiles(host) { pushBook('Agent Hồ sơ', (h) => profilesView(h), { global: true }); }

  async function profilesView(host) {
    loading(host, 'Đang đọc hồ sơ…');
    let cat, bs;
    try { cat = await nb('api/agent/profiles/catalog'); }
    catch (e) { failed(host, 'Agent Hồ sơ', e, () => profilesView(host)); return; }
    try { bs = await nb('api/agent/profiles/build-status'); } catch (e) {}
    const list = Array.isArray(cat) ? cat : (cat.profiles || []);
    const state = {};
    ((bs && bs.profiles) || []).forEach((p) => { state[p.profileKey] = p; });
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">Hồ sơ quyết định vị trí này do ai đảm nhận: viết, cốt truyện, thiết lập mỗi bên có nhân cách và quyền hạn riêng.</div>' +
      '<div class="t-bar"><button class="t-btn" data-compile>Biên dịch lại tất cả</button></div>' +
      (list.length ? '' : emptyHtml('Chưa có hồ sơ khả dụng',
        'Hồ sơ dựng sẵn lẽ ra phải có; nếu không có cái nào, bấm «Biên dịch lại tất cả» ở trên.', 'briefcase')) +
      '<div class="t-list">' + list.map((p, i) => {
        const st = state[p.profileKey] || {};
        const bad = st.loadStatus && st.loadStatus !== 'loaded';
        return '<div class="t-row" data-i="' + i + '">' + ico('briefcase') +
          '<div class="tr-main"><div class="tr-title">' + esc(p.name || p.profileKey) + '</div>' +
          '<div class="tr-sub wrap">' + esc(p.description || p.fileName || '') + '</div></div>' +
          '<span class="t-pill ' + (bad ? 'warn' : 'gray') + '">' + esc(p.source === 'install' ? 'dựng sẵn' : (p.source || '')) + '</span></div>';
      }).join('') + '</div>';
    $$('[data-i]', host).forEach((r) => {
      r.onclick = () => { hap(); profileDetail(host, list[Number(r.dataset.i)]); };
    });
    $('[data-compile]', host).onclick = async () => {
      loading(host, 'Đang biên dịch…');
      try { await nb('api/agent/profiles/compile-all', { method: 'POST', body: {} }); toast('Biên dịch xong'); hap(); profilesView(host); }
      catch (e) { toast('Biên dịch thất bại: ' + e.message); profilesView(host); }
    };
  }

  async function profileDetail(host, p) {
    loading(host, 'Đang đọc mã nguồn…');
    /* 这个接口要的是 fileName，不是 profileKey —— 传错会 400。 */
    let r = null, err = '';
    try { r = await nb('api/agent/profiles/source', { method: 'POST', body: { fileName: p.fileName } }); }
    catch (e) { err = e.message; }
    if (!r) { failed(host, 'Mã nguồn của hồ sơ này', { message: err }, () => profilesView(host)); return; }
    const tools = r.toolKeys || [];
    const c = r.catalogItem || {};
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-1)">' + esc(p.name || p.profileKey) + ' · ' + esc(p.fileName || '') + '</div>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">' + esc(c.description || p.description || '') + '</div>' +
      (tools.length ? '<h2 style="font:600 var(--t-md)/1 var(--ui-font);color:var(--ink-3);margin:0 var(--sp-1) var(--sp-2)">Các công cụ nó sẽ dùng ' + tools.length + '</h2>' +
        '<div class="t-chips">' + tools.map((t) => '<span class="t-pill gray">' + esc(t) + '</span>').join('') + '</div>' : '') +
      '<h2 style="font:600 var(--t-md)/1 var(--ui-font);color:var(--ink-3);margin:var(--sp-4) var(--sp-1) var(--sp-2)">Mã nguồn</h2>' +
      '<div class="t-pre">' + esc((r.source || '').slice(0, 8000)) + '</div>';
  }

  /* ══════════════════════════════════════════════════════════
     6. 技能
     ══════════════════════════════════════════════════════════ */
  function openSkills(host) { pushBook('Kỹ năng', (h) => skillsView(h), { global: true }); }

  async function skillsView(host) {
    loading(host, 'Đang đọc kỹ năng…');
    let list;
    try { list = await nb('api/agent/skills'); }
    catch (e) { failed(host, 'Danh sách kỹ năng', e, () => skillsView(host)); return; }
    list = Array.isArray(list) ? list : (list.skills || []);
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">Kỹ năng là sách hướng dẫn làm việc của AI: viết chính văn, tra thiết lập, đọc tệp đều dựa vào nó.</div>' +
      (list.length ? '' : emptyHtml('Chưa có kỹ năng',
        'Kỹ năng là sách hướng dẫn làm việc của AI, cài xong ở đây sẽ liệt kê ra.', 'spark')) +
      '<div class="t-list">' + list.map((s) => {
        const p = s.path || (s.skillPath || '');
        return '<div class="t-row' + (p ? '' : ' static') + '"' + (p ? ' data-p="' + esc(p) + '"' : '') + '>' +
          ico('spark') + '<div class="tr-main"><div class="tr-title">' + esc(s.name || p) + '</div>' +
          '<div class="tr-sub wrap">' + esc(s.description || '') + '</div></div></div>';
      }).join('') + '</div>';
    $$('[data-p]', host).forEach((r) => {
      r.onclick = async () => {
        hap();
        try {
          const d = await nb('api/workspace-files/read?' + qs({ workspaceKind: 'user-assets', path: r.dataset.p }));
          App.sheet('<div class="sheet-head"><h3>' + esc(r.dataset.p.split('/').pop()) + '</h3><button class="btn sm" data-close>Đóng</button></div>' +
            '<div style="padding:var(--sp-4)"><div class="t-pre" style="max-height:56vh">' + esc((d.content || '').slice(0, 8000)) + '</div></div>', { tall: true });
        } catch (e) { toast('Không đọc được: ' + e.message); }
      };
    });
  }

  /* ══════════════════════════════════════════════════════════
     7. 任务（后台跑着的活）
     ══════════════════════════════════════════════════════════ */
  function openJobs(host) { pushBook('Tác vụ nền', (h) => jobsView(h), { global: true }); }

  async function jobsView(host) {
    loading(host, 'Đang đọc tác vụ…');
    let d;
    try { d = await nb('api/agent/jobs'); }
    catch (e) { failed(host, 'Tác vụ nền', e, () => jobsView(host)); return; }
    const jobs = (d && d.jobs) || [];
    host.innerHTML =
      '<div class="t-bar"><button class="t-btn" data-clear>Xóa các mục đã xong</button><button class="t-btn" data-refresh>Làm mới</button></div>' +
      (jobs.length
        ? '<div class="t-list">' + jobs.map((j, i) =>
          '<div class="t-row static">' + ico(j.status === 'running' ? 'clock' : (j.status === 'failed' ? 'close' : 'check')) +
          '<div class="tr-main"><div class="tr-title">' + esc(j.title || j.kind || j.jobId) + '</div>' +
          '<div class="tr-sub">' + esc([j.status, j.progress != null ? j.progress + '%' : '', j.updatedAt ? ago(j.updatedAt) : ''].filter(Boolean).join(' · ')) + '</div></div>' +
          (j.status === 'running' ? '<button class="t-btn sm dan" data-cancel="' + esc(j.jobId) + '">Dừng</button>' : '') + '</div>').join('') + '</div>'
        : emptyHtml('Không có tác vụ nào đang chạy',
          'AI làm việc nặng (biên dịch, xây lại trí nhớ) thì ở đây sẽ có động tĩnh.', 'clock'));
    $$('[data-cancel]', host).forEach((b) => {
      b.onclick = async () => {
        try { await nb('api/agent/jobs/' + b.dataset.cancel + '/cancel', { method: 'POST', body: {} }); toast('Đã dừng'); hap(); jobsView(host); }
        catch (e) { toast('Không tắt được: ' + e.message); }
      };
    });
    $('[data-clear]', host).onclick = async () => {
      try { await nb('api/agent/jobs/clear-finished', { method: 'POST', body: {} }); toast('Đã dọn xong'); jobsView(host); }
      catch (e) { toast('Không dọn được: ' + e.message); }
    };
    $('[data-refresh]', host).onclick = () => jobsView(host);
  }

  /* ══════════════════════════════════════════════════════════
     8. 改动（AI 改过的文件，能收能退）
     ══════════════════════════════════════════════════════════ */
  function openHistory(host) { pushBook('Thay đổi', (h, slug) => historyView(h, slug), {}); }

  async function historyView(host, slug) {
    loading(host, 'Đang đọc thay đổi…');
    let d;
    try { d = await nb('api/workspace-history/inbox?' + qs({ projectRoot: slug })); }
    catch (e) { failed(host, 'Danh sách thay đổi', e, () => historyView(host, slug)); return; }
    const groups = (d && d.groups) || [];
    host.innerHTML =
      (groups.length ? '' : emptyHtml('Không có thay đổi chờ xử lý',
        'AI động vào tệp xong sẽ liệt kê ở đây, đồng ý hay hoàn lại đều do bạn quyết.', 'save')) +
      '<div class="t-list">' + groups.map((g, i) => {
        const n = (g.entries || []).length;
        return '<div class="t-row" data-i="' + i + '">' + ico('history') +
          '<div class="tr-main"><div class="tr-title">' + esc(g.path) + '</div>' +
          '<div class="tr-sub">' + n + ' chỗ thay đổi · ' + esc((g.entries && g.entries[0] && g.entries[0].actorKind) || '') + '</div></div>' +
          '<span class="tr-go">' + window.iconHtml('chevron') + '</span></div>';
      }).join('') + '</div>' +
      (groups.length ? '<div class="t-bar"><button class="t-btn pri" data-all>Chấp nhận tất cả</button></div>' : '');
    $$('[data-i]', host).forEach((r) => {
      r.onclick = () => { hap(); diffView(host, slug, groups[Number(r.dataset.i)]); };
    });
    const all = $('[data-all]', host);
    if (all) all.onclick = async () => {
      if (!(await confirmBox('Chấp nhận toàn bộ thay đổi của ' + groups.length + ' tệp?'))) return;
      try { await nb('api/workspace-history/accept-all', { method: 'POST', body: { projectRoot: slug } }); toast('Đã nhận hết'); hap(); historyView(host, slug); }
      catch (e) { toast('Không thu được: ' + e.message); }
    };
  }

  async function diffView(host, slug, g) {
    loading(host, 'Đang đọc khác biệt…');
    let d = null;
    try { d = await nb('api/workspace-history/diff?' + qs({ projectRoot: slug, path: g.path })); } catch (e) {}
    const raw = d ? (d.diff || d.patch || d.text || JSON.stringify(d, null, 2)) : '(Không đọc được nội dung khác biệt)';
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">' + esc(g.path) + '</div>' +
      '<div class="t-pre">' + esc(String(raw).slice(0, 8000)) + '</div>' +
      '<div class="t-list">' + (g.entries || []).map((en) =>
        '<div class="t-row static">' + ico('dot') + '<div class="tr-main"><div class="tr-title">#' + esc(en.id) + ' · ' + esc(en.actorKind || '') + '</div>' +
        '<div class="tr-sub">' + esc(ago(en.occurredAt)) + '</div></div></div>').join('') + '</div>' +
      '<div class="t-bar">' +
      '<button class="t-btn pri" data-acc>Chấp nhận</button>' +
      '<button class="t-btn dan" data-rev>Hoàn lại</button>' +
      '</div>';
    $('[data-acc]', host).onclick = async () => {
      try { await nb('api/workspace-history/accept', { method: 'POST', body: { projectRoot: slug, path: g.path, revision: g.revision } }); toast('Đã thu'); hap(); historyView(host, slug); }
      catch (e) { toast('Không thu được: ' + e.message); }
    };
    $('[data-rev]', host).onclick = async () => {
      if (!(await confirmBox('Hoàn tệp này về trước khi thay đổi?', true))) return;
      try { await nb('api/workspace-history/revert', { method: 'POST', body: { projectRoot: slug, path: g.path, revision: g.revision } }); toast('Đã hoàn lại'); hap(); historyView(host, slug); }
      catch (e) { toast('Không hoàn lại được: ' + e.message); }
    };
  }

  /* ══════════════════════════════════════════════════════════
     8.5 笔记：读书时想到什么就记下来（可带摘录），跟书签分工
     ══════════════════════════════════════════════════════════ */
  function openNotes(host) {
    pushBook('Ghi chú', (h, slug) => notesView(h, slug), {});
  }

  async function notesView(host, slug, q) {
    if (q === undefined) q = '';
    loading(host, 'Đang đọc ghi chú…');
    let d;
    try { d = await window.API.notes(slug, q); }
    catch (e) { failed(host, 'Ghi chú', e, () => notesView(host, slug, q)); return; }
    const items = (d && d.items) || [];
    host.innerHTML =
      '<div class="t-bar"><button class="t-btn pri" data-new>Viết một mục</button>' +
      '<button class="t-btn" data-reload>Làm mới</button></div>' +
      '<div class="t-field" style="background:var(--card);border:1px solid var(--line-2);' +
      'border-radius:var(--radius);padding:12px 12px;margin-bottom:12px">' +
      '<input class="t-input" data-q type="search" placeholder="Tìm ghi chú (nội dung, trích đoạn, tên chương đều được)" value="' + esc(q) + '"></div>' +
      '<div class="t-hint" style="margin:calc(-1 * var(--sp-1)) 0 var(--sp-3)">Tổng ' + ((d && d.total) || 0) + ' mục ' +
      (q ? ' (tìm «' + esc(q) + '»)' : '') + '. Ghi chú đi theo sách, đổi thiết bị vẫn còn.</div>' +
      (items.length
        ? '<div class="t-list">' + items.map((n, i) =>
          '<div class="t-row" data-i="' + i + '">' + ico('note') +
          '<div class="tr-main"><div class="tr-title">' + esc((n.text || '').slice(0, 40) || '(chỉ có trích đoạn)') + '</div>' +
          '<div class="tr-sub wrap">' + esc([String(n.path || '').split('/').pop(), n.quote ? '«' + n.quote.slice(0, 24) + '»' : '', ago(n.createdAt)].filter(Boolean).join(' · ')) + '</div></div>' +
          '<span class="tr-go">' + window.iconHtml('chevron') + '</span></div>').join('') + '</div>'
        : (q ? emptyHtml('Không tìm thấy ghi chú', 'Thử từ khác, hoặc xóa ô tìm kiếm để xem tất cả.', 'note')
          : emptyHtml('Chưa có ghi chú', 'Khi đọc chính văn, chọn một đoạn là lưu được một mục, bấm «Viết một mục» cũng được.', 'note'))) +
      '<div data-item></div>';

    const itemBox = $('[data-item]', host);
    $$('[data-i]', host).forEach((r) => {
      r.onclick = () => { hap(); noteDetail(itemBox, slug, items[Number(r.dataset.i)]); };
    });
    $('[data-new]', host).onclick = async () => {
      const text = await ask('Ghi chú nhanh', '', { multiline: true, placeholder: 'Bạn nghĩ ra gì?', host: host });
      if (text === null) return;
      try { await window.API.noteSave({ slug: slug, text: text }); toast('Đã ghi lại'); hap(); notesView(host, slug, q); }
      catch (e) { toast('Không ghi được: ' + e.message); }
    };
    $('[data-reload]', host).onclick = () => notesView(host, slug, q);
    let timer = null;
    $('[data-q]', host).addEventListener('input', (e) => {
      clearTimeout(timer);
      const v = e.target.value.trim();
      timer = setTimeout(() => notesView(host, slug, v), 320);
    });
  }

  function noteDetail(box, slug, n) {
    box.innerHTML =
      '<div class="t-list" style="margin-top:var(--sp-4)">' +
      '<div class="t-row static"><div class="tr-main"><div class="tr-title">Mục này</div>' +
      '<div class="tr-sub wrap">' + esc([String(n.path || '').split('/').pop() || 'Không gắn chương cụ thể', ago(n.createdAt)].filter(Boolean).join(' · ')) + '</div></div></div></div>' +
      (n.quote ? '<h2 class="st-h">Trích đoạn</h2><div class="t-pre">' + esc(n.quote) + '</div>' : '') +
      '<h2 class="st-h">Tôi viết</h2><div class="t-pre selectable">' + esc(n.text || '(trống)') + '</div>' +
      '<div class="t-bar"><button class="t-btn" data-edit>Đổi</button>' +
      '<button class="t-btn dan" data-del>Xóa</button></div>';
    $('[data-edit]', box).onclick = async () => {
      const t = await ask('Sửa ghi chú này', n.text || '', { multiline: true, host: box });
      if (t === null) return;
      try { await window.API.noteSave({ slug: slug, id: n.id, text: t }); toast('Đã sửa xong'); hap(); box.innerHTML = ''; App.show('tool'); }
      catch (e) { toast('Không đổi được: ' + e.message); }
    };
    $('[data-del]', box).onclick = async () => {
      if (!(await confirmBox('Xóa ghi chú này? (sẽ giữ một bản trong thư mục dữ liệu trước)', true))) return;
      try { await window.API.noteDelete(slug, n.id); toast('Đã xóa'); hap(); box.innerHTML = ''; App.show('tool'); }
      catch (e) { toast('Không xóa được: ' + e.message); }
    };
  }

  /* ══════════════════════════════════════════════════════════
     8.6 同步：离线攒下的改动推回来 + 两边都改过的挑一版
     ══════════════════════════════════════════════════════════ */
  function openSync(host) { pushBook('Đồng bộ', (h) => syncView(h), { global: true }); }

  /* ── 跟服务器对账（GOAL C2）──────────────────────────────────────────────
     位置很要紧：App 把整份后端装在手机里，所以"跟服务器同步"是**手机上的后端**去跟服务器说话，
     前端只需要点一个按钮。口令只在这条请求里传一次，**不写进任何文件**（只记地址，方便下次少打几个字）。 */
  function wirePeer(host) {
    const box = $('[data-peer]', host);
    if (!box) return;
    const baseEl = $('[data-peer-base]', host);
    const passEl = $('[data-peer-pass]', host);
    const bookEl = $('[data-peer-book]', host);
    const tipEl = $('[data-peer-tip]', host);
    baseEl.value = Prefs.get('peerBase') || '';
    /* 边打边记：换了书面板会重渲染，不记的话刚打进去的地址会被抹掉（真踩过） */
    baseEl.oninput = () => Prefs.set('peerBase', baseEl.value.trim());
    passEl.value = _peerPass;
    passEl.oninput = () => { _peerPass = passEl.value; };
    const say = (t, kind) => { tipEl.textContent = t; tipEl.style.color = kind === 'bad' ? 'var(--danger)' : 'var(--ink-3)'; };
    const run = async (direction) => {
      const base = (baseEl.value || '').trim();
      if (!base) { say('Hãy điền địa chỉ máy chủ trước (ví dụ 192.168.1.9:8899)', 'bad'); hap(); return; }
      Prefs.set('peerBase', base);
      say('Đang đối chiếu với máy chủ…');
      try {
        const d = await window.API.peerSync({
          slug: bookEl.value, base, password: passEl.value || '', direction });
        const pull = d.pull || {}, push = d.push || {};
        const bits = [];
        if (pull.pulled) bits.push('Đã kéo ' + pull.pulled + ' chương');
        if (push.pushed) bits.push('Đã đẩy ' + push.pushed + ' chương');
        if (pull.conflicts) bits.push(pull.conflicts + ' xung đột (kéo)');
        if (push.conflicts) bits.push(push.conflicts + ' xung đột (đẩy)');
        say(bits.length ? 'Xong: ' + bits.join(', ') : 'Không có gì cần đổi, hai bên giống nhau',
            d.conflicts ? 'bad' : '');
        hap();
        syncView(host);
      } catch (e) {
        say('Không đồng bộ được: ' + (e.message || e), 'bad');
      }
    };
    $('[data-peer-pull]', host).onclick = () => run('pull');
    $('[data-peer-push]', host).onclick = () => run('push');
    $('[data-peer-both]', host).onclick = () => run('both');
  }


  /* 「手机上还没有这本书」也能同步：问一句书名/书号 → 本机后端照服务器那本建一本再拉。
     这条是**新手机第一次用**的正路（本地下拉框里当然没有它），所以必须走这个入口。 */
  async function pullNew(host) {
    const name = await ask('Kéo một cuốn mới từ máy chủ', '', { ok: 'Kéo về', placeholder: 'Tên sách, hoặc mã sách trên máy chủ' });
    if (!name || !name.trim()) { syncView(host); return; }
    const baseEl = $('[data-peer-base]', host);
    const tipEl = $('[data-peer-tip]', host);
    const say = (t, bad) => { if (tipEl) { tipEl.textContent = t; tipEl.style.color = bad ? 'var(--danger)' : 'var(--ink-3)'; } };
    if (!baseEl || !(baseEl.value || '').trim()) { say('Hãy điền địa chỉ máy chủ trước (ví dụ 192.168.1.9:8899)', 1); hap(); return; }
    say('Đang tìm cuốn sách này trên máy chủ…');
    try {
      const d = await window.API.peerSync({
        slug: name.trim(), base: baseEl.value.trim(),
        password: ($('[data-peer-pass]', host) || {}).value || '', direction: 'pull' });
      Prefs.set('peerBook', d.slug);
      const pl = d.pull || {};
      /* 提示用 toast（面板马上会重渲染，写在提示行里会被"上次同步：…"覆盖掉，
         用户就看不到"到底拉下来没有"） */
      toast('Đã kéo «' + name.trim() + '» về máy ' + ((pl.pulled || 0) ? ': ' + pl.pulled + ' chương' : ''));
      hap(); syncView(host);
    } catch (e) {
      say('Không đồng bộ được: ' + (e.message || e), 1);
    }
  }

  async function syncView(host) {
    loading(host, 'Đang xem trạng thái đồng bộ…');
    let st = { openConflicts: 0 }, items = [];
    let pending = window.Offline ? Offline.pendingWrites() : [];
    try {
      const d = await window.API.syncConflicts('');
      items = (d && d.items) || [];
      st = { openConflicts: (d && d.total) || 0 };
    } catch (e) { failed(host, 'Xung đột ngoại tuyến', e, () => syncView(host)); return; }
    /* 书目下拉：跟服务器对账是**按书**来的 */
    let books = [];
    try { books = await projects(true); } catch (e) { books = []; }
    const curBook = Prefs.get('peerBook') || (books[0] && books[0].projectRoot) || '';
    let peer = { last_time: 0, last_result: '' };
    if (curBook) { try { peer = await window.API.peerState(curBook); } catch (e) {} }
    const peerWhen = peer.last_time
      ? new Date(peer.last_time).toLocaleString('vi-VN', { hour12: false }).slice(5, 16) : '';
    host.innerHTML =
      '<h2 class="st-h">Đối chiếu với máy chủ</h2>' +
      '<div class="t-field" data-peer>' +
        '<input class="t-input" data-peer-base type="text" placeholder="Địa chỉ máy chủ, ví dụ 192.168.1.9:8899">' +
        '<input class="t-input" data-peer-pass type="password" placeholder="Mật khẩu đăng nhập máy chủ (chỉ dùng cho lần yêu cầu này, không lưu)">' +
        '<select class="t-input" data-peer-book>' + (books.length
          ? books.map((b) => '<option value="' + esc(b.projectRoot) + '"' +
              (b.projectRoot === curBook ? ' selected' : '') + '>' + esc(b.title) + '</option>').join('')
          : '<option value="">(Giá sách chưa có sách)</option>') +
          '<option value="__new__">+ Kéo một cuốn mới từ máy chủ…</option></select>' +
        '<div class="t-bar"><button class="t-btn pri" data-peer-both>Đối chiếu hai chiều</button>' +
        '<button class="t-btn" data-peer-pull>Chỉ kéo về</button>' +
        '<button class="t-btn" data-peer-push>Chỉ đẩy lên</button></div>' +
        '<div class="t-hint" data-peer-tip style="margin-top:var(--sp-2)">' +
          (peerWhen ? 'Lần đồng bộ trước: ' + esc(peerWhen) + ' · ' + esc(peer.last_result || '') : 'Chưa đồng bộ lần nào') +
        '</div>' +
      '</div>' +
      '<h2 class="st-h">Thay đổi tích trên máy</h2>' +
      '<div class="t-stats"><div class="t-stat"><b>' + st.openConflicts + '</b><span>Sửa ở cả hai bên</span></div>' +
      '<div class="t-stat"><b>' + pending.length + '</b><span>Chờ đẩy từ máy</span></div></div>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">Bản thảo sửa khi điện thoại không có mạng sẽ được lưu trên máy trước, ' +
      ' có mạng thì bấm «đẩy lên». Khi đẩy, nếu trên máy chủ cũng đã sửa, ở đây sẽ liệt kê để bạn chọn——' +
      '<b>cả hai bản đều được giữ, không chọn thay bạn</b>. </div>' +
      '<div class="t-bar"><button class="t-btn pri" data-push>Đẩy các thay đổi trên máy lên</button>' +
      '<button class="t-btn" data-refresh>Làm mới</button></div>' +
      (items.length
        ? '<h2 class="st-h">Xung đột chờ xử lý</h2><div class="t-list">' + items.map((c, i) =>
          '<div class="t-row" data-c="' + i + '">' + ico('history') +
          '<div class="tr-main"><div class="tr-title">' + esc(String(c.path || '').split('/').pop()) + '</div>' +
          '<div class="tr-sub">' + esc([c.slug, ago(c.createdAt), (c.localChars || 0) + ' chữ vs ' + (c.serverChars || 0) + ' chữ'].filter(Boolean).join(' · ')) + '</div></div>' +
          '<span class="t-pill warn">Chờ chọn</span></div>').join('') + '</div>'
        : emptyHtml('Không có xung đột chờ xử lý', 'Mọi thứ đã đồng bộ xong.', 'check'));
    $$('[data-c]', host).forEach((r) => {
      r.onclick = async () => {
        hap();
        const c = items[Number(r.dataset.c)];
        let full = c;
        try { full = await window.API.syncConflict(c.id); } catch (e) {}
        const info = { id: full.id, localText: full.localText, serverText: full.serverText };
        const choice = await window.Tools.Conflicts.ask(info);
        if (choice === null) return;
        try {
          await window.Tools.Conflicts.resolve(info, choice);
          toast('Đã chọn xong'); hap(); syncView(host);
        } catch (e) { toast('Không lưu được: ' + e.message); }
      };
    });
    $('[data-refresh]', host).onclick = () => { hap(); syncView(host); };
    const bookSel = $('[data-peer-book]', host);
    if (bookSel) bookSel.onchange = () => {
      hap();
      if (bookSel.value === '__new__') { pullNew(host); return; }
      Prefs.set('peerBook', bookSel.value); syncView(host);
    };
    wirePeer(host);
    $('[data-push]', host).onclick = async () => {
      const r = await pushPending();
      if (!r.total) { toast('Trên máy không có thay đổi nào đang chờ'); return; }
      toast('Đã đẩy lên ' + r.ok + ' mục ' + (r.conflicts ? ', ' + r.conflicts + ' mục cần bạn chọn một bản' : ''));
      hap(); syncView(host);
    };
  }

  /* 把本机攒下的改动推回服务器（联网时自动调一次，同步面板的按钮也调它）。
     冲突的**不推**：让后端留下两份，用户自己去同步面板挑。 */
  async function pushPending() {
    const list = window.Offline ? Offline.pendingWrites() : [];
    const byBook = {};
    list.forEach((x) => { (byBook[x.slug] = byBook[x.slug] || []).push(x); });
    let conflicts = 0, ok = 0, failed = 0;
    for (const slug of Object.keys(byBook)) {
      try {
        const d = await window.API.syncPush(slug, byBook[slug].map((x) => ({
          path: x.path, content: x.content, baseMtimeMs: x.baseMtimeMs })));
        (d.results || []).forEach((r) => {
          if (r.status === 'conflict') conflicts++;
          else if (r.status === 'ok' || r.status === 'unchanged') {
            ok++; window.Offline.dropWrite(slug, r.path);
          } else failed++;
        });
      } catch (e) { failed++; }
    }
    return { ok: ok, conflicts: conflicts, failed: failed, total: list.length };
  }

  /* ══════════════════════════════════════════════════════════
     9. 备份
     ══════════════════════════════════════════════════════════ */
  function openBackup(host) { pushBook('Sao lưu', (h) => backupView(h), { global: true }); }

  async function backupView(host) {
    loading(host, 'Đang đọc sao lưu…');
    let st, keys = null, list = null, keysErr = null, listErr = null;
    /* 主状态读不到就是真出错（以前三处都吞掉 → 面板会装成"还没关联"，那是假象） */
    try { st = await nb('api/passport/status'); }
    catch (e) { failed(host, 'Trạng thái sao lưu', e, () => backupView(host)); return; }
    /* 这两处以前也是**吞掉错误**：读不到密钥就说"还没有"、读不到备份就整段不显示 ——
       用户看到的是"我没有备份"，真相是"没读到"。分开：读不到就说出错 + 重试。 */
    try { keys = await nb('api/passport/backup-keys'); } catch (e) { keysErr = e; }
    try { list = await nb('api/passport/backups'); } catch (e) { listErr = e; }
    const ks = (keys && keys.keys) || [];
    const items = (list && (list.backups || list.items)) || [];
    host.innerHTML =
      '<div class="t-list">' +
      '<div class="t-row static">' + ico('link') + '<div class="tr-main"><div class="tr-title">Tài khoản đám mây</div>' +
      '<div class="tr-sub">' + (st.linked ? 'Đã liên kết' : 'Chưa liên kết') + '</div></div>' +
      '<span class="t-pill ' + (st.linked ? 'ok' : 'gray') + '">' + (st.linked ? 'Đã kết nối' : 'Chưa kết nối') + '</span></div>' +
      '<div class="t-row static">' + ico('key') + '<div class="tr-main"><div class="tr-title">Khóa sao lưu</div>' +
      '<div class="tr-sub">' + (keysErr ? 'Không đọc được' : (ks.length ? ks.length + ' khóa' : 'Chưa có')) + '</div></div>' +
      '<span class="t-pill ' + (keysErr ? 'warn' : (ks.length ? 'ok' : 'gray')) + '">' +
      (keysErr ? 'Không đọc được' : (ks.length ? 'Sẵn sàng' : 'Chưa xác định')) + '</span></div>' +
      '</div>' +
      (st.linked ? '' : '<div class="t-hint" style="margin:0 0 var(--sp-3)">Muốn sao lưu, trước hết phải liên kết tài khoản của phần mềm viết truyện này (làm một lần trong cài đặt trên máy tính là được). Trước khi liên kết, các nút ở đây sẽ nhắc bạn đi liên kết.</div>') +
      '<h2 style="font:600 var(--t-md)/1 var(--ui-font);color:var(--ink-3);margin:var(--sp-3) var(--sp-1) var(--sp-2)">Các bản sao lưu</h2>' +
      '<div id="bk-hist"></div>' +
      '<div class="t-bar"><button class="t-btn pri" data-new>Sao lưu ngay một lần</button></div>';
    /* 历史备份这一段三种状态都要说人话：读不到（含重试）/ 还没有 / 有 */
    const hist = $('#bk-hist', host);
    if (listErr) failed(hist, 'Lịch sử sao lưu', listErr, () => backupView(host));
    else if (!items.length) empty(hist, 'Chưa có bản sao lưu nào', 'shield', 'Bấm «Sao lưu ngay một lần» bên dưới là có bản đầu tiên. Bản sao lưu nằm trong tài khoản đám mây, đổi thiết bị vẫn lấy lại được.');
    else {
      hist.innerHTML = '<div class="t-list">' + items.map((b, i) => '<div class="t-row static">' + ico('shield') +
        '<div class="tr-main"><div class="tr-title">' + esc(b.name || b.id || ('Sao lưu ' + (i + 1))) + '</div>' +
        '<div class="tr-sub">' + esc([b.createdAt ? ago(b.createdAt) : '', b.size ? bytes(b.size) : ''].filter(Boolean).join(' · ')) + '</div></div></div>').join('') + '</div>';
    }
    $('[data-new]', host).onclick = async () => {
      loading(host, 'Đang sao lưu…');
      try { await nb('api/passport/backups', { method: 'POST', body: {} }); toast('Đã sao lưu'); hap(); backupView(host); }
      catch (e) { toast('Không sao lưu được: ' + e.message); backupView(host); }
    };
  }

  /* ══════════════════════════════════════════════════════════
     10. 会话（跟 AI 的历史对话）
     ══════════════════════════════════════════════════════════ */
  function openSessions(host) { pushBook('Tất cả phiên', (h) => sessionsView(h), { global: true }); }

  let _sessQ = '';       // 会话检索词（进详情再回来还记得）

  async function sessionsView(host) {
    loading(host, 'Đang đọc phiên…');
    let d;
    try { d = await nb('api/agent/sessions?' + qs({ scope: 'all', limit: 60, q: _sessQ })); }
    catch (e) { failed(host, 'Danh sách phiên', e, () => sessionsView(host)); return; }
    const items = (d && d.items) || [];
    host.innerHTML =
      '<div class="t-bar" style="margin-bottom:var(--sp-3)"><button class="t-btn" data-traces>Xem dấu vết chạy</button>' +
      '<button class="t-btn" data-refresh>Làm mới</button></div>' +
      '<div class="t-field" style="background:var(--card);border:1px solid var(--line-2);border-radius:var(--radius);padding:var(--sp-3) var(--sp-3);margin-bottom:var(--sp-3)">' +
      '<input class="t-input" id="sess-q" type="search" placeholder="Tìm phiên: lời đã nói, tiêu đề đều được" value="' + esc(_sessQ) + '"></div>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">' +
      (_sessQ
        ? 'Tìm «' + esc(_sessQ) + '» thấy ' + items.length + ' phiên. Xóa ô tìm kiếm để về tất cả.'
        : 'Tổng cộng ' + ((d && d.total) || items.length) + ' phiên. Bấm vào để xem lúc đó nó đã làm gì.') +
      '</div>' +
      (items.length
        ? '<div class="t-list">' + items.map((s, i) =>
          '<div class="t-row" data-i="' + i + '">' + ico('chat') +
          '<div class="tr-main"><div class="tr-title">' + esc(s.title || ('Phiên ' + s.sessionId)) + '</div>' +
          '<div class="tr-sub' + (s.hit ? ' wrap' : '') + '">' + esc(s.hit ||
            [s.profileKey, s.currentProjectRoot ? bookName(s.currentProjectRoot) : '', s.status,
             ago(s.updatedAt)].filter(Boolean).join(' · ')) + '</div></div>' +
          '<span class="tr-go">' + window.iconHtml('chevron') + '</span></div>').join('') + '</div>'
        : emptyHtml('Không tìm thấy', 'Thử từ khác, hoặc xóa ô tìm kiếm để xem tất cả phiên.', 'chat'));
    $$('[data-i]', host).forEach((r) => {
      r.onclick = () => { hap(); sessionDetail(host, items[Number(r.dataset.i)]); };
    });
    const qi = $('#sess-q', host);
    if (qi) {
      let timer = null;
      const run = () => {
        _sessQ = qi.value.trim();
        const spot = document.getElementById('tool-body');
        if (spot) spot.scrollTop = 0;
        sessionsView(host);
      };
      qi.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 320); });
      qi.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); run(); } });
    }
    const tb = $('[data-traces]', host);
    if (tb) tb.onclick = () => { hap(); tracesView(host); };
    const rb = $('[data-refresh]', host);
    if (rb) rb.onclick = () => sessionsView(host);
  }

  /* 运行痕迹：AI 每一步干了什么、花了多久。排错时看。 */
  async function tracesView(host) {
    loading(host, 'Đang đọc dấu vết…');
    let d;
    try { d = await nb('api/agent/traces/recent?' + qs({ limit: 80 })); }
    catch (e) { failed(host, 'Dấu vết chạy', e, () => tracesView(host)); return; }
    const items = (d && (d.items || d.traces || d.entries)) || [];
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">Gần đây ' + items.length + ' mục. Mỗi bước AI dùng mô hình nào, mất bao lâu, thành công hay không.</div>' +
      (items.length
        ? '<div class="t-list">' + items.map((t) => {
          const kind = (t.correlation && t.correlation.kind) || 'turn';
          const bad = t.stopReason && t.stopReason !== 'end_turn' && t.stopReason !== 'stop';
          const ms = t.durationMs != null ? (t.durationMs >= 1000 ? (t.durationMs / 1000).toFixed(1) + 's' : Math.round(t.durationMs) + 'ms') : '';
          const ttft = t.ttftMs != null ? 'Chữ đầu tiên ' + Math.round(t.ttftMs) + 'ms' : '';
          const tok = t.totalTokens != null ? t.totalTokens.toLocaleString() + ' token' : '';
          const kb = t.bytes != null ? (t.bytes / 1024).toFixed(0) + 'KB' : '';
          return '<div class="t-row static">' + ico(bad ? 'close' : 'check') +
            '<div class="tr-main"><div class="tr-title">' + esc((t.provider || '') + ' / ' + (t.model || '')) + '</div>' +
            '<div class="tr-sub wrap">' + esc([kind, ms, ttft, tok, kb, t.ts ? ago(t.ts) : ''].filter(Boolean).join(' · ')) + '</div></div></div>';
        }).join('') + '</div>'
        : emptyHtml('Chưa có dấu vết chạy', 'AI mỗi lần chạy một lượt đều để lại một mục ở đây.', 'clock'));
  }

  async function sessionDetail(host, s) {
    loading(host, 'Đang đọc phiên…');
    /* bookName() 靠作品表把 slug 翻成书名，这里先把表预热，否则会退化成显示 slug */
    try { await projects(); } catch (e) {}
    let d = null;
    try { d = await nb('api/agent/sessions/' + s.sessionId); } catch (e) {}
    /* 平台没有「把消息列出来」的接口：正文走 SSE 事件流（读不完，不能用在静态页），
       这里能拿到的是一份恢复快照。所以只报状态，正文引导回对话页看。 */
    const sm = (d && d.summary) || {};
    const rows = [
      ['Danh tính', sm.profileKey || s.profileKey || ''],
      ['Tiêu đề', sm.title || s.title || ''],
      ['Trạng thái', sm.status || s.status || ''],
      ['Hoạt động cuối', ago(sm.updatedAt || s.updatedAt)],
      ['Sách gắn kèm', (sm.currentProjectRoot || s.currentProjectRoot) ? bookName(sm.currentProjectRoot || s.currentProjectRoot) : ''],
      ['Đã lưu trữ', s.archived ? 'Có' : ''],
    ].filter((x) => x[1]);
    host.innerHTML =
      '<div class="t-list">' + rows.map(([k, v]) =>
        '<div class="t-row static"><div class="tr-main"><div class="tr-sub">' + esc(k) + '</div>' +
        '<div class="tr-title" style="font-weight:var(--w-normal)">' + esc(v) + '</div></div></div>').join('') + '</div>' +
      '<div class="t-hint" style="margin:var(--sp-4) 0 var(--sp-3)">Nội dung trò chuyện là một luồng thời gian thực, trên điện thoại không phát lại cả màn hình được. Muốn xem lúc đó đã nói gì, bấm bên dưới để quay về trang trò chuyện tiếp tục (ngữ cảnh vẫn còn).</div>' +
      '<div class="t-bar"><button class="t-btn pri" data-open>Quay về trang trò chuyện</button></div>';
    $('[data-open]', host).onclick = () => {
      stack.length = 0;
      App.show('chat');
      if (window.Chat && Chat.openSession) { try { Chat.openSession(s.sessionId); } catch (e) {} }
    };
  }

  /* ══════════════════════════════════════════════════════════
     11. 用户
     ══════════════════════════════════════════════════════════ */
  function openUsers(host) { pushBook('Tài khoản', (h) => usersView(h), { global: true }); }

  async function usersView(host) {
    loading(host, 'Đang đọc tài khoản…');
    let list, me;
    try { list = await nb('api/admin/users'); }
    catch (e) { failed(host, 'Danh sách tài khoản', e, () => usersView(host)); return; }
    try { me = await nb('api/auth/me'); } catch (e) {}
    list = Array.isArray(list) ? list : (list.users || []);
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">Đang đăng nhập bằng ' + esc((me && me.user && me.user.username) || '?') + '. </div>' +
      (list.length ? '' : emptyHtml('Chưa có tài khoản khác', 'Máy này hiện chỉ có mình bạn.', 'users')) +
      '<div class="t-list">' + list.map((u) =>
        '<div class="t-row static">' + ico('users') + '<div class="tr-main"><div class="tr-title">' + esc(u.displayName || u.username) + '</div>' +
        '<div class="tr-sub">' + esc([u.username, u.role, u.lastSeenAt ? 'Gần đây ' + ago(u.lastSeenAt) : ''].filter(Boolean).join(' · ')) + '</div></div>' +
        '<span class="t-pill ' + (u.status === 'active' ? 'ok' : 'gray') + '">' + esc(u.status || '') + '</span></div>').join('') + '</div>';
  }

  /* ══════════════════════════════════════════════════════════
     12. 关于：版本 / 日志
     ══════════════════════════════════════════════════════════ */
  function openAbout(host) { pushBook('Phiên bản và nhật ký', (h) => aboutView(h), { global: true }); }

  async function aboutView(host) {
    loading(host, 'Đang đọc phiên bản…');
    let v, lg;
    try { v = await nb('api/app/version'); }
    catch (e) { failed(host, 'Thông tin phiên bản', e, () => aboutView(host)); return; }
    let lgErr = null;
    try { lg = await nb('api/app/logs/status'); } catch (e) { lgErr = e; lg = {}; }
    const files = (lg && lg.files) || [];
    host.innerHTML =
      '<div class="t-list">' +
      '<div class="t-row static">' + ico('terminal') + '<div class="tr-main"><div class="tr-title">Phiên bản phần mềm viết truyện</div>' +
      '<div class="tr-sub wrap">' + esc(v.versionLabel || 'Không đọc được') + '</div></div></div>' +
      '<div class="t-row static">' + ico('file') + '<div class="tr-main"><div class="tr-title">Nhật ký</div>' +
      '<div class="tr-sub">' + (lgErr ? 'Không đọc được' : ((lg.fileCount || 0) + ' tệp · ' + bytes(lg.totalBytes))) +
      '</div></div></div>' +
      '</div>' +
      (v.githubUrl ? '<div class="t-hint" style="margin:0 0 var(--sp-3)">' + esc(v.githubUrl) + '</div>' : '') +
      '<div id="ab-logs"></div>' +
      '<div class="t-hint">App vỏ ngoài: phiên bản xem trong «Cài đặt». Nhật ký dùng để tìm lỗi, bình thường không cần xem.</div>';
    /* 日志这一段的三种状态：读不到（带重试）/ 还没有日志 / 有日志 */
    const lgBox = $('#ab-logs', host);
    if (lgErr) failed(lgBox, 'Danh sách nhật ký', lgErr, () => aboutView(host));
    else if (!files.length) empty(lgBox, 'Chưa có tệp nhật ký', 'file', 'Chương trình chạy và có lỗi thì mới ghi nhật ký. Bình thường trống là bình thường.');
    else {
      lgBox.innerHTML = '<div class="t-list">' + files.map((f) => '<div class="t-row static">' + ico('file') +
        '<div class="tr-main"><div class="tr-title">' + esc(f.name) + '</div>' +
        '<div class="tr-sub">' + bytes(f.size) + ' · ' + esc(ago(f.mtimeMs)) + '</div></div>' +
        '<button class="t-btn sm" data-dl="' + esc(f.name) + '">Tải về</button></div>').join('') + '</div>';
    }
    $$('[data-dl]', host).forEach((b) => {
      b.onclick = () => {
        const a = document.createElement('a');
        a.href = 'nb/api/app/logs/download?' + qs({ file: b.dataset.dl });
        a.download = b.dataset.dl;
        a.click();
      };
    });
  }

  /* ══════════════════════════════════════════════════════════
     宫格
     ══════════════════════════════════════════════════════════ */
  /* 卡片带 sec（分组名），谁往 TOOLS 里加卡片就归到哪一组。
     studio.js 那一批面板也走这里注册（Tools.add），不另外维护第二份宫格。 */
  const TOOLS = [
    { id: 'files', name: 'Tệp', sub: 'Mọi tệp', icon: 'folder', sec: 'Bản thảo', run: openFiles },
    { id: 'cover', name: 'Bìa sách', sub: 'Đổi bìa', icon: 'image', sec: 'Bản thảo', run: openCover },
    { id: 'notes', name: 'Ghi chú', sub: 'Trích ý tưởng', icon: 'note', sec: 'Bản thảo', run: openNotes },
    { id: 'memory', name: 'Trí nhớ', sub: 'AI nhớ những gì', icon: 'database', sec: 'AI', run: openMemory },
    { id: 'models', name: 'Mô hình', sub: 'Nhà cung cấp', icon: 'cpu', sec: 'AI', run: openModels },
    { id: 'profiles', name: 'Hồ sơ', sub: 'Ai đang làm việc', icon: 'briefcase', sec: 'AI', run: openProfiles },
    { id: 'skills', name: 'Kỹ năng', sub: 'AI biết làm gì', icon: 'spark', sec: 'AI', run: openSkills },
    { id: 'jobs', name: 'Tác vụ', sub: 'Đang chạy nền', icon: 'clock', sec: 'AI', run: openJobs },
    { id: 'history', name: 'Thay đổi', sub: 'Đã sửa gì', icon: 'history', sec: 'Hệ thống', run: openHistory },
    { id: 'backup', name: 'Sao lưu', sub: 'Lưu trữ', icon: 'shield', sec: 'Hệ thống', run: openBackup },
    { id: 'sync', name: 'Đồng bộ', sub: 'Xung đột ngoại tuyến', icon: 'refresh', sec: 'Hệ thống', run: openSync },
    { id: 'sessions', name: 'Phiên', sub: 'Lịch sử trò chuyện', icon: 'chat', sec: 'AI', run: openSessions },
    { id: 'users', name: 'Tài khoản', sub: 'Người dùng', icon: 'users', sec: 'Hệ thống', run: openUsers },
    { id: 'about', name: 'Giới thiệu', sub: 'Phiên bản · nhật ký', icon: 'terminal', sec: 'Hệ thống', run: openAbout },
  ];
  const SECTIONS = ['Bản thảo', 'Viết', 'AI', 'Hệ thống'];

  function renderGrid() {
    const body = document.getElementById('tools-body');
    if (!body) return;
    /* 回到宫格 = 回到工具区最底层：**把层级栈清空**。
       不清的话会留着一个"幽灵上一层"——用户从宫格点进新工具，再按返回，
       会落到**上一次那个工具**里（此前的反馈就是这个）。
       走底部页签离开工具区、再回来，也会经过这里，所以那条路一起修好了。 */
    stack.length = 0;
    /* 宫格顶上那条也是**全站一键切换**：在工具里也能一眼看到"在写哪本"、随手换。
       换完不重画宫格（宫格本身与书无关），但下面那批面板下次进来就是新书了。 */
    if (window.BookCtx) {
      BookCtx.mount('tools-book', null, { global: true });
    }
    const groups = SECTIONS.map((n) => [n, TOOLS.filter((t) => t.sec === n)]);
    groups.push(['Khác', TOOLS.filter((t) => SECTIONS.indexOf(t.sec) < 0)]);
    body.innerHTML = groups.filter(([, list]) => list.length).map(([n, list]) =>
      '<div class="tools-sec"><h2>' + n + '</h2><div class="tools-grid">' +
      list.map(card).join('') + '</div></div>').join('');
    $$('.tool-card', body).forEach((c) => {
      c.onclick = () => { hap(); openTool(c.dataset.id); };
    });
  }
  /* 进一个工具：**先把层级栈清空**，再进。
     这是**唯一**的入口（宫格点击、Tools.open、别处调用都走它）——
     以前宫格那条路直接 t.run()，栈是脏的，返回键就会退到别的工具里去。 */
  function openTool(id) {
    const t = TOOLS.find((x) => x.id === id);
    stack.length = 0;
    if (!t) return false;
    t.run(document.getElementById('tool-body'));
    return true;
  }

  const card = (t) => '<div class="tool-card" data-id="' + t.id + '">' +
    '<span class="tc-ico">' + window.iconHtml(t.icon) + '</span>' +
    '<span class="tc-name">' + t.name + '</span>' +
    '<span class="tc-sub">' + t.sub + '</span></div>';

  /* 返回上一级：先问顶层要不要自己消化（文件浏览器用它退一层目录），
     再退层级栈，退到底回宫格。总之一次只退一层。 */
  function back() {
    hap();
    const top = stack[stack.length - 1];
    if (top && typeof top.onBack === 'function' && top.onBack() === true) return;
    if (stack.length > 1) { stack.pop(); paint(); return; }
    stack.length = 0;
    App.show('tools');
  }

  /* ── 对外 ──
     ui 那一包是给 studio.js 那批新面板复用的：栈、loading、空态、问框、选书、
     时间格式化，全都只有这一份实现（以前冒出过第二套，见 base.css 里的水波纹批注）。 */
  window.Tools = {
    TOOLS,
    ui: { push, pushBook, paint, loading, empty, ask, confirmBox, projects, pickProject, curSlug, mountBook,
          ago, ts, bytes, back, bookName, paintJob, stepName },
    /* 冲突：写作台、文件编辑器、同步面板都走这一份实现 */
    Conflicts: { ask: conflictAsk, resolve: conflictResolve },
    Jobs: { watch: watchJob },
    /* 联网后自动把离线攒的改动推回去（App 里监听 online 调它） */
    pushPending: pushPending,
    /* 加/替换宫格卡片（studio.js 启动时调一次） */
    add(cards) {
      (cards || []).forEach((c) => {
        const i = TOOLS.findIndex((x) => x.id === c.id);
        if (i >= 0) TOOLS[i] = c; else TOOLS.push(c);
      });
      if (document.body.dataset.tab === 'tools') renderGrid();
    },
    onShow() {
      const cur = document.body.dataset.tab;
      if (cur === 'tools') renderGrid();
      else if (cur === 'tool') paint();
    },
    back,
    open: openTool,
  };
})();
