/* ============================================================
   studio.js — 新加的那一批「工作室」面板：写作台 / 世界 / 剧情 / 质检 /
   统计 / 导出导入 / 听书 / 主题 / 术语 / 素材 / 日志。

   三条自己给自己定的规矩（用户强调过，见 docs/10 第六节）：
   1. 只用 tools.css / base.css 里已有的通用件和 CSS 变量，不另造一套样式；
   2. 面板一律走 `Tools.ui.push()`（顶部有返回、返回键逐层退），
      需要输入就走 `Tools.ui.ask()`；不开第二套栈、不开第二个水波纹；
   3. 每个按钮点了必须有反馈，失败一定说出为什么（不许静默）。
   ============================================================ */
(function () {
  'use strict';

  /* 复用 tools.js 的那一套（栈、loading、empty、问框、项目选择…）——
     这里**不重新实现**，免得像以前那样冒出两套水波纹。 */
  const U = () => window.Tools && window.Tools.ui;
  const nb = (p, o) => window.API.nb(p, o);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const qs = (o) => Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const ico = (n) => '<span class="tr-ico">' + window.iconHtml(n) + '</span>';
  const toast = (m) => { try { App.toast(m); } catch (e) {} };
  const hap = () => { try { App.haptic(8); } catch (e) {} };
  const push = (t, r) => U().push(t, r);
  const loading = (h, m) => U().loading(h, m);
  const empty = (h, m, i) => U().empty(h, m, i);
  const ask = (...a) => U().ask(...a);
  const confirmBox = (...a) => U().confirmBox(...a);
  const projects = () => U().projects();
  const pickProject = (h, cb) => U().pickProject(h, cb);
  /* 当前书：跟书有关的面板都用这一条（tools.js 里唯一那份实现），别各自弹书单 */
  const Push = { book: (t, r, o) => U().pushBook(t, r, o), curSlug: () => U().curSlug() };
  const ago = (t) => U().ago(t);
  const ts = (t) => U().ts(t);

  /* ── 常用的请求小件 ── */
  const get = (p, q) => nb(p + (q ? '?' + qs(q) : ''));
  const post = (p, body, q) => nb(p + (q ? '?' + qs(q) : ''), { method: 'POST', body: body || {} });
  const del = (p, q) => nb(p + (q ? '?' + qs(q) : ''), { method: 'DELETE', body: {} });

  /* 质检章节列表的排序方式：false = 按章节号（默认），true = 按分数（最脏的在前） */
  let lintByScore = false;

  const money = (n) => (Math.round((Number(n) || 0) * 1000) / 1000).toString();
  const KIND_CN = { character: 'Nhân vật', place: 'Địa điểm', faction: 'Thế lực', item: 'Vật phẩm',
                    system: 'Hệ thống', concept: 'Khái niệm', creature: 'Sinh vật' };
  const STATUS_CN = { idea: 'Ý tưởng', outline: 'Dàn ý', detail: 'Dàn ý chi tiết', draft: 'Bản nháp',
                      polished: 'Trau chuốt', final: 'Bản chốt' };

  /* 章节选择：什么面板要挑章都走它 */
  function chapterPicker(host, slug, cb, opts) {
    opts = opts || {};
    loading(host, 'Đang đọc mục lục…');
    get('/api/book', { slug }).then((d) => {
      const chs = d.chapters || [];
      if (!chs.length) { empty(host, 'Cuốn này chưa có chương nào', 'file'); return; }
      host.innerHTML = '<div class="t-hint" style="margin:0 0 var(--sp-3)">'
        + esc(opts.hint || 'Bấm một chương để bắt đầu') + '</div><div class="t-list">' + chs.map((c, i) =>
          '<div class="t-row" data-i="' + i + '">' + ico('file') +
          '<div class="tr-main"><div class="tr-title">' + esc(c.name || c.path) + '</div>' +
          '<div class="tr-sub">' + esc((c.words || 0) + ' chữ') + '</div></div>' +
          '<span class="tr-go">' + window.iconHtml('chevron') + '</span></div>').join('') + '</div>';
      host.querySelectorAll('[data-i]').forEach((r) => {
        r.onclick = () => { hap(); cb(chs[Number(r.dataset.i)]); };
      });
    }).catch((e) => empty(host, 'Không đọc được mục lục: ' + e.message));
  }

  /* 流式写作：后端吐 SSE（data: {...}），这里边收边画 */
  async function streamWrite(path, body, on) {
    const r = await fetch(window.API.abs('api/write/' + path), {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    if (r.status === 401) { App.needLogin(); throw new Error('Chưa đăng nhập'); }
    if (!r.ok) {
      let msg = 'Yêu cầu thất bại ' + r.status;
      try { const d = await r.json(); msg = d.detail || msg; } catch (e) {}
      throw new Error(msg);
    }
    const rd = r.body.getReader(); const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        if (chunk.indexOf('data: ') !== 0) continue;
        let ev = null;
        try { ev = JSON.parse(chunk.slice(6)); } catch (e) { continue; }
        on(ev);
      }
    }
  }

  /* ══════════════════════════════════════════════════════════
     1. 写作台：生成 / 续写 / 改写 / 细纲 / 润色（设定自动注入）
     ══════════════════════════════════════════════════════════ */
  function openWrite(host) { Push.book('Bàn viết', writeHome); }

  async function writeHome(host, slug) {
    loading(host, 'Đang xem bàn viết…');
    let st, ov;
    try {
      st = await get('/api/write/status', { slug });
      ov = await get('/api/plot/overview', { slug });
    } catch (e) { empty(host, 'Không đọc được: ' + e.message); return; }
    const chs = ov.chapters || [];
    const done = chs.filter((c) => ['polished', 'final'].includes(c.status)).length;
    host.innerHTML =
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + (st.words || 0) + '</b><span>Tổng số chữ</span></div>' +
      '<div class="t-stat"><b>' + chs.length + '</b><span>Chương</span></div>' +
      '<div class="t-stat"><b>' + done + '</b><span>Đã trau chuốt/chốt</span></div>' +
      '</div>' +
      (st.ready ? '' :
        '<div class="t-form" style="margin-bottom:var(--sp-4)"><div class="t-field"><label>Chưa thể bắt đầu viết</label>' +
        '<div class="t-hint" style="margin:0">' + esc(st.why || 'Không có mô hình khả dụng') +
        ': vào «Công cụ → Mô hình» cấu hình một cái, hoặc chọn một mô hình trong «Preset».</div></div></div>') +
      '<div class="t-bar"><button class="t-btn" data-newch>Tạo chương mới</button>' +
      '<button class="t-btn" data-ctx>Nó sẽ đọc những gì</button></div>' +
      '<div class="t-bar"><button class="t-btn" data-batch>Hàng loạt</button>' +
      '<button class="t-btn" data-pipe>Dây chuyền</button>' +
      '<button class="t-btn" data-purposes>Dùng những mô hình nào</button></div>' +
      '<div class="t-list">' + (chs.length ? chs.map((c, i) =>
        '<div class="t-row" data-i="' + i + '">' + ico('file') +
        '<div class="tr-main"><div class="tr-title">' + esc(c.title || c.path) + '</div>' +
        '<div class="tr-sub">' + esc([(c.words || 0) + ' chữ',
          STATUS_CN[c.status] || c.status || 'Bản nháp',
          c.target_words ? ('Mục tiêu ' + c.target_words) : '',
          c.outline && c.outline.length ? (c.outline.length + ' ý dàn ý chi tiết') : 'Chưa có dàn ý chi tiết',
          (c.cast && c.cast.length) ? ('Xuất hiện ' + c.cast.length + ' người') : '',
          (c.events && c.events.length) ? (c.events.length + ' sự kiện chính') : '',
        ].filter(Boolean).join(' · ')) + '</div></div>' +
        '<span class="tr-go">' + window.iconHtml('chevron') + '</span></div>').join('')
        : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">Chưa có chương nào, bấm «Tạo chương mới» ở trên</div></div></div>') +
      '</div>';
    host.querySelectorAll('[data-i]').forEach((r) => {
      r.onclick = () => { hap(); const c = chs[Number(r.dataset.i)]; push('Viết · ' + (c.title || c.path), (h2) => chapterStudio(h2, slug, c)); };
    });
    host.querySelector('[data-newch]').onclick = async () => {
      let name = await ask('Chương mới tên là gì', '', { placeholder: 'VD: Chương 6 - Sau đêm tuyết' });
      if (!name) return;
      name = (window.VI && VI.chapterName ? VI.chapterName : function (x) { return x; })(name);
      const p = 'manuscript/' + name.replace(/[\/\\]/g, '_') + (name.endsWith('.md') ? '' : '.md');
      try { await post('/api/chapter/new', { slug, path: p, content: '' }); toast('Đã tạo xong'); hap(); writeHome(host, slug); }
      catch (e) { toast('Không tạo được: ' + e.message); }
    };
    host.querySelector('[data-ctx]').onclick = async () => {
      const path = st.lastChapter || '';
      if (!path) { toast('Viết một chương trước thì mới có ngữ cảnh để xem'); return; }
      push('Nó sẽ đọc những gì', (h2) => contextView(h2, slug, path));
    };
    host.querySelector('[data-batch]').onclick = () => { hap(); push('Hàng loạt', (h2) => batchView(h2, slug)); };
    host.querySelector('[data-pipe]').onclick = () => { hap(); push('Dây chuyền', (h2) => pipelineView(h2, slug)); };
    host.querySelector('[data-purposes]').onclick = () => {
      hap();
      const p = st.purposes || {};
      const rows = [['planner', 'Lên kế hoạch', 'Dàn ý chi tiết, dàn ý'], ['writer', 'Viết chính văn', 'Thực sự đặt bút'],
                    ['polish', 'Trau chuốt, viết lại', 'Trau chuốt, inline AI'], ['fast', 'Việc vặt', 'Tóm tắt, đặt tên']]
        .map(([k, n, h]) => '<div class="t-row static">' + ico('cpu') +
          '<div class="tr-main"><div class="tr-title">' + n + '</div>' +
          '<div class="tr-sub">' + esc(p[k] || 'Chưa cấu hình mô hình') + ' · ' + h + '</div></div></div>').join('');
      App.sheet('<div class="sheet-head"><h3>Lần này sẽ dùng những mô hình nào</h3>' +
        '<button class="btn sm" data-close>Đóng</button></div>' +
        '<div style="padding:0 var(--sp-4) calc(var(--safe-b) + var(--sp-4))">' +
        '<div class="t-hint" style="margin:0 0 var(--sp-3)">Muốn chia mô hình theo mục đích (lên kế hoạch dùng mô hình lớn, trau chuốt dùng loại rẻ), ' +
        ' vào «Công cụ → Mô hình → Nhóm mô hình» tạo một nhóm và bật lên.</div>' +
        '<div class="t-list">' + rows + '</div></div>');
    };
  }

  /* ══════════════════════════════════════════════════════════
     1.1 批量：一次处理多章（后台任务，进度和每一步结果都摊开）
     ══════════════════════════════════════════════════════════ */
  const BATCH_MODES = [['outline', 'Viết dàn ý chi tiết'], ['polish', 'Trau chuốt'], ['summary', 'Viết tóm tắt'],
                       ['chapter', 'Viết chính văn'], ['continue', 'Viết tiếp']];

  async function batchView(host, slug) {
    loading(host, 'Đang đọc mục lục…');
    let d;
    try { d = await get('/api/book', { slug }); } catch (e) { empty(host, 'Không đọc được: ' + e.message); return; }
    const chs = d.chapters || [];
    if (!chs.length) { empty(host, 'Cuốn này chưa có chương nào', 'file'); return; }
    let mode = 'outline';
    const sel = {};
    const paintBatch = () => {
      const n = Object.keys(sel).filter((k) => sel[k]).length;
      host.innerHTML =
        '<div class="t-hint" style="margin:0 0 var(--sp-3)">Chọn vài chương, chọn một việc, chạy một lần cho xong. ' +
        ' Khi chạy là tác vụ nền, có thể thoát ra làm việc khác;<b>chính văn và bản trau chuốt sẽ ghi vào «Thay đổi» trước, bạn xác nhận mới tính</b>. </div>' +
        '<div class="t-seg wide" data-modes>' + BATCH_MODES.map(([k, n2]) =>
          '<button class="' + (k === mode ? 'on' : '') + '" data-m="' + k + '">' + n2 + '</button>').join('') + '</div>' +
        '<div class="t-bar" style="margin-top:var(--sp-4)"><button class="t-btn" data-all>Chọn tất cả</button>' +
        '<button class="t-btn" data-none>Bỏ chọn tất cả</button>' +
        '<button class="t-btn pri" data-go>Bắt đầu (' + n + ' chương)</button></div>' +
        '<div class="t-list">' + chs.map((c, i) =>
          '<div class="t-row" data-ch="' + i + '">' + ico(sel[c.path] ? 'check' : 'file') +
          '<div class="tr-main"><div class="tr-title">' + esc(c.name || c.path) + '</div>' +
          '<div class="tr-sub">' + esc((c.words || 0) + ' chữ') + '</div></div>' +
          (sel[c.path] ? '<span class="t-pill ok">Đã chọn</span>' : '') + '</div>').join('') + '</div>' +
        '<div data-job></div>';
      host.querySelector('[data-modes]').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-m]'); if (!b) return;
        hap(); mode = b.dataset.m; paintBatch();
      });
      host.querySelectorAll('[data-ch]').forEach((r) => {
        r.onclick = () => { const c = chs[Number(r.dataset.ch)]; sel[c.path] = !sel[c.path]; hap(); paintBatch(); };
      });
      host.querySelector('[data-all]').onclick = () => { chs.forEach((c) => { sel[c.path] = true; }); hap(); paintBatch(); };
      host.querySelector('[data-none]').onclick = () => { chs.forEach((c) => { sel[c.path] = false; }); hap(); paintBatch(); };
      host.querySelector('[data-go]').onclick = async () => {
        const paths = chs.filter((c) => sel[c.path]).map((c) => c.path);
        if (!paths.length) { toast('Hãy chọn vài chương trước'); return; }
        const box = host.querySelector('[data-job]');
        box.innerHTML = '<div class="t-load"><i></i><div class="t-hint" style="margin-top:var(--sp-3)">Đang giao cho chạy nền…</div></div>';
        let r;
        try { r = await window.API.writeBatch({ slug: slug, mode: mode, paths: paths, apply: true }); }
        catch (e) { box.innerHTML = '<div class="t-empty">Không chạy được: ' + esc(e.message) + '</div>'; return; }
        toast('Đã chạy, tiến độ ở bên dưới'); hap();
        window.Tools.Jobs.watch(r.jobId,
          (dd) => window.Tools.ui.paintJob(box, dd, { jobId: r.jobId }),
          (dd) => {
            window.Tools.ui.paintJob(box, dd || {}, { jobId: r.jobId });
            toast(dd && dd.status === 'done' ? 'Chạy xong' : 'Tác vụ đã kết thúc');
          });
      };
    };
    paintBatch();
  }

  /* ══════════════════════════════════════════════════════════
     1.2 流水线：把「细纲→正文→润色」这类套路存成一条命令
     ══════════════════════════════════════════════════════════ */
  const STEP_CN = { outline: 'Viết dàn ý chi tiết', write: 'Viết chính văn', continue: 'Viết tiếp xuống dưới', polish: 'Trau chuốt',
                    summary: 'Viết tóm tắt', lint: 'Soát lỗi' };

  async function pipelineView(host, slug) {
    loading(host, 'Đang đọc dây chuyền…');
    let d;
    try { d = await window.API.workflows(slug); } catch (e) { empty(host, 'Không đọc được: ' + e.message); return; }
    const items = d.items || [];
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">Một dây chuyền = vài bước chạy liền nhau. Khi chạy là tác vụ nền, ' +
      ' thoát ra cũng không sao; kết quả từng bước chạy xong đều xem lại được.</div>' +
      '<div class="t-bar"><button class="t-btn pri" data-new>Tạo mới</button>' +
      '<button class="t-btn" data-reload>Làm mới</button></div>' +
      '<div class="t-list">' + items.map((w, i) =>
        '<div class="t-row" data-i="' + i + '">' + ico('spark') +
        '<div class="tr-main"><div class="tr-title">' + esc(w.name) + '</div>' +
        '<div class="tr-sub wrap">' + esc((w.steps || []).map((x) => STEP_CN[x.kind] || x.kind).join(' → ')) +
        (w.slug ? ' · chỉ dùng cho cuốn này' : ' · mọi sách đều dùng được') + '</div></div>' +
        '<span class="tr-go">' + window.iconHtml('chevron') + '</span></div>').join('') + '</div>' +
      '<div data-run></div>';
    host.querySelectorAll('[data-i]').forEach((r) => {
      r.onclick = () => { hap(); workflowRun(host, slug, items[Number(r.dataset.i)]); };
    });
    host.querySelector('[data-new]').onclick = () => {
      ask('Dây chuyền tên là gì', '', { placeholder: 'VD: Một chương từ đầu tới cuối', host: host }).then((name) => {
        if (!name) return;
        workflowEdit(host, slug, { name: name, slug: slug, steps: [] });
      });
    };
    host.querySelector('[data-reload]').onclick = () => pipelineView(host, slug);
  }

  function workflowRun(host, slug, wf) {
    const box = host.querySelector('[data-run]') || host;
    box.innerHTML = '<div class="t-bar" style="margin-top:var(--sp-4)"><button class="t-btn" data-go>Chạy «' + esc(wf.name) + '»</button>' +
      '<button class="t-btn" data-edit>Sửa các bước</button></div>';
    box.querySelector('[data-go]').onclick = () => {
      hap();
      push('Chọn một chương', (h2) => chapterPicker(h2, slug, async (c) => {
        h2.innerHTML = '<div class="t-load"><i></i><div class="t-hint" style="margin-top:var(--sp-3)">Đang giao cho chạy nền…</div></div>';
        let r;
        try { r = await window.API.workflowRun({ slug: slug, id: wf.id, path: c.path, name: wf.name }); }
        catch (e) { empty(h2, 'Không chạy được: ' + e.message); return; }
        const out = document.createElement('div');
        h2.innerHTML = '';
        h2.appendChild(out);
        toast('Đã chạy'); hap();
        window.Tools.Jobs.watch(r.jobId, (dd) => window.Tools.ui.paintJob(out, dd, { jobId: r.jobId }),
          (dd) => {
            window.Tools.ui.paintJob(out, dd || {}, { jobId: r.jobId });
            toast(dd && dd.status === 'done' ? 'Chạy xong' : 'Tác vụ đã kết thúc');
          });
      }, { hint: 'Dây chuyền này chạy trên chương nào' }));
    };
    box.querySelector('[data-edit]').onclick = () => { hap(); workflowEdit(host, slug, wf); };
  }

  function workflowEdit(host, slug, wf) {
    const steps = (wf.steps || []).map((x) => Object.assign({}, x));
    const paintWf = () => {
      host.innerHTML =
        '<div class="t-hint" style="margin:0 0 var(--sp-3)">' + esc(wf.name) + ': chạy lần lượt các bước dưới đây. ' +
        ' Bấm một bước để đưa lên / xóa.</div>' +
        '<div class="t-list">' + (steps.length ? steps.map((x, i) =>
          '<div class="t-row" data-s="' + i + '">' + ico('spark') +
          '<div class="tr-main"><div class="tr-title">' + (i + 1) + '. ' + esc(STEP_CN[x.kind] || x.kind) + '</div>' +
          '<div class="tr-sub">' + esc(x.kind === 'lint' ? 'Soát giọng AI tại máy, không tốn tiền' : 'Sẽ gọi mô hình, kết quả ghi vào «Thay đổi» trước') + '</div></div>' +
          '<span class="tr-go">' + window.iconHtml('chevron') + '</span></div>').join('')
          : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">Chưa có bước nào, thêm một bước bên dưới</div></div></div>') + '</div>' +
        '<div class="t-bar" style="margin-top:var(--sp-3)"><button class="t-btn" data-add>Thêm một bước</button>' +
        '<button class="t-btn pri" data-save>Lưu</button></div>' +
        (wf.id ? '<div class="t-bar"><button class="t-btn dan" data-del>Xóa dây chuyền này</button></div>' : '');
      host.querySelectorAll('[data-s]').forEach((r) => {
        r.onclick = () => {
          const i = Number(r.dataset.s);
          App.sheet('<div class="sheet-head"><h3>Bước ' + (i + 1) + ' </h3>' +
            '<button class="btn sm" data-close>Đóng</button></div>' +
            '<div style="padding:0 var(--sp-4) var(--sp-5)"><div class="t-bar"><button class="t-btn pri" data-up>Đưa lên một bước</button>' +
            '<button class="t-btn dan" data-rm>Xóa</button></div></div>');
          const pn = document.getElementById('sheet-panel');
          pn.querySelector('[data-up]').onclick = () => {
            if (i > 0) { const t = steps[i - 1]; steps[i - 1] = steps[i]; steps[i] = t; }
            App.closeSheet(); hap(); paintWf();
          };
          pn.querySelector('[data-rm]').onclick = () => { steps.splice(i, 1); App.closeSheet(); hap(); paintWf(); };
        };
      });
      host.querySelector('[data-add]').onclick = () => {
        App.sheet('<div class="sheet-head"><h3>Thêm một bước</h3><button class="btn sm" data-close>Đóng</button></div>' +
          '<div style="padding:0 var(--sp-4) var(--sp-5)"><div class="t-list">' +
          Object.keys(STEP_CN).map((k) => '<div class="t-row" data-k="' + k + '">' + ico('spark') +
            '<div class="tr-main"><div class="tr-title">' + STEP_CN[k] + '</div></div></div>').join('') +
          '</div></div>');
        const pn = document.getElementById('sheet-panel');
        pn.querySelectorAll('[data-k]').forEach((r) => {
          r.onclick = () => { steps.push({ kind: r.dataset.k }); App.closeSheet(); hap(); paintWf(); };
        });
      };
      host.querySelector('[data-save]').onclick = async () => {
        if (!steps.length) { toast('Cần ít nhất một bước'); return; }
        try {
          await window.API.workflowSave({ slug: wf.slug === '' ? '' : slug, name: wf.name, steps: steps, note: wf.note || '' });
          toast('Đã lưu'); hap(); pipelineView(host, slug);
        } catch (e) { toast('Không lưu được: ' + e.message); }
      };
      const delBtn = host.querySelector('[data-del]');
      if (delBtn) delBtn.onclick = async () => {
        if (!(await confirmBox('Xóa dây chuyền «' + wf.name + '»? ', true))) return;
        try { await window.API.workflowDelete(wf.id, wf.slug || ''); toast('Đã xóa'); hap(); pipelineView(host, slug); }
        catch (e) { toast('Không xóa được: ' + e.message); }
      };
    };
    paintWf();
  }

  async function contextView(host, slug, path) {
    loading(host, 'Đang trải ngữ cảnh…');
    let d;
    try { d = await get('/api/write/context', { slug, path, mode: 'continue' }); }
    catch (e) { empty(host, 'Không đọc được: ' + e.message); return; }
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">Mỗi lần đặt bút, những nội dung này sẽ được giao cùng lúc cho AI (tổng ' +
      esc(d.chars) + ' chữ). Ở đây cho bạn thấy rõ nó thực sự biết những gì, không có gì bí ẩn.</div>' +
      '<h2 class="st-h">Quy tắc viết</h2><div class="t-pre">' + esc(d.system) + '</div>' +
      '<h2 class="st-h">Yêu cầu lần này</h2><div class="t-pre">' +
      esc((d.messages || []).map((m) => m.content).join('\n\n')) + '</div>';
  }

  async function chapterStudio(host, slug, ch) {
    loading(host, 'Đang mở chương này…');
    let doc, outs;
    try {
      doc = await get('/api/chapter', { slug, path: ch.path });
      outs = await get('/api/plot/outline', { slug, path: ch.path });
    } catch (e) { empty(host, 'Không đọc được: ' + e.message); return; }
    let text = doc.content || '';
    const outlines = outs.items || [];
    /* 这一章要用哪几条参考范文（写的时候随提示词一起喂进去） */
    let chosenRefs = [];
    host.innerHTML =
      '<div class="t-seg wide" data-tabs>' +
      '<button class="on" data-tab="draft">Chính văn</button>' +
      '<button data-tab="outline">Dàn ý chi tiết</button>' +
      '<button data-tab="info">Cài đặt chương này</button></div>' +
      '<div data-pane="draft" style="margin-top:var(--sp-3)">' +
        '<textarea class="t-area mono" data-src placeholder="Chương này chưa viết. Có thể để nó viết dàn ý chi tiết trước, rồi theo đó ra chính văn.">' +
        esc(text) + '</textarea>' +
        '<div class="t-hint" style="margin:var(--sp-2) 0 var(--sp-3)"><span data-count></span></div>' +
        '<div class="t-bar"><button class="t-btn pri" data-save>Lưu chính văn</button>' +
        '<button class="t-btn" data-continue>Viết tiếp xuống</button>' +
        '<button class="t-btn" data-polish>Trau chuốt chương này</button></div>' +
        '<div class="t-bar"><button class="t-btn" data-rewrite>Sửa đoạn đã chọn</button>' +
        '<button class="t-btn" data-chapter>Viết cả chương theo dàn ý</button>' +
        '<button class="t-btn" data-refs>Văn mẫu tham khảo <b data-refn>0</b></button></div>' +
        '<div data-out></div>' +
      '</div>' +
      '<div data-pane="outline" hidden></div>' +
      '<div data-pane="info" hidden></div>';

    const ta = host.querySelector('[data-src]');
    const out = host.querySelector('[data-out]');
    const count = host.querySelector('[data-count]');
    const refreshCount = () => {
      const n = (ta.value.match(/[\u4e00-\u9fa5]|[0-9A-Za-z\u00C0-\u024F\u1E00-\u1EFF]+/g) || []).length;
      count.textContent = n + ' chữ';
    };
    refreshCount();
    ta.addEventListener('input', refreshCount);

    host.querySelector('[data-tabs]').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]'); if (!b) return;
      hap();
      host.querySelectorAll('[data-tabs] button').forEach((x) => x.classList.toggle('on', x === b));
      host.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.tab; });
      if (b.dataset.tab === 'outline') renderOutline();
      if (b.dataset.tab === 'info') renderInfo();
    });

    /* 存正文：带着「我读到的服务器是哪一版」去存。
       两边都改过 → 让用户挑（两份都留着，不闷头覆盖）；
       没网 → 先存在本机，网一来自动推回去（工具 → 同步）。 */
    async function saveChapter(text) {
      try {
        const r = await nb('api/chapter', { method: 'PUT', body: {
          slug, path: ch.path, content: text, expectedMtimeMs: doc.mtimeMs } });
        doc.mtimeMs = r.mtimeMs;
        return true;
      } catch (e) {
        if (e.offline) {
          window.Offline && Offline.queueWrite(slug, ch.path, text, doc.mtimeMs);
          toast('Hiện không có mạng, tạm lưu trên máy; có mạng sẽ tự đẩy lên');
          return false;
        }
        if (e.status === 409 && e.data && e.data.conflict) {
          const info = { id: e.data.conflictId, localText: text, serverText: e.data.serverText };
          const choice = await window.Tools.Conflicts.ask(info);
          if (choice === null) return false;
          try {
            const r = await window.Tools.Conflicts.resolve(info, choice);
            if (choice === 'server') {
              const d2 = await get('/api/chapter', { slug, path: ch.path });
              ta.value = d2.content || '';
              doc.mtimeMs = d2.mtimeMs;
              toast('Đã dùng bản trên máy chủ');
            } else {
              const t = (choice && choice.merged != null) ? choice.merged : text;
              ta.value = t;
              doc.mtimeMs = (r && r.mtimeMs) || 0;
              toast('Đã lưu');
            }
            refreshCount();
          } catch (e2) { toast('Xử lý xung đột thất bại: ' + e2.message); return false; }
          return true;
        }
        toast('Không lưu được: ' + e.message);
        return false;
      }
    }

    host.querySelector('[data-save]').onclick = async () => {
      if (await saveChapter(ta.value)) { toast('Đã lưu'); hap(); }
    };

    /* 写完一个候选：写进正文 / 追加 / 丢弃。写进去走 origin=model → 先记进「改动」等确认。 */
    async function offerResult(kind, res) {
      const t = (res.text || '').trim();
      out.innerHTML =
        '<h2 class="st-h">AI đã viết xong ' + (res.words ? '(' + res.words + ' chữ)' : '') + '</h2>' +
        '<div class="t-pre selectable">' + esc(t || '(trống)') + '</div>' +
        '<div class="t-bar"><button class="t-btn pri" data-apply>' +
        (kind === 'continue' ? 'Nối vào cuối chính văn' : 'Thay toàn bộ chính văn chương') + '</button>' +
        '<button class="t-btn" data-copy>Sao chép</button>' +
        '<button class="t-btn dan" data-drop>Không lấy</button></div>' +
        '<div class="t-hint">Nội dung ghi vào sẽ được ghi vào «Thay đổi» trước, bạn xác nhận mới có hiệu lực; không ưng có thể hoàn lại.</div>';
      out.querySelector('[data-apply]').onclick = async () => {
        const next = kind === 'continue'
          ? (ta.value.replace(/\s*$/, '') + '\n\n' + t) : t;
        // 走同一个保存口子：AI 写的东西也是「一次改动」，撞上冲突照样交给用户决定
        if (await saveChapter(next)) { ta.value = next; refreshCount(); toast('Đã ghi vào'); hap(); }
      };
      out.querySelector('[data-copy]').onclick = () => {
        try { navigator.clipboard.writeText(t); toast('Đã sao chép'); } catch (e) { toast('Không sao chép được'); }
      };
      out.querySelector('[data-drop]').onclick = () => { out.innerHTML = ''; toast('Đã bỏ'); };
    }

    async function run(kind, extra) {
      if (!window.__writeReady || true) { /* 每次重新判断，别缓存状态 */ }
      if (!(await writeReady(slug))) return;
      const mode = kind === 'continue' ? 'continue' : kind === 'chapter' ? 'chapter'
        : kind === 'polish' ? 'polish' : 'rewrite';
      const body = Object.assign({ slug, path: ch.path, mode, stream: true, apply: false,
                                  refs: chosenRefs.slice() }, extra || {});
      out.innerHTML = '<div class="t-load"><i></i><div class="t-hint" style="margin-top:var(--sp-3)">'
        + (mode === 'continue' ? 'Viết tiếp xuống…' : mode === 'polish' ? 'Đang trau chuốt…' : 'Viết chính văn…') + '</div></div>';
      let acc = '';
      App.keepAlive && App.keepAlive(true);        // 写正文可能好几分钟：切后台也别被系统收掉
      const pre = document.createElement('div');
      const paint = () => {
        out.innerHTML = '<h2 class="st-h">Đang viết</h2><div class="t-pre selectable" data-live>' + esc(acc) + '</div>';
        const l = out.querySelector('[data-live]');
        if (l) l.scrollTop = l.scrollHeight;
      };
      try {
        await streamWrite('generate', body, (ev) => {
          if (ev.type === 'delta') { acc += ev.delta; paint(); }
          else if (ev.type === 'notice') { toast(ev.notice); }
          else if (ev.type === 'error') { throw new Error(ev.error); }
          else if (ev.type === 'done') {
            const text = ev.text || acc;
            if (!text) { out.innerHTML = '<div class="t-empty">Nó không viết ra được gì, thử lại hoặc đổi mô hình</div>'; return; }
            offerResult(mode === 'continue' ? 'continue' : 'replace',
                        { text, words: ev.words });
          }
        });
      } catch (e) {
        out.innerHTML = '<div class="t-empty">Không viết tiếp được: ' + esc(e.message) + '</div>';
      } finally {
        App.keepAlive && App.keepAlive(false);
      }
      void pre;
    }

    host.querySelector('[data-continue]').onclick = () => run('continue', {
      instruction: 'Viết tiếp từ đoạn trên, nối tiếp cảnh và cảm xúc hiện tại, không lặp lại đoạn trên. Viết bằng tiếng Việt.', targetWords: 600 });
    host.querySelector('[data-polish]').onclick = () => run('polish', {});
    host.querySelector('[data-chapter]').onclick = () => run('chapter', { targetWords: ch.target_words || 2500 });
    const refBtn = host.querySelector('[data-refs]');
    if (refBtn) refBtn.onclick = () => {
      hap();
      push('Chọn văn mẫu tham khảo', (h) => refPicker(h, slug, chosenRefs, () => {
        host.querySelector('[data-refn]').textContent = chosenRefs.length;
      }));
    };
    host.querySelector('[data-rewrite]').onclick = async () => {
      const sel = String(ta.value).substring(ta.selectionStart || 0, ta.selectionEnd || 0).trim();
      if (!sel) { toast('Hãy chọn một đoạn trong chính văn trước'); return; }
      const note = await ask('Đoạn này cần sửa thế nào', '', { placeholder: 'VD: bỏ câu giải thích, viết hành động cụ thể hơn' });
      if (note === null) return;
      run('rewrite', { selection: sel, instruction: note });
    };

    /* ── 细纲 ── */
    async function renderOutline() {
      const pane = host.querySelector('[data-pane="outline"]');
      pane.innerHTML = '<div class="t-bar"><button class="t-btn pri" data-gen>Để AI viết dàn ý chi tiết</button>' +
        '<button class="t-btn" data-add>Tự viết một mục</button></div>' +
        '<div class="t-hint" style="margin-bottom:var(--sp-3)">Dàn ý chi tiết sẽ tự động được đưa vào ngữ cảnh khi viết chính văn.</div>' +
        '<div data-list></div>';
      const list = pane.querySelector('[data-list]');
      const paintList = () => {
        list.innerHTML = outs.length
          ? '<div class="t-list">' + outs.map((o, i) =>
            '<div class="t-row static">' + ico(o.approved ? 'check' : 'file') +
            '<div class="tr-main"><div class="tr-title" style="white-space:pre-wrap;font-weight:var(--w-normal)">' +
            esc(o.body) + '</div><div class="tr-sub">' + esc([o.level, o.approved ? 'Đã dùng' : 'Chờ xác nhận'].join(' · ')) +
            '</div></div>' +
            (o.approved ? '' : '<button class="t-btn sm" data-ok="' + i + '">Dùng</button>') +
            '<button class="t-btn sm dim" data-rm="' + i + '">Xóa</button></div>').join('') + '</div>'
          : '<div class="t-empty">Chương này chưa có dàn ý chi tiết</div>';
        list.querySelectorAll('[data-ok]').forEach((b) => {
          b.onclick = async () => {
            const o = outs[Number(b.dataset.ok)];
            try { await post('/api/plot/outline/approve', { slug, ids: [o.id] }); hap(); refresh(); }
            catch (e) { toast('Không dùng được: ' + e.message); }
          };
        });
        list.querySelectorAll('[data-rm]').forEach((b) => {
          b.onclick = async () => {
            const o = outs[Number(b.dataset.rm)];
            if (!(await confirmBox('Xóa mục dàn ý chi tiết này?'))) return;
            try { await del('/api/plot/outline', { slug, id: o.id }); refresh(); }
            catch (e) { toast('Không xóa được: ' + e.message); }
          };
        });
      };
      const refresh = async () => {
        try { outs = (await get('/api/plot/outline', { slug, path: ch.path })).items || []; } catch (e) {}
        paintList();
      };
      paintList();
      pane.querySelector('[data-add]').onclick = async () => {
        const body = await ask('Viết một mục dàn ý chi tiết', '', { placeholder: 'Ai, ở đâu, làm gì, kết quả, để lại móc câu gì', multiline: true });
        if (!body) return;
        try { await post('/api/plot/outline', { slug, path: ch.path, body, level: 'detail' }); refresh(); }
        catch (e) { toast('Không lưu được: ' + e.message); }
      };
      pane.querySelector('[data-gen]').onclick = async () => {
        if (!(await writeReady(slug))) return;
        list.innerHTML = '<div class="t-load"><i></i><div class="t-hint" style="margin-top:var(--sp-3)">Đang nghĩ dàn ý chi tiết…</div></div>';
        try {
          const r = await post('/api/write/outline', { slug, path: ch.path, save: true, maxTokens: 900 });
          if (!r.text) { list.innerHTML = '<div class="t-empty">Không tạo ra được, thử lại lần nữa</div>'; return; }
          toast('Đã viết xong dàn ý chi tiết, xem qua rồi hãy dùng'); hap(); refresh();
        } catch (e) { list.innerHTML = '<div class="t-empty">Không tạo được: ' + esc(e.message) + '</div>'; }
      };
    }

    /* ── 这一章的设置（状态机 / 目标字数 / 视角 / 信息控制）── */
    function renderInfo() {
      const pane = host.querySelector('[data-pane="info"]');
      const meta = ch.info_control_json ? safeJson(ch.info_control_json) : {};
      pane.innerHTML =
        '<div class="t-form">' +
        '<div class="t-field"><label>Chương này viết tới bước nào rồi</label><div class="t-seg wide" data-status>' +
        Object.keys(STATUS_CN).map((k) => '<button data-v="' + k + '" class="' +
          (ch.status === k ? 'on' : '') + '">' + STATUS_CN[k] + '</button>').join('') + '</div></div>' +
        '<div class="t-field"><label>Số chữ mục tiêu</label><input class="t-input" data-tw type="number" value="' +
        esc(ch.target_words || 0) + '"></div>' +
        '<div class="t-field"><label>Góc nhìn / Lối kể</label><input class="t-input" data-pov value="' +
        esc(ch.pov || '') + '" placeholder="VD: ngôi thứ ba hạn tri (nhân vật chính)"></div>' +
        '<div class="t-field"><label>Chương này muốn cho người đọc biết gì</label><textarea class="t-area" data-info rows="3">' +
        esc(meta['读者知'] || '') + '</textarea></div>' +
        '<div class="t-field"><label>Ai còn chưa biết / cần giấu</label><textarea class="t-area" data-hide rows="2">' +
        esc(meta['隐瞒'] || '') + '</textarea></div>' +
        '<div class="t-field"><label>Nhân vật xuất hiện (cách nhau bằng dấu phẩy)</label><input class="t-input" data-cast value="' +
        esc((ch.cast || []).join(', ')) + '" placeholder="VD: nhân vật chính, ông lão"></div>' +
        '<div class="t-field"><label>Sự kiện chính (mỗi dòng một mục)</label><textarea class="t-area" data-events rows="3" ' +
        'placeholder="VD: lấy được thẻ gỗ&#10;lần đầu đối đầu với ông lão">' + esc((ch.events || []).join('\n')) + '</textarea></div>' +
        '</div><div class="t-bar"><button class="t-btn pri" data-savemeta>Lưu</button></div>';
      pane.querySelector('[data-status]').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]'); if (!b) return;
        pane.querySelectorAll('[data-status] button').forEach((x) => x.classList.toggle('on', x === b));
      });
      pane.querySelector('[data-savemeta]').onclick = async () => {
        const cur = pane.querySelector('[data-status] button.on');
        try {
          const r = await nb('api/plot/chapter', { method: 'PATCH', body: {
            slug, path: ch.path, status: cur && cur.dataset.v,
            targetWords: Number(pane.querySelector('[data-tw]').value) || 0,
            pov: pane.querySelector('[data-pov]').value,
            infoControl: { '读者知': pane.querySelector('[data-info]').value,
                           '隐瞒': pane.querySelector('[data-hide]').value },
            cast: pane.querySelector('[data-cast]').value,
            events: pane.querySelector('[data-events]').value,
          } });
          Object.assign(ch, r.chapter || {});
          toast('Đã ghi lại'); hap();
        } catch (e) { toast('Không lưu được: ' + e.message); }
      };
    }

    function safeJson(s) { try { return JSON.parse(s) || {}; } catch (e) { return {}; } }
    void renderOutline; void renderInfo; void chapterPicker;
  }

  async function writeReady(slug) {
    try {
      const st = await get('/api/write/status', { slug });
      if (st.ready) return true;
      toast(st.why || 'Chưa có mô hình khả dụng');
      return false;
    } catch (e) { toast('Không đọc được trạng thái mô hình: ' + e.message); return false; }
  }

  /* ══════════════════════════════════════════════════════════
     2. 世界：实体 / 事实 / 关系 / 时间线 / 冲突
     ══════════════════════════════════════════════════════════ */
  function openWorld(host) { Push.book('Thế giới', worldHome); }

  /* 记住上次停在哪个页签：从「新历法 / 换算 / 定时间」这类子页返回时，
     要回到刚才那个页签，别一脚踢回「实体」（用户会以为点错了）。 */
  let worldTab = 'entities';
  /* 页签之间会互相抢面板：点了「时间线」但更早发出的「实体」请求晚一步回来，
     就会把时间线盖掉（e2e 截图里抓到过：文字读出来是时间线，屏幕上是实体）。
     所以每次切页签发一个"代次"，回来时代次对不上就直接丢弃。 */
  let worldGen = 0;

  async function worldHome(host, slug, tab) {
    tab = tab || worldTab;
    worldTab = tab;
    loading(host, 'Đang lật thế giới…');
    let ov;
    try { ov = await get('/api/world/overview', { slug }); }
    catch (e) { empty(host, 'Không đọc được: ' + e.message); return; }
    const c = ov.counts || {};
    host.innerHTML =
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + (c.entities || 0) + '</b><span>Thực thể</span></div>' +
      '<div class="t-stat"><b>' + (c.facts || 0) + '</b><span>Dữ kiện</span></div>' +
      '<div class="t-stat"><b>' + (c.moments || 0) + '</b><span>Thời điểm</span></div>' +
      '</div>' +
      ((ov.conflicts || []).length
        ? '<div class="t-form" style="margin-bottom:var(--sp-3)"><div class="t-field"><label>Có ' +
          ov.conflicts.length + ' chỗ thiết lập mâu thuẫn nhau</label><div class="t-hint" style="margin:0">' +
          esc(ov.conflicts.map((x) => x.entity + '·' + x.key + ': ' + (x.values || []).join(' / ')).join('; ')) +
          '</div></div></div>' : '') +
      '<div class="t-seg wide" data-tabs>' +
      '<button data-tab="entities" class="' + (tab === 'entities' ? 'on' : '') + '">Thực thể</button>' +
      '<button data-tab="timeline" class="' + (tab === 'timeline' ? 'on' : '') + '">Dòng thời gian</button>' +
      '<button data-tab="relations" class="' + (tab === 'relations' ? 'on' : '') + '">Quan hệ</button>' +
      '<button data-tab="calendar" class="' + (tab === 'calendar' ? 'on' : '') + '">Lịch</button>' +
      '<button data-tab="tools" class="' + (tab === 'tools' ? 'on' : '') + '">Sắp xếp</button></div>' +
      '<div data-pane style="margin-top:var(--sp-3)"></div>';

    const pane = host.querySelector('[data-pane]');
    const go = (t) => {
      worldTab = t;                       // 返回键再进来时用得上
      host.querySelectorAll('[data-tabs] button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
      ({ entities: renderEntities, timeline: renderTimeline, relations: renderRelations,
         calendar: renderCalendar, tools: renderTools }[t] || renderEntities)();
    };
    host.querySelector('[data-tabs]').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]'); if (!b) return;
      hap(); go(b.dataset.tab);
    });

    async function renderEntities() {
      const gen = ++worldGen;   // 每次重绘自己领一个代次；晚回来的旧请求直接被丢掉
      loading(pane, 'Đang đọc thực thể…');
      let d;
      try { d = await get('/api/world/entities', { slug }); }
      catch (e) { if (gen === worldGen) empty(pane, 'Không đọc được: ' + e.message); return; }
      if (gen !== worldGen) return;   // 切走了就别改屏幕
      const items = d.items || [];
      /* 出场统计：/api/plot/cast 按正文里真的出现来找人。
         以前这个接口没人用 —— 等于「角色有没有被写丢」这件事没人管。 */
      let cast = null;
      try { cast = await get('/api/plot/cast', { slug }); } catch (e) { cast = null; }
      if (gen !== worldGen) return;
      const castOf = {};
      ((cast && cast.items) || []).forEach((x) => { castOf[x.name] = x; });
      const vanished = (cast && cast.vanished) || [];
      const castBit = (name) => {
        const c = castOf[name];
        if (!c || !c.count) return '';
        return c.silentFor >= 5 ? ('Xuất hiện ' + c.count + ' chương · đã ' + c.silentFor + ' chương không xuất hiện')
                                : ('Xuất hiện ' + c.count + ' chương');
      };
      pane.innerHTML =
        (vanished.length
          ? '<div class="t-hint" style="margin-bottom:var(--sp-3)">' + vanished.length +
            ' nhân vật đã hơn 5 chương không xuất hiện: ' +
            esc(vanished.slice(0, 6).map((v) => v.name + '(' + v.silentFor + ' chương)').join(', ')) +
            '. Hoặc sắp xếp cho họ quay lại, hoặc chấp nhận tuyến này đã đứt.</div>' : '') +
        '<div class="t-bar"><button class="t-btn pri" data-add>Thêm một</button>' +
        '<button class="t-btn" data-fromlore>Thu từ thư mục thiết lập</button></div>' +
        '<div class="t-list">' + (items.length ? items.map((it, i) =>
          '<div class="t-row" data-i="' + i + '">' + ico('users') +
          '<div class="tr-main"><div class="tr-title">' + esc(it.name) + '</div>' +
          '<div class="tr-sub wrap">' + esc([KIND_CN[it.kind] || it.kind,
            (it.aliases || []).length ? ('Còn gọi là ' + it.aliases.join(', ')) : '',
            (it.facts || []).length ? ((it.facts || []).length + ' dữ kiện') : '',
            castBit(it.name),
            (it.data && it.data.summary) ? String(it.data.summary).slice(0, 40) : '',
          ].filter(Boolean).join(' · ')) + '</div></div>' +
          '<span class="tr-go">' + window.iconHtml('chevron') + '</span></div>').join('')
          : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">Thế giới chưa có ai. Bấm «Thu từ thư mục thiết lập» để thu gọn thiết lập trong lorebook một lần.</div></div></div>') +
        '</div>';
      pane.querySelectorAll('[data-i]').forEach((r) => {
        r.onclick = () => { hap(); const it = items[Number(r.dataset.i)]; push(it.name, (h2) => entityDetail(h2, slug, it, () => renderEntities())); };
      });
      pane.querySelector('[data-add]').onclick = async () => {
        const name = await ask('Thêm ai (hoặc cái gì)', '', { placeholder: 'VD: Nhân vật chính / Thành Thanh Vân / năng lực hệ Hỏa' });
        if (!name) return;
        push('Tạo mới: ' + name, (h2) => entityForm(h2, slug, { name, kind: 'character', data: {}, aliases: [] }, () => renderEntities()));
      };
      pane.querySelector('[data-fromlore]').onclick = async () => {
        loading(pane, 'Đang thu thiết lập…');
        try {
          const r = await post('/api/world/import-lorebook', { slug });
          toast('Đã thu ' + r.imported + ' mục thiết lập'); hap(); renderEntities();
        } catch (e) { empty(pane, 'Không thu được: ' + e.message); }
      };
    }

    async function entityDetail(host2, slug2, ent, after) {
      loading(host2, 'Đang đọc nhân vật này…');
      let d;
      try { d = await get('/api/world/entities', { slug: slug2, q: ent.name }); }
      catch (e) { empty(host2, 'Không đọc được: ' + e.message); return; }
      const me = (d.items || []).find((x) => x.id === ent.id) || ent;
      const facts = me.facts || [];
      host2.innerHTML =
        '<div class="t-stats">' +
        '<div class="t-stat"><b>' + esc(KIND_CN[me.kind] || me.kind) + '</b><span>Loại</span></div>' +
        '<div class="t-stat"><b>' + facts.length + '</b><span>Dữ kiện</span></div>' +
        '<div class="t-stat"><b>' + ((me.aliases || []).length) + '</b><span>Tên khác</span></div></div>' +
        (me.data && me.data.summary
          ? '<div class="t-hint" style="margin-bottom:var(--sp-3)">' + esc(String(me.data.summary).slice(0, 300)) + '</div>' : '') +
        '<div class="t-bar"><button class="t-btn" data-edit>Sửa hồ sơ</button>' +
        '<button class="t-btn" data-voice>Cách nói chuyện</button>' +
        '<button class="t-btn" data-state>Tra trạng thái tại một thời điểm</button>' +
        '<button class="t-btn" data-arc>Cung trưởng thành</button></div>' +
        '<h2 class="st-h">Dữ kiện (có hiệu lực theo thời gian)</h2>' +
        '<div data-facts></div>' +
        '<div class="t-bar" style="margin-top:var(--sp-3)"><button class="t-btn pri" data-addfact>Thêm một dữ kiện</button>' +
        '<button class="t-btn" data-merge>Gộp với cái khác</button>' +
        '<button class="t-btn dan" data-del>Xóa</button></div>';
      const fbox = host2.querySelector('[data-facts]');
      const paintFacts = () => {
        fbox.innerHTML = facts.length
          ? '<div class="t-list">' + facts.map((f, i) =>
            '<div class="t-row static">' + ico('dot') +
            '<div class="tr-main"><div class="tr-title">' + esc(f.key + ': ' + f.value) + '</div>' +
            '<div class="tr-sub">' + esc([f.from || 'Từ đầu', f.to ? ('tới ' + f.to) : 'tới nay',
              f.confidence === 'stated' ? 'Sách ghi rõ' : f.confidence === 'inferred' ? 'Suy luận' : 'Không chắc',
              f.note || '', f.source_path || ''].filter(Boolean).join(' · ')) + '</div></div>' +
            '<button class="t-btn sm dim" data-rm="' + i + '">Xóa</button></div>').join('') + '</div>'
          : '<div class="t-empty">Chưa có dữ kiện. Dữ kiện là «trong một khoảng thời gian, người này như thế nào».</div>';
        fbox.querySelectorAll('[data-rm]').forEach((b) => {
          b.onclick = async () => {
            const f = facts[Number(b.dataset.rm)];
            if (!(await confirmBox('Xóa dữ kiện này?'))) return;
            try { await del('/api/world/fact', { slug: slug2, id: f.id }); hap(); entityDetail(host2, slug2, me, after); }
            catch (e) { toast('Không xóa được: ' + e.message); }
          };
        });
      };
      paintFacts();
      host2.querySelector('[data-edit]').onclick = () => push('Sửa: ' + me.name, (h3) => entityForm(h3, slug2, me, after));
      host2.querySelector('[data-addfact]').onclick = async () => {
        const key = await ask('Thuộc tính gì', '', { placeholder: 'VD: thân phận / tuổi / năng lực / trạng thái' });
        if (!key) return;
        const value = await ask('Là gì', '', { placeholder: 'VD: đệ tử ngoại môn thành Thanh Vân' });
        if (!value) return;
        const from = await ask('Bắt đầu có hiệu lực từ thời điểm nào (để trống = luôn có hiệu lực)', '', { placeholder: 'Tên thời điểm' });
        try {
          let fromId = null;
          if (from) {
            const ms = (await get('/api/world/moments', { slug: slug2 })).items || [];
            const hit = ms.find((m) => m.label === from);
            if (!hit) { toast('Không có thời điểm «' + from + '», hãy tạo một cái ở dòng thời gian trước'); return; }
            fromId = hit.id;
          }
          await post('/api/world/fact', { slug: slug2, entityId: me.id, key, value, fromMomentId: fromId });
          toast('Đã ghi lại'); hap(); entityDetail(host2, slug2, me, after);
        } catch (e) { toast('Không ghi được: ' + e.message); }
      };
      host2.querySelector('[data-state]').onclick = () => push('Tra trạng thái', (h3) => stateView(h3, slug2, me.name));
      host2.querySelector('[data-voice]').onclick = () => push('Cách nói chuyện · ' + me.name,
        (h3) => voiceForm(h3, slug2, me.name));
      host2.querySelector('[data-arc]').onclick = () => push('Cung · ' + me.name, (h3) => arcView(h3, slug2, me));
      host2.querySelector('[data-merge]').onclick = async () => {
        const other = await ask('Gộp với ai (ghi tên kia, tên của nó sẽ thành tên khác)', '', { placeholder: 'Cách gọi khác' });
        if (!other) return;
        const list = (await get('/api/world/entities', { slug: slug2, q: other })).items || [];
        const hit = list.find((x) => x.name === other) || list[0];
        if (!hit) { toast('Không tìm thấy «' + other + '»'); return; }
        if (!(await confirmBox('Gộp «' + hit.name + '» vào «' + me.name + '»? Mọi dữ kiện sẽ đi theo.'))) return;
        try { await post('/api/world/entity/merge', { slug: slug2, fromId: hit.id, toId: me.id }); toast('Đã gộp'); hap(); after(); U().back(); }
        catch (e) { toast('Không gộp được: ' + e.message); }
      };
      host2.querySelector('[data-del]').onclick = async () => {
        if (!(await confirmBox('Gộp «' + me.name + '» khỏi thế giới? (chính văn không bị đụng chữ nào)', true))) return;
        try { await del('/api/world/entity', { slug: slug2, id: me.id }); toast('Đã xóa'); hap(); after(); U().back(); }
        catch (e) { toast('Không xóa được: ' + e.message); }
      };
    }

    function entityForm(host2, slug2, ent, after) {
      const d = ent.data || {};
      host2.innerHTML =
        '<div class="t-form">' +
        '<div class="t-field"><label>Tên</label><input class="t-input" data-name value="' + esc(ent.name) + '"></div>' +
        '<div class="t-field"><label>Loại</label><div class="t-seg wide" data-kind>' +
        Object.keys(KIND_CN).map((k) => '<button data-v="' + k + '" class="' +
          ((ent.kind || 'character') === k ? 'on' : '') + '">' + KIND_CN[k] + '</button>').join('') + '</div></div>' +
        '<div class="t-field"><label>Tên khác (cách nhau bằng dấu phẩy)</label><input class="t-input" data-alias value="' +
        esc((ent.aliases || []).join(', ')) + '" placeholder="VD: Tiểu Nặc, Lâm tiểu tử"></div>' +
        '<div class="t-field"><label>Mô tả một câu</label><textarea class="t-area" data-summary rows="2">' +
        esc(d.summary || '') + '</textarea></div>' +
        '<div class="t-field"><label>Ngoại hình</label><input class="t-input" data-look value="' + esc(d['外貌'] || '') + '"></div>' +
        '<div class="t-field"><label>Tính cách</label><input class="t-input" data-temper value="' + esc(d['性格'] || '') + '"></div>' +
        '<div class="t-field"><label>Mục tiêu / Động cơ</label><input class="t-input" data-goal value="' + esc(d['目标'] || '') + '"></div>' +
        '<div class="t-field"><label>Phong cách nói / Câu cửa miệng</label><input class="t-input" data-voice value="' + esc(d['口头禅'] || '') + '"></div>' +
        '<div class="t-field" data-only="place" hidden><label>Địa điểm cấp trên</label><input class="t-input" data-parent value="' +
        esc(d['上级地点'] || '') + '" placeholder="VD: Đế quốc Thiên Đấu &gt; Thành Sách Thác &gt; Khách điếm"></div>' +
        '<div class="t-field" data-only="place" hidden><label>Tọa độ (tùy chọn)</label><input class="t-input" data-coord value="' +
        esc(d['坐标'] || '') + '" placeholder="VD: 300 dặm về tây bắc / 12,34"></div>' +
        '<div class="t-field" data-only="system" hidden><label>Bảng cấp bậc (từ thấp tới cao, cách nhau bằng dấu phẩy)</label><input class="t-input" data-levels value="' +
        esc(d['等级表'] || '') + '" placeholder="VD: Nhất giai, Nhị giai, Tam giai, Tứ giai"></div>' +
        '<div class="t-field" data-only="item" hidden><label>Hiện đang trong tay ai</label><input class="t-input" data-holder value="' +
        esc(d['持有者'] || '') + '" placeholder="VD: nhân vật chính (từ chương 12)"></div>' +
        '</div><div class="t-bar"><button class="t-btn pri" data-save>Lưu</button></div>' +
        '<div class="t-hint">Trường có cấu trúc dễ dùng hơn một đoạn văn: khi viết AI sẽ bám theo các thiết lập này, không viết lệch.</div>';
      /* 只有相关类型才显示那几个字段：地点才要坐标，体系才要等级表，物品才问在谁手里 */
      const syncOnly = () => {
        const on = host2.querySelector('[data-kind] button.on');
        const k = (on && on.dataset.v) || 'character';
        host2.querySelectorAll('[data-only]').forEach((el) => { el.hidden = el.dataset.only !== k; });
      };
      syncOnly();
      host2.querySelector('[data-kind]').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]'); if (!b) return;
        host2.querySelectorAll('[data-kind] button').forEach((x) => x.classList.toggle('on', x === b));
        syncOnly();
      });
      host2.querySelector('[data-save]').onclick = async () => {
        const kindBtn = host2.querySelector('[data-kind] button.on');
        const val = (s) => { const el = host2.querySelector(s); return el ? el.value.trim() : ''; };
        try {
          await post('/api/world/entity', {
            slug: slug2, kind: kindBtn && kindBtn.dataset.v, name: val('[data-name]'),
            aliases: val('[data-alias]').split(/[，,、;；]+/).map((x) => x.trim()).filter(Boolean),
            replaceAliases: true,
            data: { summary: val('[data-summary]'), '外貌': val('[data-look]'),
                    '性格': val('[data-temper]'), '目标': val('[data-goal]'),
                    '口头禅': val('[data-voice]'),
                    '上级地点': val('[data-parent]'), '坐标': val('[data-coord]'),
                    '等级表': val('[data-levels]'), '持有者': val('[data-holder]') },
          });
          toast('Đã lưu'); hap(); after(); U().back();
        } catch (e) { toast('Không lưu được: ' + e.message); }
      };
    }

    async function stateView(host2, slug2, name) {
      loading(host2, 'Đang nghĩ…');
      const ms = (await get('/api/world/moments', { slug: slug2 })).items || [];
      host2.innerHTML =
        '<div class="t-form"><div class="t-field"><label>Ai</label><input class="t-input" data-name value="' + esc(name || '') + '"></div>' +
        '<div class="t-field"><label>Thời điểm nào (để trống = hiện tại)</label><div class="t-chips" data-ms>' +
        '<button class="t-pill" data-v="">Hiện tại</button>' +
        ms.map((m) => '<button class="t-pill" data-v="' + esc(m.label) + '">' + esc(m.label) + '</button>').join('') +
        '</div></div></div>' +
        '<div class="t-bar"><button class="t-btn pri" data-go>Xem lúc đó nó thế nào</button></div>' +
        '<div data-out></div>';
      let at = '';
      host2.querySelector('[data-ms]').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]'); if (!b) return;
        at = b.dataset.v; hap();
        host2.querySelectorAll('[data-ms] button').forEach((x) => x.classList.toggle('ok', x === b));
      });
      host2.querySelector('[data-go]').onclick = async () => {
        const out = host2.querySelector('[data-out]');
        loading(out, 'Đang suy tính…');
        try {
          const d = await get('/api/world/state', {
            slug: slug2, name: host2.querySelector('[data-name]').value.trim(), at });
          const kv = Object.entries(d.state || {});
          out.innerHTML = '<h2 class="st-h">' + esc(d.entity && d.entity.name) + (at ? '(' + esc(at) + ' )' : ' (hiện tại)') + '</h2>' +
            (kv.length ? '<div class="t-list">' + kv.map(([k, v]) =>
              '<div class="t-row static">' + ico('dot') + '<div class="tr-main"><div class="tr-title">' +
              esc(k + ': ' + v) + '</div></div></div>').join('') + '</div>'
              : '<div class="t-empty">Thời điểm này chưa có dữ kiện nào về nó</div>');
        } catch (e) { out.innerHTML = '<div class="t-empty">' + esc(e.message) + '</div>'; }
      };
    }

    async function arcView(host2, slug2, ent) {
      loading(host2, 'Đang đọc cung…');
      let d;
      try { d = await get('/api/world/arc', { slug: slug2, entityId: ent.id }); }
      catch (e) { d = { arc: null }; }
      const a = d.arc || {};
      const tps = a.turningPoints || [];
      host2.innerHTML =
        '<div class="t-form">' +
        '<div class="t-field"><label>Người này muốn gì</label><input class="t-input" data-goal value="' + esc(a.goal || '') + '"></div>' +
        '<div class="t-field"><label>Vì sao (động cơ)</label><textarea class="t-area" data-motive rows="2">' + esc(a.motive || '') + '</textarea></div>' +
        '</div>' +
        '<h2 class="st-h">Các nút thay đổi</h2>' +
        '<div class="t-list">' + (tps.length ? tps.map((t, i) =>
          '<div class="t-row static">' + ico('clock') + '<div class="tr-main"><div class="tr-title">' +
          esc(t.what || t.note || '') + '</div><div class="tr-sub">' + esc(t.at || '') + '</div></div></div>').join('')
          : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">Chưa ghi nút thay đổi nào</div></div></div>') + '</div>' +
        '<div class="t-bar" style="margin-top:var(--sp-3)"><button class="t-btn" data-addtp>Thêm một nút</button>' +
        '<button class="t-btn pri" data-save>Lưu</button></div>';
      let list = tps.slice();
      host2.querySelector('[data-addtp]').onclick = async () => {
        const at = await ask('Ở thời điểm nào', '', { placeholder: 'Tên thời điểm, VD: đêm vào thành' });
        if (!at) return;
        const what = await ask('Đã thay đổi điều gì', '', { placeholder: 'VD: lần đầu giết người' });
        if (!what) return;
        list.push({ at, what });
        tps.push({ at, what });
        arcView(host2, slug2, ent);
      };
      host2.querySelector('[data-save]').onclick = async () => {
        try {
          await post('/api/world/arc', { slug: slug2, entityId: ent.id,
            goal: host2.querySelector('[data-goal]').value,
            motive: host2.querySelector('[data-motive]').value, turningPoints: list });
          toast('Đã lưu'); hap();
        } catch (e) { toast('Không lưu được: ' + e.message); }
      };
    }

    async function renderTimeline() {
      const gen = ++worldGen;   // 每次重绘自己领一个代次；晚回来的旧请求直接被丢掉
      loading(pane, 'Đang đọc dòng thời gian…');
      let d;
      try { d = await get('/api/world/timeline', { slug }); }
      catch (e) { if (gen === worldGen) empty(pane, 'Không đọc được: ' + e.message); return; }
      const ms = d.moments || [];
      const dated = {};
      try {
        const t = await get('/api/world/moment/times', { slug });
        (t.moments || []).forEach((x) => {
          // 有历法就用历法日期，没有就退回"第 N 天" —— 但一定说得清是哪个时刻
          if (x.abs_day != null) dated[x.id] = x.my_text || ('Ngày ' + x.abs_day + '');
        });
      } catch (e) { /* 没定过时间就算了，不是错误 */ }
      if (gen !== worldGen) return;   // 切走了就别改屏幕
      pane.innerHTML =
        '<div class="t-bar"><button class="t-btn pri" data-add>Thêm một thời điểm</button>' +
        '<button class="t-btn" data-state>Tra người nào đó lúc ấy</button>' +
        '<button class="t-btn" data-retro>Quay về một thời điểm</button></div>' +
        '<div class="t-hint" style="margin-bottom:var(--sp-3)">Thời điểm là «một mốc thời gian trong truyện». ' +
        ' Đặt thời gian cho thời điểm (theo lịch của bạn) thì thứ tự sẽ tự sắp; kể ngược, hồi tưởng, tiền truyện đều không bị lộ sơ hở.</div>' +
        '<div class="t-list">' + (ms.length ? ms.map((m, i) =>
          '<div class="t-row static">' + ico('clock') +
          '<div class="tr-main"><div class="tr-title">' + esc(m.label) + '</div>' +
          '<div class="tr-sub">' + esc([dated[i] || m.time_text || 'Chưa đặt thời gian',
            (m.episodes || []).length ? ((m.episodes || []).length + ' sự việc') : ''].filter(Boolean).join(' · ')) + '</div>' +
          ((m.episodes || []).length ? '<div class="tr-sub wrap">' + esc((m.episodes || []).map((e) => e.title).join(', ')) + '</div>' : '') +
          '</div><button class="t-btn sm" data-settime="' + i + '">Đặt thời gian</button>' +
          '<button class="t-btn sm" data-addep="' + i + '">Thêm việc</button>' +
          '<button class="t-btn sm dim" data-rm="' + i + '">Xóa</button></div>').join('')
          : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">Chưa có thời điểm nào</div></div></div>') + '</div>';
      pane.querySelectorAll('[data-settime]').forEach((b) => {
        b.onclick = async () => {
          const m = ms[Number(b.dataset.settime)];
          hap();
          push('Đặt thời gian: ' + m.label, (h3) => momentTimeForm(h3, slug, m, () => renderTimeline()));
        };
      });
      pane.querySelector('[data-retro]').onclick = async () => {
        hap();
        push('Quay về', (h3) => retroView(h3, slug, ms));
      };
      pane.querySelector('[data-add]').onclick = async () => {
        const label = await ask('Thời điểm này tên là gì', '', { placeholder: 'VD: đêm vào thành / ba năm sau / ngày thức tỉnh năng lực' });
        if (!label) return;
        const timeText = await ask('Thời gian trong truyện (có thể để trống)', '', { placeholder: 'VD: mùa đông năm thứ hai' });
        try { await post('/api/world/moment', { slug, label, timeText: timeText || '' }); toast('Đã thêm'); hap(); renderTimeline(); }
        catch (e) { toast('Không thêm được: ' + e.message); }
      };
      pane.querySelectorAll('[data-addep]').forEach((b) => {
        b.onclick = async () => {
          const m = ms[Number(b.dataset.addep)];
          const title = await ask('Đã xảy ra chuyện gì', '', { placeholder: 'VD: lần đầu gặp nàng' });
          if (!title) return;
          try { await post('/api/world/episode', { slug, momentId: m.id, title }); toast('Đã ghi lại'); hap(); renderTimeline(); }
          catch (e) { toast('Không ghi được: ' + e.message); }
        };
      });
      pane.querySelectorAll('[data-rm]').forEach((b) => {
        b.onclick = async () => {
          const m = ms[Number(b.dataset.rm)];
          if (!(await confirmBox('Xóa «' + m.label + '» thời điểm này?', true))) return;
          try { await del('/api/world/moment', { slug, id: m.id }); renderTimeline(); }
          catch (e) { toast('Không xóa được: ' + e.message); }
        };
      });
      pane.querySelector('[data-state]').onclick = () => push('Tra trạng thái', (h2) => stateView(h2, slug, ''));
    }

    async function renderRelations() {
      const gen = ++worldGen;   // 每次重绘自己领一个代次；晚回来的旧请求直接被丢掉
      loading(pane, 'Đang đọc quan hệ…');
      let d;
      try { d = await get('/api/world/relations', { slug }); }
      catch (e) { if (gen === worldGen) empty(pane, 'Không đọc được: ' + e.message); return; }
      if (gen !== worldGen) return;   // 切走了就别改屏幕
      const items = d.items || [];
      pane.innerHTML =
        '<div class="t-bar"><button class="t-btn pri" data-add>Thêm một quan hệ</button></div>' +
        '<div class="t-list">' + (items.length ? items.map((r, i) =>
          '<div class="t-row static">' + ico('link') +
          '<div class="tr-main"><div class="tr-title">' + esc(r.from_name + ' —' + r.kind + '→ ' + r.to_name) + '</div>' +
          '<div class="tr-sub">' + esc(['Độ mạnh ' + (r.strength || 3), r.since ? ('từ ' + r.since) : '',
            r.until ? ('tới ' + r.until) : '', r.note || ''].filter(Boolean).join(' · ')) + '</div></div>' +
          '<button class="t-btn sm dim" data-rm="' + i + '">Xóa</button></div>').join('')
          : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">Chưa có quan hệ nào. Quan hệ cũng có thể thay đổi theo thời gian (kiểu chương 5 trở mặt).</div></div></div>') + '</div>';
      pane.querySelector('[data-add]').onclick = () => push('Thêm quan hệ', (h2) => relationForm(h2, slug, () => renderRelations()));
      pane.querySelectorAll('[data-rm]').forEach((b) => {
        b.onclick = async () => {
          const r = items[Number(b.dataset.rm)];
          if (!(await confirmBox('Xóa quan hệ này?'))) return;
          try { await del('/api/world/relation', { slug, id: r.id }); renderRelations(); }
          catch (e) { toast('Không xóa được: ' + e.message); }
        };
      });
    }

    function relationForm(host2, slug2, after) {
      host2.innerHTML =
        '<div class="t-form">' +
        '<div class="t-field"><label>Ai</label><input class="t-input" data-from placeholder="Tên"></div>' +
        '<div class="t-field"><label>Thế nào</label><input class="t-input" data-kind placeholder="VD: thầy trò / đối địch / anh em"></div>' +
        '<div class="t-field"><label>Với ai</label><input class="t-input" data-to placeholder="Tên"></div>' +
        '<div class="t-field"><label>Độ mạnh (1-5)</label><input class="t-input" data-strength type="number" value="3"></div>' +
        '<div class="t-field"><label>Bắt đầu từ thời điểm nào (có thể trống)</label><input class="t-input" data-since placeholder="Tên thời điểm"></div>' +
        '</div><div class="t-bar"><button class="t-btn pri" data-save>Lưu</button></div>';
      host2.querySelector('[data-save]').onclick = async () => {
        const v = (s) => host2.querySelector(s).value.trim();
        try {
          await post('/api/world/relation', { slug: slug2, from: v('[data-from]'),
            kind: v('[data-kind]') || 'quen biết', to: v('[data-to]'),
            strength: Number(v('[data-strength]')) || 3, since: v('[data-since]') });
          toast('Đã lưu'); hap(); after(); U().back();
        } catch (e) { toast('Không lưu được: ' + e.message); }
      };
    }

    /* 定时间：写「开元 1024 年 3 月」这样的文本，按这本书的历法换算成绝对序号 */
    async function momentTimeForm(host3, slug3, moment, after) {
      loading(host3, 'Đang đọc lịch…');
      let cals = [];
      try { cals = (await get('/api/world/calendars', { slug: slug3 })).items || []; }
      catch (e) { empty(host3, 'Không đọc được lịch: ' + e.message); return; }
      const cur = cals[0] || { name: 'Dương lịch' };
      host3.innerHTML =
        '<div class="t-form">' +
        '<div class="t-field"><label>Dùng bộ lịch nào</label><div class="t-chips" data-mt-chips>' +
        cals.map((c, i) => '<button class="t-chip' + (i === 0 ? ' on' : '') + '" data-mt-chip="' + i + '">' +
          esc(c.name) + (c.builtin ? '' : ' (tự tạo)') + '</button>').join('') + '</div></div>' +
        '<div class="t-field"><label>«' + esc(moment.label) + '» là khi nào</label>' +
        '<input class="t-input" data-mt-text placeholder="VD: Đệ tam kỷ năm 4 tháng 1 ngày 1 / năm 221 TCN tháng 3 ngày 5"></div>' +
        '<div class="t-hint" data-mt-preview style="margin:0 0 var(--sp-2)">Viết xong bấm «Quy đổi thử»</div>' +
        '</div>' +
        '<div class="t-bar"><button class="t-btn" data-mt-check>Quy đổi thử</button>' +
        '<button class="t-btn pri" data-mt-save>Đặt thời gian này</button></div>' +
        '<div class="t-hint">Đặt xong sẽ tự sắp lại thứ tự thời điểm theo thời gian (cái chưa đặt thời gian xếp sau).</div>';
      let ci = 0;
      const textOf = () => host3.querySelector('[data-mt-text]').value.trim();
      const showPreview = (z) => {
        host3.querySelector('[data-mt-preview]').textContent = z.ok
          ? ('= ' + z.date_text + ' (số thứ tự tuyệt đối ' + z.abs + ')')
          : (z.error || 'Không hiểu thời gian này');
      };
      host3.querySelectorAll('[data-mt-chip]').forEach((b) => {
        b.onclick = () => {
          hap(); ci = Number(b.dataset.mtChip);
          host3.querySelectorAll('[data-mt-chip]').forEach((x) => x.classList.toggle('on', x === b));
        };
      });
      host3.querySelector('[data-mt-check]').onclick = async () => {
        hap();
        try { showPreview(await post('/api/world/calendar/convert',
          { slug: slug3, text: textOf(), calendar: cals[ci].name })); }
        catch (e) { showPreview({ ok: false, error: 'Không quy đổi được: ' + e.message }); }
      };
      host3.querySelector('[data-mt-save]').onclick = async () => {
        if (!textOf()) { toast('Hãy ghi thời gian trước'); return; }
        try {
          const r = await post('/api/world/moment/time',
            { slug: slug3, momentId: moment.id, text: textOf(), calendar: cals[ci].name });
          toast('Đã đặt: ' + r.dateText); hap(); after();
        } catch (e) { toast('Không đặt được: ' + e.message); }
      };
    }

    /* 回溯：给定时刻 + 主体 → 那一刻的完整状态，每条事实都带出处 */
    async function retroView(host3, slug3, ms) {
      const at = await ask('Quay về thời điểm nào', '', { placeholder: 'Tên thời điểm; để trống = trạng thái mới nhất' });
      if (at === null) return;
      loading(host3, 'Đang suy tính thời điểm đó…');
      let d;
      try { d = await get('/api/world/retro', { slug: slug3, at: at || '' }); }
      catch (e) { empty(host3, 'Không quay về được: ' + e.message); return; }
      if (d.error) { empty(host3, d.error); return; }
      const ents = d.entities || [];
      const rows = ents.map((e) => {
        const fs = e.facts || [];
        return '<h2 class="st-h">' + esc(e.name) + '</h2>' +
          '<div class="t-list">' + (fs.length ? fs.map((f) => (
            '<div class="t-row static">' + ico('dot') +
            '<div class="tr-main"><div class="tr-title">' + esc(f.key + ': ' + f.value) + '</div>' +
            '<div class="tr-sub wrap">' + esc([f.sinceLabel ? ('Từ «' + f.sinceLabel + '» trở đi') : 'Có từ đầu',
              f.source || 'Chưa ghi nguồn',
              (f.evidence && f.evidence[0])
                ? ('dòng ' + f.evidence[0].line + ' «' + String(f.evidence[0].quote || '').slice(0, 18) + '»') : '',
            ].filter(Boolean).join(' · ')) + '</div></div></div>')).join('')
            : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">Thời điểm đó chưa có ghi chép nào về người này</div></div></div>') +
          '</div>';
      }).join('');
      host3.innerHTML =
        '<div class="t-hint" style="margin-bottom:var(--sp-3)">Đang xem thế giới tại «' +
        esc(d.cutoffLabel || 'Trạng thái mới nhất') + '». Mỗi dữ kiện đều ghi rõ đến từ chương nào, dòng nào. ' +
        ' (Lần suy tính này chỉ cộng dồn thay đổi trong cửa sổ, không chạy lại cả cuốn.)</div>' +
        (ents.length ? rows : '<div class="t-empty">Lúc đó thế giới chưa có ai</div>');
    }

    /* 历法：定义自己的历法（月长 / 闰年 / 纪元），并换算、排序 */
    async function renderCalendar() {
      const gen = ++worldGen;   // 每次重绘自己领一个代次；晚回来的旧请求直接被丢掉
      loading(pane, 'Đang đọc lịch…');
      let cals = [];
      try { cals = (await get('/api/world/calendars', { slug })).items || []; }
      catch (e) { if (gen === worldGen) empty(pane, 'Không đọc được: ' + e.message); return; }
      if (gen !== worldGen) return;
      const fmtMonths = (c) => (c.desc && c.desc.months ? c.desc.months.join('/') : '');
      pane.innerHTML =
        '<div class="t-bar"><button class="t-btn pri" data-newcal>Định nghĩa một bộ lịch</button>' +
        '<button class="t-btn" data-conv>Quy đổi</button>' +
        '<button class="t-btn" data-sort>Sắp lại thời điểm theo thời gian</button></div>' +
        '<div class="t-hint" style="margin-bottom:var(--sp-3)">Thế giới giả tưởng có thể có năm tháng ngày riêng: một tháng mấy ngày, mấy năm nhuận một lần đều do bạn quyết. ' +
        ' Đặt xong, thời điểm sẽ tự xếp trước sau, quay về cũng tính theo nó.</div>' +
        '<div class="t-list">' + cals.map((c, i) =>
          '<div class="t-row static">' + ico('clock') +
          '<div class="tr-main"><div class="tr-title">' + esc(c.name) +
          (c.builtin ? ' (dựng sẵn)' : '') + '</div>' +
          '<div class="tr-sub wrap">' + esc([(c.desc && c.desc.leapText) || '',
            (c.desc && c.desc.months) ? ('Một năm ' + c.desc.yearDays + ' ngày') : '',
            (c.desc && c.desc.eras || []).length ? ('Kỷ nguyên: ' + (c.desc.eras || []).join(', ')) : '',
            c.note || ''].filter(Boolean).join(' · ')) + '</div>' +
          (c.desc && c.desc.months ? '<div class="tr-sub wrap">Số ngày mỗi tháng: ' + esc(fmtMonths(c)) + '</div>' : '') +
          '</div>' + (c.builtin ? '' : '<button class="t-btn sm dim" data-rmcal="' + i + '">Xóa</button>') +
          '</div>').join('') + '</div>';

      pane.querySelector('[data-newcal]').onclick = () => { hap(); push('Lịch mới', (h) => calendarForm(h, slug, () => renderCalendar())); };
      pane.querySelector('[data-conv]').onclick = () => { hap(); push('Quy đổi', (h) => convertForm(h, slug, cals, () => renderCalendar())); };
      pane.querySelector('[data-sort]').onclick = async () => {
        try { const r = await post('/api/world/reorder', { slug }); toast('Đã sắp lại ' + r.moved + ' thời điểm'); hap(); renderCalendar(); }
        catch (e) { toast('Không sắp được: ' + e.message); }
      };
      pane.querySelectorAll('[data-rmcal]').forEach((b) => {
        b.onclick = async () => {
          const c = cals[Number(b.dataset.rmcal)];
          if (!(await confirmBox('Xóa «' + c.name + '» bộ lịch này?', true))) return;
          try { await del('/api/world/calendar', { slug, name: c.name }); toast('Đã xóa'); hap(); renderCalendar(); }
          catch (e) { toast('Không xóa được: ' + e.message); }
        };
      });
    }

    async function calendarForm(host3, slug3, after) {
      host3.innerHTML =
        '<div class="t-form">' +
        '<div class="t-field"><label>Tên lịch</label><input class="t-input" data-cal-name placeholder="VD: Tứ Thời lịch / Đại Diễn lịch"></div>' +
        '<div class="t-field"><label>Một năm mấy tháng, mỗi tháng mấy ngày</label>' +
        '<input class="t-input" data-cal-months placeholder="VD: 30,30,30,30,30,30,30,30,30,30,30,30"></div>' +
        '<div class="t-field"><label>Tên kỷ nguyên (có thể để trống)</label><input class="t-input" data-cal-era placeholder="VD: Đệ tam kỷ"></div>' +
        '<div class="t-field"><label>Mấy năm nhuận một lần (0 = không nhuận)</label><input class="t-input" data-cal-every placeholder="VD: 3"></div>' +
        '<div class="t-field"><label>Nhuận tháng nào, thêm mấy ngày</label>' +
        '<input class="t-input" data-cal-leap placeholder="VD: 5,5 nghĩa là năm nhuận tháng 5 thêm 5 ngày"></div>' +
        '</div>' +
        '<div class="t-bar"><button class="t-btn pri" data-cal-save>Lưu lại</button></div>' +
        '<div class="t-hint">Chưa hiểu thì cứ chép theo: một tháng 40 ngày × 10 tháng, cứ 3 năm nhuận một lần, năm nhuận tháng 5 thêm 5 ngày.</div>';
      host3.querySelector('[data-cal-save]').onclick = async () => {
        const name = host3.querySelector('[data-cal-name]').value.trim();
        const months = host3.querySelector('[data-cal-months]').value.split(/[,，\/\s]+/).filter(Boolean).map(Number);
        if (!name) { toast('Đặt tên'); return; }
        if (!months.length || months.some((n) => !(n > 0))) { toast('Số ngày mỗi tháng phải ghi bằng số, cách nhau bằng dấu phẩy'); return; }
        const every = Number(host3.querySelector('[data-cal-every]').value || 0);
        const lp = host3.querySelector('[data-cal-leap]').value.split(/[,，\s]+/).filter(Boolean).map(Number);
        const era = host3.querySelector('[data-cal-era]').value.trim();
        const def = { months, leap_rule: every > 0 ? { every } : {}, leap_month: lp[0] || 1,
          leap_days: lp[1] || 0, year_zero: true, week: 7,
          eras: era ? [{ name: era, sign: 1 }] : [],
          anchor: { year: 1, month: 1, day: 1, abs: 0 } };
        try { await post('/api/world/calendar', { slug: slug3, name, def }); toast('Đã tạo xong'); hap(); after(); }
        catch (e) { toast('Không lưu được: ' + e.message); }
      };
    }

    async function convertForm(host3, slug3, cals, after) {
      host3.innerHTML =
        '<div class="t-form">' +
        '<div class="t-field"><label>Dùng bộ lịch nào</label><div class="t-chips" data-cal-chips>' +
        cals.map((c, i) => '<button class="t-chip' + (i === 0 ? ' on' : '') + '" data-cal-chip="' + i + '">' +
          esc(c.name) + '</button>').join('') + '</div></div>' +
        '<div class="t-field"><label>Thời gian trong truyện</label>' +
        '<input class="t-input" data-conv-text placeholder="VD: Đệ tam kỷ năm 4 tháng 1 ngày 1"></div>' +
        '<div class="t-field"><label>Hoặc: số thứ tự tuyệt đối (tra ngược)</label>' +
        '<input class="t-input" data-conv-abs placeholder="VD: 1205"></div>' +
        '</div>' +
        '<div class="t-bar"><button class="t-btn pri" data-conv-go>Quy đổi</button></div>' +
        '<div class="t-form"><div class="t-field"><label>Kết quả</label>' +
        '<div class="t-hint" data-conv-out style="margin:0">Chưa tính</div></div></div>';
      let ci = 0;
      host3.querySelectorAll('[data-cal-chip]').forEach((b) => {
        b.onclick = () => { hap(); ci = Number(b.dataset.calChip); host3.querySelectorAll('[data-cal-chip]').forEach((x) => x.classList.toggle('on', x === b)); };
      });
      host3.querySelector('[data-conv-go]').onclick = async () => {
        hap();
        const abs = host3.querySelector('[data-conv-abs]').value.trim();
        const text = host3.querySelector('[data-conv-text]').value.trim();
        const out = host3.querySelector('[data-conv-out]');
        try {
          const r = abs !== ''
            ? await post('/api/world/calendar/convert', { slug: slug3, abs: Number(abs), calendar: cals[ci].name })
            : await post('/api/world/calendar/convert', { slug: slug3, text, calendar: cals[ci].name });
          out.textContent = r.ok ? (r.direction + ': ' + r.date_text + ' (số thứ tự tuyệt đối ' + r.abs + ')')
            : (r.error || 'Không hiểu');
        } catch (e) { out.textContent = 'Không tính được: ' + e.message; }
      };
    }

    /* 「整理」页只在自己被点时才动（没有先 await 再改屏的竞态），不需要代次 */
    async function renderTools() {
      pane.innerHTML =
        '<div class="t-bar"><button class="t-btn" data-lore>Thu từ thư mục thiết lập</button>' +
        '<button class="t-btn" data-ex>Nhận tên người từ chính văn</button>' +
        '<button class="t-btn primary" data-fx>Nhận dữ kiện từ thiết lập</button></div>' +
        '<div class="t-hint" style="margin-bottom:var(--sp-3)">«Thu thiết lập» biến mỗi bài thiết lập trong lorebook thành một thực thể + một tư liệu; ' +
        ' «Nhận tên người» chỉ thống kê trong chính văn, kết quả là ứng viên, thu hay không do bạn quyết. ' +
        ' «**Nhận dữ kiện**» nhận từng dòng «**Thuộc tính**: giá trị» trong tệp thiết lập (đã chia theo nhân vật), bạn tích xong thì thu một chạm —— ' +
        ' đây là bước thực sự đưa thiết lập vào động cơ thế giới.</div>' +
        '<div data-out></div>';
      const out = pane.querySelector('[data-out]');
      pane.querySelector('[data-lore]').onclick = async () => {
        loading(out, 'Đang thu thiết lập…');
        try {
          const r = await post('/api/world/import-lorebook', { slug });
          out.innerHTML = '<div class="t-hint">Đã thu ' + r.imported + ' mục, bỏ qua ' + r.skipped + ' mục (kiểu trang mục lục).</div>';
          toast('Đã thu xong'); hap();
        } catch (e) { out.innerHTML = '<div class="t-empty">Không thu được: ' + esc(e.message) + '</div>'; }
      };
      /* 从设定里认事实（监督人 2026-09-21 加）：
         设定文件本来就是 `<属性>：<值>` 的结构，后端纯本地规则认出来 → 这里勾选 → 一键收下。
         以前世界引擎里"事实 0 条、关系 0 条"，所以这个面板点开就是空的。 */
      pane.querySelector('[data-fx]').onclick = async () => {
        loading(out, 'Đang lật thiết lập, nhận dữ kiện…');
        let r;
        try { r = await post('/api/world/extract-facts', { slug }); }
        catch (e) { out.innerHTML = '<div class="t-empty">Không nhận được: ' + esc(e.message) + '</div>'; return; }
        const fs = r.facts || [];
        if (!fs.length) {
          out.innerHTML = '<div class="t-hint">Không nhận ra dữ kiện mới (có thể đã thu hết rồi). Đã quét ' + (r.files || 0) + ' tệp thiết lập.</div>';
          return;
        }
        const byEnt = {};
        fs.forEach((x, i) => { (byEnt[x.entity] = byEnt[x.entity] || []).push(Object.assign({ _i: i }, x)); });
        out.innerHTML = '<h2 class="st-h">Nhận ra từ thiết lập <b>' + fs.length + '</b> dữ kiện (bỏ tích cái không cần, phần còn lại sẽ thu)</h2>' +
          Object.keys(byEnt).map((k) =>
            '<div class="t-hint" style="margin:var(--sp-3) 0 var(--sp-1)"><b>' + esc(k) + '</b> · ' + byEnt[k].length + ' mục</div>' +
            byEnt[k].map((x) =>
              '<label style="display:flex;gap:var(--sp-2);align-items:flex-start;padding:var(--sp-2) 0">' +
              '<input type="checkbox" checked data-f="' + x._i + '">' +
              '<span><b>' + esc(x.section ? x.section + ' · ' : '') + esc(x.key) + '</b>: ' +
              esc(String(x.value).slice(0, 70)) + '</span></label>').join('')).join('') +
          '<div class="t-bar" style="margin-top:var(--sp-3)">' +
          '<button class="t-btn primary" data-save>Thu các mục đã tích</button>' +
          '<button class="t-btn" data-all>Bỏ chọn tất cả</button></div>';
        out.querySelector('[data-all]').onclick = () => {
          const cs = [...out.querySelectorAll('input[data-f]')];
          const anyOn = cs.some((c) => c.checked);
          cs.forEach((c) => { c.checked = !anyOn; });
          out.querySelector('[data-all]').textContent = anyOn ? 'Chọn tất cả' : 'Bỏ chọn tất cả';
        };
        out.querySelector('[data-save]').onclick = async () => {
          const picks = [...out.querySelectorAll('input[data-f]:checked')].map((c) => fs[+c.dataset.f]);
          if (!picks.length) { toast('Chưa tích mục nào'); return; }
          loading(out, 'Đang thu ' + picks.length + ' dữ kiện…');
          let ok = 0, bad = 0;
          for (const x of picks) {
            try {
              await post('/api/world/fact', { slug, entityId: x.entityId, key: x.key,
                value: x.value, sourcePath: x.sourcePath || '', note: x.section || '' });
              ok++;
            } catch (e) { bad++; }
          }
          out.innerHTML = '<div class="t-hint">Đã thu ' + ok + ' mục ' + (bad ? ', thất bại ' + bad + ' mục' : '') +
            '. <br>Vào thẻ «Thực thể» bấm mở một người là thấy dữ kiện thuộc về người đó.</div>';
          toast('Đã thu ' + ok + ' dữ kiện'); hap();
        };
      };
      pane.querySelector('[data-ex]').onclick = async () => {
        loading(out, 'Đang đếm tên người trong chính văn…');
        try {
          const r = await get('/api/world/extract', { slug });
          const items = r.items || [];
          out.innerHTML = '<h2 class="st-h">Tên xuất hiện lặp lại trong chính văn (' + items.length + ' ứng viên)</h2>' +
            (items.length ? '<div class="t-chips">' + items.map((it) =>
              '<button class="t-pill" data-add="' + esc(it.name) + '">' + esc(it.name) + ' · ' + it.count + '</button>').join('') + '</div>' +
              '<div class="t-hint" style="margin-top:var(--sp-3)">Bấm một cái là thu vào thế giới (thu xong có thể bổ sung thân phận, tên khác, ngoại hình).</div>'
              : '<div class="t-empty">Không nhận ra tên mới</div>');
          out.querySelectorAll('[data-add]').forEach((b) => {
            b.onclick = async () => {
              try { await post('/api/world/entity', { slug, kind: 'character', name: b.dataset.add }); toast('Đã thu vào thế giới'); hap(); b.classList.add('ok'); }
              catch (e) { toast('Không thu được: ' + e.message); }
            };
          });
        } catch (e) { out.innerHTML = '<div class="t-empty">Không đếm được: ' + esc(e.message) + '</div>'; }
      };
    }

    go(tab);
  }

  /* ══════════════════════════════════════════════════════════
     3. 剧情：承载树 / 伏笔账本 / 决策 / 场景
     ══════════════════════════════════════════════════════════ */
  function openPlot(host) { Push.book('Cốt truyện', plotHome); }

  async function plotHome(host, slug, tab) {
    tab = tab || 'tree';
    loading(host, 'Đang đọc cốt truyện…');
    let ov;
    try { ov = await get('/api/plot/overview', { slug }); }
    catch (e) { empty(host, 'Không đọc được: ' + e.message); return; }
    const c = ov.counts || {};
    host.innerHTML =
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + (c.chapters || 0) + '</b><span>Chương</span></div>' +
      '<div class="t-stat"><b>' + (c.promisesOpen || 0) + '</b><span>Phục bút chưa thu hồi</span></div>' +
      '<div class="t-stat"><b>' + (c.promisesPaid || 0) + '</b><span>Đã thu hồi</span></div></div>' +
      '<div class="t-seg wide" data-tabs>' +
      ['tree:Cây chương', 'threads:Tuyến cốt truyện', 'promises:Phục bút', 'decisions:Quyết định', 'scenes:Cảnh']
        .map((s) => { const [k, n] = s.split(':'); return '<button data-tab="' + k + '" class="' +
          (tab === k ? 'on' : '') + '">' + n + '</button>'; }).join('') + '</div>' +
      '<div data-pane style="margin-top:var(--sp-3)"></div>';
    const pane = host.querySelector('[data-pane]');
    const go = (t) => {
      worldTab = t;                       // 返回键再进来时用得上
      /* ⚠ 必须把「现在在哪一页」记回闭包那个 tab：reload() 结尾是 `go(tab)`。
         只改 worldTab 的话 ——「在剧情线页点一下加一条」重画完会跳回承载树，
         用户看到的是「我刚点的页签自己跑了」（e2e-pl 抓到的真 bug）。 */
      tab = t;
      host.querySelectorAll('[data-tabs] button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
      ({ tree: renderTree, threads: renderThreads, promises: renderPromises,
         decisions: renderDecisions, scenes: renderScenes }[t] || renderTree)();
    };
    host.querySelector('[data-tabs]').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]'); if (!b) return;
      hap(); go(b.dataset.tab);
    });

    async function reload() {
      ov = await get('/api/plot/overview', { slug });
      go(tab);
    }

    function renderTree() {
      const chs = ov.chapters || [];
      pane.innerHTML =
        '<div class="t-hint" style="margin-bottom:var(--sp-3)">Các chương xếp theo thứ tự. Mỗi chương thấy được đã viết tới bước nào, mục tiêu bao nhiêu chữ, gắn mấy mục dàn ý chi tiết và phục bút.</div>' +
        '<div class="t-bar"><button class="t-btn pri" data-newch>Tạo chương mới</button></div>' +
        '<div class="t-list">' + (chs.length ? chs.map((ch, i) => {
          const words = ch.words || 0;
          const target = ch.target_words || 0;
          const pct = target ? Math.min(100, Math.round(words / target * 100)) : 0;
          return '<div class="t-row" data-i="' + i + '">' + ico('file') +
            '<div class="tr-main"><div class="tr-title">' + esc(ch.title || ch.path) + '</div>' +
            '<div class="tr-sub">' + esc([words + ' chữ', STATUS_CN[ch.status] || ch.status || 'Bản nháp',
              target ? ('Mục tiêu ' + target) : '', (ch.promises || []).length ? ((ch.promises || []).length + ' phục bút') : '',
            ].filter(Boolean).join(' · ')) + '</div>' +
            (target ? '<div class="st-bar"><i style="width:' + pct + '%"></i></div>' : '') +
            '</div><span class="tr-go">' + window.iconHtml('chevron') + '</span></div>';
        }).join('') : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">Chưa có chương nào</div></div></div>') + '</div>';
      pane.querySelector('[data-newch]').onclick = async () => {
        hap();
        let name = await ask('Chương mới tên là gì', 'Chương ' + String(chs.length + 1).padStart(3, '0') +
          ' - ' + (ov.title || '').slice(0, 8), { placeholder: 'Chương 6 - Tên chương' });
        if (!name) return;
        const shown = name.trim();
        name = (window.VI && VI.chapterName ? VI.chapterName : function (x) { return x; })(name);
        const p = 'manuscript/' + name.trim().replace(/\.md$/, '') + '.md';
        try { await post('/api/chapter/new', { slug, path: p, content: '# ' + shown + '\n\n' }); }
        catch (e) { toast('Không tạo được: ' + e.message); return; }
        toast('Đã tạo xong'); hap(); await reload();
      };
      pane.querySelectorAll('[data-i]').forEach((r) => {
        r.onclick = () => { hap(); const ch = chs[Number(r.dataset.i)]; push('Cốt truyện · ' + ch.title, (h2) => chapterPlot(h2, slug, ch)); };
      });
    }

    async function chapterPlot(host2, slug2, ch) {
      loading(host2, 'Đang đọc chương này…');
      let ol, sc, du;
      try {
        ol = await get('/api/plot/outline', { slug: slug2, path: ch.path });
        du = await get('/api/plot/promises/due', { slug: slug2 });
        sc = ov.scenes.filter((s) => s.chapter_path === ch.path);
      } catch (e) { empty(host2, 'Không đọc được: ' + e.message); return; }
      const outs = ol.items || [];
      const due = (du.items || []).filter((p) => p.due_chapter === ch.path);
      host2.innerHTML =
        '<div class="t-bar"><button class="t-btn" data-draft>Đi viết chương này</button></div>' +
        '<h2 class="st-h">Dàn ý chi tiết</h2>' +
        '<div class="t-list">' + (outs.length ? outs.map((o) =>
          '<div class="t-row static">' + ico(o.approved ? 'check' : 'file') +
          '<div class="tr-main"><div class="tr-title" style="white-space:pre-wrap;font-weight:var(--w-normal)">' + esc(o.body) +
          '</div><div class="tr-sub">' + esc(o.approved ? 'Đã dùng' : 'Chờ xác nhận') + '</div></div></div>').join('')
          : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">Chưa có dàn ý chi tiết, vào bàn viết để tạo</div></div></div>') + '</div>' +
        (due.length ? '<h2 class="st-h">Các tuyến tới hạn cần thu ở chương này</h2><div class="t-list">' + due.map((p) =>
          '<div class="t-row static">' + ico('bookmark') + '<div class="tr-main"><div class="tr-title">' +
          esc(p.name) + '</div><div class="tr-sub">' + esc(p.status === 'paid' ? 'Đã thu hồi' : 'Còn nợ') + '</div></div></div>').join('') + '</div>' : '') +
        '<h2 class="st-h">Cảnh</h2>' +
        '<div class="t-list">' + (sc.length ? sc.map((s) =>
          '<div class="t-row static">' + ico('layers') + '<div class="tr-main"><div class="tr-title">' +
          esc(s.title || '(Cảnh chưa đặt tên)') + '</div><div class="tr-sub">' +
          esc([s.summary || '', (s.cast || []).join(', ')].filter(Boolean).join(' · ')) + '</div></div>' +
          '<button class="t-btn sm dim" data-rm="' + s.id + '">Xóa</button></div>').join('')
          : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">Chương này chưa chia cảnh</div></div></div>') + '</div>' +
        '<div class="t-bar" style="margin-top:var(--sp-3)"><button class="t-btn pri" data-addsc>Thêm một cảnh</button></div>';
      host2.querySelector('[data-draft]').onclick = () => {
        U().back();
        push('Viết · ' + (ch.title || ch.path), (h3) => chapterStudio(h3, slug2, ch));
      };
      host2.querySelector('[data-addsc]').onclick = async () => {
        const title = await ask('Tên cảnh', '', { placeholder: 'VD: Bị chặn ở cổng thành' });
        if (!title) return;
        const summary = await ask('Cảnh này xảy ra gì', '', { placeholder: 'Ai ở đâu làm gì', multiline: true });
        try {
          await post('/api/plot/scene', { slug: slug2, chapterPath: ch.path, title, summary: summary || '' });
          toast('Đã thêm'); hap(); ov = await get('/api/plot/overview', { slug: slug2 });
        } catch (e) { toast('Không thêm được: ' + e.message); }
      };
      host2.querySelectorAll('[data-rm]').forEach((b) => {
        b.onclick = async () => {
          if (!(await confirmBox('Xóa cảnh này?'))) return;
          try { await del('/api/plot/scene', { slug: slug2, id: b.dataset.rm }); toast('Đã xóa'); hap(); U().back(); }
          catch (e) { toast('Không xóa được: ' + e.message); }
        };
      });
    }

    /* 剧情线：主线/支线追踪。
       后端 /plot/overview 早就把 threads 一并返回了（连 counts.threads 都算好了），
       可这个面板以前 4 个页签一条都不显示 —— 数据白算，用户也没地方建。
       这里接上：能看、能建、能删、点开能看它挂了哪些场景（场景本身在「场景」页签里管）。 */
    /* 剧情线 —— 用户把它**当大纲用**：
       ① 防忘（书写长了，AI 记不住前面定过什么）② 防跑偏（别把书带成另一种调子）
       ③ 防 OOC（人物该是什么样，有一个锚）。
       它是**用户和 AI 都能改**的一栏，规矩是：**用户手改过的以用户为准，AI 不会自己覆盖**
       （后端 thread.origin 记着"这条是谁定的"，迁移 0013 加的；AI 那边走 outline_write 工具，
       碰到 origin=user 的条目会直接回"这条是用户定的，我不动"）。
       所以每一行都**把「谁定的」摆出来**，用户一眼能看见自己的改动生效了。 */
    /* 剧情线 —— **内容就是「大纲」**（用户拍板：名字留着，作用换成大纲）。
       这块 UI **一份实现两个入口**：本体在 js/outline.js，
       工具宫格的「故事线」点开也是同一块（）。
       以前这里自己写了一套一模一样的（加/改/删 + 「谁定的」徽标）——
       两套并存正是"UI 不统一"的来源，所以**删掉这一套，改成调那一个**。
       规矩不变（后端 + 工具层有判据，见 tools/check_outline.py）：防忘 / 防跑偏 / 防 OOC，
       **用户手改过的以用户为准，AI 不会自己覆盖**。 */
    function renderThreads() {
      if (!window.Outline) {
        pane.innerHTML = '<div class="t-empty">Mô-đun dàn ý chưa tải (trang thiếu js/outline.js)</div>';
        return;
      }
      window.Outline.mount(pane, slug);
    }

    async function renderPromises() {
      const items = ov.promises || [];
      const open = items.filter((p) => p.status === 'open' || p.status === 'advanced');
      const paid = items.filter((p) => p.status === 'paid');
      const rows = (arr) => arr.map((p) => {
        let steps = [];
        try { steps = JSON.parse(p.advance_json || '[]') || []; } catch (e) { steps = []; }
        return '<div class="t-row static">' + ico('bookmark') +
          '<div class="tr-main"><div class="tr-title">' + esc(p.name) + '</div>' +
          '<div class="tr-sub">' + esc([p.kind === 'foreshadow' ? 'Phục bút' : p.kind,
            p.status === 'paid' ? 'Đã thu hồi' : p.status === 'dropped' ? 'Đã bỏ' : 'Còn nợ',
            p.due_chapter ? ('Dự định ở ' + p.due_chapter) : '', steps.length ? (steps.length + ' lần đẩy tiến') : '',
          ].filter(Boolean).join(' · ')) + '</div>' +
          (p.note ? '<div class="tr-sub wrap">' + esc(p.note) + '</div>' : '') + '</div>' +
          (p.status !== 'paid' ? '<button class="t-btn sm" data-adv="' + p.id + '">Thu hồi</button>' : '') +
          '<button class="t-btn sm" data-step="' + p.id + '">Đẩy tiến</button>' +
          '<button class="t-btn sm dim" data-rm="' + p.id + '">Xóa</button></div>';
      }).join('');
      pane.innerHTML =
        '<div class="t-bar"><button class="t-btn pri" data-add>Gài một phục bút mới</button></div>' +
        '<div class="t-hint" style="margin-bottom:var(--sp-3)">Ở đây ghi lại những lời hứa với người đọc; viết tới chương cần thu hồi sẽ nhắc (chi tiết chương liệt kê các manh mối tới hạn của chương đó).</div>' +
        (open.length ? '<h2 class="st-h">Còn nợ ' + open.length + ' mục</h2><div class="t-list">' + rows(open) + '</div>' : '') +
        (paid.length ? '<h2 class="st-h">Đã thu hồi ' + paid.length + ' mục</h2><div class="t-list">' + rows(paid) + '</div>' : '') +
        (!items.length ? '<div class="t-empty">Chưa có phục bút nào</div>' : '');
      pane.querySelector('[data-add]').onclick = async () => {
        const name = await ask('Gài cái gì', '', { placeholder: 'VD: Thẻ gỗ là ai đưa' });
        if (!name) return;
        const note = await ask('Ghi chú (có thể trống)', '', { placeholder: 'Định thu hồi thế nào' });
        try { await post('/api/plot/promise', { slug, name, note: note || '' }); toast('Đã gài'); hap(); reload(); }
        catch (e) { toast('Không gài được: ' + e.message); }
      };
      pane.querySelectorAll('[data-adv]').forEach((b) => {
        b.onclick = async () => {
          try { await post('/api/plot/promise/advance', { slug, id: Number(b.dataset.adv), status: 'paid' });
            toast('Đã thu hồi'); hap(); reload(); }
          catch (e) { toast('Không ghi được: ' + e.message); }
        };
      });
      pane.querySelectorAll('[data-step]').forEach((b) => {
        b.onclick = async () => {
          const note = await ask('Lần này đẩy tiến thế nào', '', { placeholder: 'VD: nhắc một câu về chữ trên thẻ gỗ' });
          if (note === null) return;
          try { await post('/api/plot/promise/advance', { slug, id: Number(b.dataset.step), note }); toast('Đã ghi lại'); hap(); reload(); }
          catch (e) { toast('Không ghi được: ' + e.message); }
        };
      });
      pane.querySelectorAll('[data-rm]').forEach((b) => {
        b.onclick = async () => {
          if (!(await confirmBox('Xóa phục bút này?'))) return;
          try { await del('/api/plot/promise', { slug, id: b.dataset.rm }); reload(); }
          catch (e) { toast('Không xóa được: ' + e.message); }
        };
      });
    }

    async function renderDecisions() {
      const items = ov.decisions || [];
      pane.innerHTML =
        '<div class="t-bar"><button class="t-btn pri" data-add>Ghi một quyết định</button></div>' +
        '<div class="t-hint" style="margin-bottom:var(--sp-3)">Vì sao viết như vậy, rủi ro ở đâu. Sau này muốn lật lại thì cái cũ cũng không xóa, giữ lại dấu vết.</div>' +
        '<div class="t-list">' + (items.length ? items.map((d, i) =>
          '<div class="t-row static">' + ico('edit') +
          '<div class="tr-main"><div class="tr-title">' + esc(d.title) + '</div>' +
          '<div class="tr-sub wrap">' + esc([d.reason || '', d.risks ? ('Rủi ro: ' + d.risks) : '',
            d.chapter_path || '', ago(d.at)].filter(Boolean).join(' · ')) + '</div>' +
          (d.status === 'superseded' ? '<div class="tr-sub">Đã bị quyết định sau thay thế</div>' : '') + '</div>' +
          (d.status === 'active' ? '<button class="t-btn sm" data-sup="' + d.id + '">Lật lại</button>' : '') +
          '<button class="t-btn sm dim" data-rm="' + d.id + '">Xóa</button></div>').join('')
          : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">Chưa có ghi chép quyết định nào</div></div></div>') + '</div>';
      pane.querySelector('[data-add]').onclick = async () => {
        const title = await ask('Đã quyết định gì', '', { placeholder: 'VD: để nhân vật chính giả yếu trước rồi bùng nổ' });
        if (!title) return;
        const reason = await ask('Vì sao quyết như vậy', '', { placeholder: 'Lý do' });
        const risks = await ask('Có rủi ro gì', '', { placeholder: 'Vấn đề có thể xảy ra' });
        try { await post('/api/plot/decision', { slug, title, reason: reason || '', risks: risks || '' });
          toast('Đã ghi lại'); hap(); reload(); }
        catch (e) { toast('Không ghi được: ' + e.message); }
      };
      pane.querySelectorAll('[data-sup]').forEach((b) => {
        b.onclick = async () => {
          const title = await ask('Đổi thành gì', '', { placeholder: 'Quyết định mới' });
          if (!title) return;
          const reason = await ask('Vì sao đổi', '', { placeholder: 'Lý do' });
          try { await post('/api/plot/decision/supersede', { slug, id: Number(b.dataset.sup), title, reason: reason || '' });
            toast('đã sửa'); hap(); reload(); }
          catch (e) { toast('Không đổi được: ' + e.message); }
        };
      });
      pane.querySelectorAll('[data-rm]').forEach((b) => {
        b.onclick = async () => {
          if (!(await confirmBox('Xóa ghi chép quyết định này?'))) return;
          try { await del('/api/plot/decision', { slug, id: b.dataset.rm }); reload(); }
          catch (e) { toast('Không xóa được: ' + e.message); }
        };
      });
    }

    async function renderScenes() {
      const scenes = ov.scenes || [];
      pane.innerHTML =
        '<div class="t-hint" style="margin-bottom:var(--sp-3)">Cảnh là «một màn diễn trong một chương», có thể gắn thời điểm thế giới, địa điểm và người xuất hiện.</div>' +
        '<div class="t-list">' + (scenes.length ? scenes.map((s) =>
          '<div class="t-row static">' + ico('layers') +
          '<div class="tr-main"><div class="tr-title">' + esc(s.title || '(Chưa đặt tên)') + '</div>' +
          '<div class="tr-sub wrap">' + esc([s.chapter_path, s.summary || '',
            (s.cast || []).join(', ')].filter(Boolean).join(' · ')) + '</div></div>' +
          '<button class="t-btn sm dim" data-rm="' + s.id + '">Xóa</button></div>').join('')
          : '<div class="t-empty">Chưa chia cảnh nào</div>') + '</div>';
      pane.querySelectorAll('[data-rm]').forEach((b) => {
        b.onclick = async () => {
          if (!(await confirmBox('Xóa cảnh này?'))) return;
          try { await del('/api/plot/scene', { slug, id: b.dataset.rm }); reload(); }
          catch (e) { toast('Không xóa được: ' + e.message); }
        };
      });
    }

    go(tab);
  }

  /* ══════════════════════════════════════════════════════════
     通用小件：页签壳 / 分数色 / 日期
     ══════════════════════════════════════════════════════════ */

  /* 每个「一屏多页签」的面板都用它，省得各写一套页签逻辑。
     renders[k](pane, repaint)：pane 是这一页的容器，repaint 重新画这一页。 */
  /* 页签记性：从「说话方式 / 改一条参考」这类子页返回时，要回到刚才那一屏，
     别一脚踢回第一个页签（用户会以为点错了）。**跟世界面板同一个规矩**。 */
  const LAST_TAB = {};
  function tabShell(host, defs, renders) {
    const sig = defs.map(([k]) => k).join('|');
    const start = defs.some(([k]) => k === LAST_TAB[sig]) ? LAST_TAB[sig] : defs[0][0];
    host.innerHTML =
      '<div class="t-seg wide" data-tabs>' + defs.map(([k, l]) =>
        '<button data-tab="' + esc(k) + '"' + (k === start ? ' class="on"' : '') + '>' +
        esc(l) + '</button>').join('') +
      '</div>' +
      defs.map(([k]) => '<div data-pane="' + esc(k) + '" style="margin-top:var(--sp-3)"' +
        (k === start ? '' : ' hidden') + '></div>').join('');
    const paint = (k) => {
      const el = host.querySelector('[data-pane="' + k + '"]');
      if (!el) return;
      try { renders[k](el, () => paint(k)); }
      catch (e) { el.innerHTML = '<div class="t-empty">Có lỗi: ' + esc(e.message || e) + '</div>'; }
    };
    host.querySelector('[data-tabs]').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]'); if (!b) return;
      hap();
      LAST_TAB[sig] = b.dataset.tab;
      host.querySelectorAll('[data-tabs] button').forEach((x) => x.classList.toggle('on', x === b));
      host.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.tab; });
      paint(b.dataset.tab);
    });
    paint(start);
  }

  /* 评分颜色：阈值**不写死在前端**，从 `/api/lint/rules` 的 gradeBands 读（后端 GRADE_BANDS 是唯一出处）。
     规则：≥90 绿（ok）/ 75–89 黄（mid）/ <75 红（warn）。接口拿不到时才退回这三个默认值。
     ——踩过的坑：以前前端写 85/70、后端用 90/75，同一本书两个界面两个颜色。 */
  let BANDS = [{ min: 90, name: 'Sạch' }, { min: 75, name: 'Tạm được' }, { min: 0, name: 'Cần sửa' }];
  let bandsAsked = false;
  /* 懒加载：**进质检页时**才去问后端要阈值。
     以前是脚本一加载就发请求 —— 那时候人还没登录，每次都吃一个 401，
     前端的"失败请求"统计里永远挂着一条假问题。 */
  async function loadBands() {
    if (bandsAsked) return;
    bandsAsked = true;
    try {
      const d = await API.raw('api/lint/rules');
      if (d && Array.isArray(d.gradeBands) && d.gradeBands.length) {
        BANDS = d.gradeBands.slice().sort((a, b) => b.min - a.min);
      }
    } catch (e) { /* 拿不到就用默认三段，不拦着人看 */ }
  }
  const bandOf = (s) => BANDS.find((b) => s >= b.min) || BANDS[BANDS.length - 1];
  /* 预算好的三段类名（阈值仍来自 gradeBands 的 min，不在这里另写一套数字）：
     ≥90 绿 ok，75–89 黄 mid，<75 红 warn。 */
  const pillOf = (s) => { const b = bandOf(s); return b.min >= 90 ? 'ok' : b.min >= 75 ? 'mid' : 'warn'; };
  window.LintScoreClass = pillOf;   // 给自测用（e2e-ui.js 会喂 92/88/80 断言颜色段）
  const gradeText = (s) => (s >= 90 ? 'Sạch: hầu như không có mùi máy'
    : s >= 75 ? 'Tạm được: vài chỗ tiện tay là sửa được'
    : s >= 50 ? 'Hơi có giọng AI: nên sửa một chút rồi hãy viết tiếp'
    : 'AI giọng rất nặng: quá nhiều từ đệm và sáo ngữ, nên rà lại cả chương');
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  const fmtDate = (d) => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());

  /* 让浏览器去下文件。
     App 里页面是 file:// 的、拿不到 cookie，所以地址经过 API.media()：指向本机 127.0.0.1 并带上口令 */
  function download(url) {
    const a = document.createElement('a');
    a.href = window.API.media(url); a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  }

  /* 带文件的表单（导入用）。和 api.js 的 j() 一样把错误说清楚，只是 body 是 FormData。 */
  async function upload(path, fd) {
    const r = await fetch(window.API.abs(path), { method: 'POST', credentials: 'include', body: fd });
    if (r.status === 401) { App.needLogin(); throw new Error('Chưa đăng nhập'); }
    const txt = await r.text();
    let d = null; try { d = txt ? JSON.parse(txt) : null; } catch (e) { d = txt; }
    if (!r.ok) throw new Error((d && (d.detail || d.message)) || ('thất bại ' + r.status));
    return d;
  }

  /* ══════════════════════════════════════════════════════════
     4. 质检：扫 AI 味 / 一键修 / 规则表
     ══════════════════════════════════════════════════════════ */
  function openLint(host) { Push.book('Soát lỗi', lintHome); }

  function lintHome(host, slug) {
    tabShell(host, [['book', 'Toàn sách'], ['one', 'Một chương'], ['voice', 'Giọng nói'],
                    ['body', 'Khám tổng quát'], ['rules', 'Quy tắc']], {
      book: (pane, repaint) => lintBook(pane, slug, repaint),
      voice: (pane) => lintVoice(pane, slug),
      body: (pane) => lintBody(pane, slug),
      one: (pane) => chapterPicker(pane, slug, (ch) => {
        push('Soát lỗi · ' + (ch.name || ch.path), (h2) => lintChapter(h2, slug, ch.path));
      }, { hint: 'Bấm một chương để soát giọng AI của nó' }),
      rules: (pane) => lintRules(pane),
    });
  }

  function scoreLine(c) {
    const cats = Object.entries(c.byCategory || {}).filter(([, n]) => n)
      .sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, n]) => k + ' ' + n).join(', ');
    return (c.hits || 0) + ' chỗ ' + (cats ? ' · ' + cats : '') + ' · ' + (c.chars || 0) + ' chữ';
  }

  async function lintBook(pane, slug, repaint) {
    loading(pane, 'Đang quét từng chương…');
    let d;
    try { d = await post('/api/lint/scan-book', { slug }); }
    catch (e) { empty(pane, 'Không quét được: ' + e.message); return; }
    // 排序：默认**按章节序号升序**（001→002→003…，跟目录一致）。
    // 想先改最脏的那几章，点上面的「按分数排」切换 —— 切了以后标题上会写明排序方式，
    // 免得看着像乱序（踩过的坑：只按分数排又不说明，用户以为是 bug）。
    const natural = (arr) => arr.slice().sort((a, b) => String(a.path || '').localeCompare(
      String(b.path || ''), 'zh-Hans-CN', { numeric: true }));
    const byScoreArr = (arr) => arr.slice().sort((a, b) => (a.score || 0) - (b.score || 0));
    let scoreOrder = lintByScore;
    const chs = scoreOrder ? byScoreArr(d.chapters || []) : natural(d.chapters || []);
    pane.innerHTML =
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + (d.score || 0) + '</b><span>Điểm toàn sách</span></div>' +
      '<div class="t-stat"><b>' + (d.totalHits || 0) + '</b><span>Chỗ dính lỗi</span></div>' +
      '<div class="t-stat"><b>' + chs.length + '</b><span>chương</span></div></div>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">' + esc(gradeText(d.score || 0)) +
      '. Điểm tính theo «mỗi nghìn chữ dính mấy lần», quét bằng quy tắc tại máy, không tốn đồng nào.<br>' +
      (scoreOrder ? 'Hiện đang **xếp theo điểm từ thấp tới cao** (chương cần sửa nhất ở trước).' : 'Hiện đang **xếp theo thứ tự chương** (001, 002, 003…).') + '</div>' +
      '<div class="t-bar"><button class="t-btn" data-rescan>Quét lại</button>' +
      '<button class="t-btn" data-order>' + (scoreOrder ? 'Xếp theo chương' : 'Xếp theo điểm') + '</button>' +
      '<button class="t-btn" data-llm>Dùng mô hình xem ngữ cảnh</button></div>' +
      '<div data-llmout></div>' +
      (chs.length ? '<div class="t-list">' + chs.map((c, i) =>
        '<div class="t-row" data-i="' + i + '">' + ico('file') +
        '<div class="tr-main"><div class="tr-title">' + esc(c.name || c.path) + '</div>' +
        '<div class="tr-sub">' + esc(scoreLine(c)) + '</div></div>' +
        '<span class="t-pill ' + pillOf(c.score || 0) + '">' + (c.score || 0) + ' điểm</span></div>').join('') + '</div>'
        : '<div class="t-empty">Cuốn này chưa có chương nào</div>');
    pane.querySelectorAll('[data-i]').forEach((r) => {
      r.onclick = () => {
        hap();
        const c = chs[Number(r.dataset.i)];
        push('Soát lỗi · ' + (c.name || c.path), (h2) => lintChapter(h2, slug, c.path));
      };
    });
    pane.querySelector('[data-rescan]').onclick = () => { hap(); repaint(); };
    pane.querySelector('[data-order]').onclick = () => {
      lintByScore = !scoreOrder; hap(); lintBook(pane, slug, repaint);
    };
    pane.querySelector('[data-llm]').onclick = () => llmCheck(pane, slug, '');
  }

  async function lintChapter(host, slug, path) {
    await loadBands();
    loading(host, 'Đang quét chương này…');
    let d;
    try { d = await post('/api/lint/scan', { slug, path }); }
    catch (e) { empty(host, 'Không quét được: ' + e.message); return; }
    const st = d.stats || {};
    const hits = d.hits || [];
    const byCat = {};
    hits.forEach((h) => { (byCat[h.category] = byCat[h.category] || []).push(h); });
    host.innerHTML =
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + (st.score == null ? '—' : st.score) + '</b><span>Điểm</span></div>' +
      '<div class="t-stat"><b>' + (st.total || 0) + '</b><span>Chỗ dính lỗi</span></div>' +
      '<div class="t-stat"><b>' + (st.densityPerK || 0) + '</b><span>Mỗi nghìn chữ</span></div></div>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">' + esc(gradeText(st.score || 0)) +
      ' (chương này ' + (d.chars || 0) + ' chữ)</div>' +
      '<div class="t-bar"><button class="t-btn pri" data-fix>Sửa một chạm (xem trước)</button>' +
      '<button class="t-btn" data-llm>Dùng mô hình xem ngữ cảnh</button></div>' +
      '<div data-fixout></div><div data-llmout></div>' +
      (hits.length ? Object.keys(byCat).map((cat) =>
        '<h2 class="st-h">' + esc(cat) + ' · ' + byCat[cat].length + ' chỗ</h2>' +
        '<div class="t-list">' + byCat[cat].map((h) =>
          '<div class="t-row static">' + ico('edit') +
          '<div class="tr-main"><div class="tr-title">' + esc(h.name || h.rule) + ' ' +
          (h.text ? '<span style="color:var(--danger)">' + esc(h.text) + '</span>' : '') + '</div>' +
          '<div class="tr-sub wrap">' + esc('Dòng ' + h.line + ': ' + (h.context || '')) + '</div>' +
          '<div class="tr-sub wrap">' + esc(h.advice || '') + '</div></div>' +
          (h.fixable ? '<span class="t-pill">Tự sửa được</span>' : '') + '</div>').join('') + '</div>').join('')
        : '<div class="t-empty">Chương này khá sạch, không quét ra vấn đề</div>');
    host.querySelector('[data-fix]').onclick = () => lintFix(host, slug, path);
    host.querySelector('[data-llm]').onclick = () => llmCheck(host, slug, path);
  }

  async function lintFix(host, slug, path) {
    const slot = host.querySelector('[data-fixout]');
    loading(slot, 'Đang thử sửa một bản…');
    let d;
    try { d = await post('/api/lint/fix', { slug, path, apply: false }); }
    catch (e) { slot.innerHTML = '<div class="t-empty">Không sửa được: ' + esc(e.message) + '</div>'; return; }
    if (!d.changed) {
      slot.innerHTML = '<div class="t-hint" style="margin-bottom:var(--sp-3)">Chương này không có gì tự xóa được, ' +
        ' phải sửa tay theo đề xuất ở trên.</div>';
      return;
    }
    slot.innerHTML =
      '<div class="t-form"><div class="t-field"><label>Sửa một chạm sẽ làm gì</label>' +
      '<div class="t-hint" style="margin:0">Xóa ' + d.removed + ' chỗ thừa «xóa đi không ảnh hưởng ý» ' +
      ' (kiểu từ đệm, chuyển ý máy móc). Số chỗ dính lỗi giảm từ ' + d.before.hits + ' xuống ' + d.after.hits +
      ' , điểm ' + d.before.score + ' → ' + d.after.score + '. ' +
      ' Thay đổi sẽ ghi vào «Thay đổi», nguồn ghi là «AI sửa», lúc nào cũng hoàn lại được.</div></div></div>' +
      '<div class="t-bar"><button class="t-btn pri" data-apply>Cứ sửa như vậy</button>' +
      '<button class="t-btn" data-preview>Xem sửa thành thế nào</button></div>' +
      '<div data-prev></div>';
    slot.querySelector('[data-preview]').onclick = () => {
      const box = slot.querySelector('[data-prev]');
      if (box.dataset.on) { box.innerHTML = ''; delete box.dataset.on; return; }
      box.dataset.on = '1';
      box.innerHTML = '<div class="t-pre selectable">' + esc(d.text || '') + '</div>';
    };
    slot.querySelector('[data-apply]').onclick = async () => {
      if (!(await confirmBox('Thật sự sửa chương này như vậy? Sửa xong có thể hoàn lại trong «Thay đổi».'))) return;
      try {
        await post('/api/lint/fix', { slug, path, apply: true });
        toast('Đã sửa xong, vào «Thay đổi» để xem'); hap();
        lintChapter(host, slug, path);
      } catch (e) { toast('Không đổi được: ' + e.message); }
    };
  }

  async function llmCheck(host, slug, path) {
    const slot = host.querySelector('[data-llmout]');
    if (!slot) return;
    loading(slot, 'Đang để mô hình đọc một lượt…');
    try {
      const d = await post('/api/lint/llm', { slug, path });
      slot.innerHTML = '<h2 class="st-h">Vấn đề ngữ cảnh mô hình thấy được</h2>' +
        '<div class="t-pre selectable">' + esc((d.model ? '(' + d.model + ')\n' : '') + d.text) + '</div>';
    } catch (e) {
      slot.innerHTML = '<div class="t-hint">Không xem được: ' + esc(e.message) + '</div>';
    }
  }

  /* ── 质检 · 声音：谁和谁一个腔 ──────────────────────────────
     568 条规则只看"这段文字像不像 AI"，看不出"这句台词像不像**这个人**"。
     这一屏就是那一半：档案、台词指纹、两两像度，全在本地算，断网也能看。 */
  const statCell = (v, l) => '<div class="t-stat"><b>' + esc(v) + '</b><span>' + esc(l) + '</span></div>';

  async function lintVoice(pane, slug) {
    loading(pane, 'Đang nghe một lượt mọi người nói chuyện thế nào…');
    let d;
    try { d = await get('/api/voice/report', { slug }); }
    catch (e) { empty(pane, 'Không đọc được: ' + e.message); return; }
    const st = d.stats || {};
    const people = d.people || [];
    const pairs = d.pairs || [];
    const parts = [];
    parts.push('<div class="t-stats">' + statCell(d.score, 'Điểm giọng nói') +
      statCell((st.characters || 0), 'Nhân vật') +
      statCell((st.withProfile || 0) + '/' + (st.characters || 0), 'Có hồ sơ') +
      statCell((st.dialogueLines || 0), 'Câu thoại') + '</div>');
    parts.push('<div class="t-bar"><span class="t-pill ' + pillOf(d.score) + '">' + esc(d.grade) +
      '</span>' + (st.worstSimilarity ? '<span class="t-pill gray">Cặp giống nhau nhất ' +
      Math.round(st.worstSimilarity * 100) + '%</span>' : '') + '</div>');
    /* 这一段以前写成 `a ? x : '' + y` —— JS 里 `'' + y` 先算，于是"后面的东西全进了 else"，
       实测表现是：有建议时整个名单不渲染（一个「建档案」按钮都点不到）。*/
    if ((d.advice || []).length) {
      parts.push('<div class="t-hint" style="margin:var(--sp-3) 0">' +
        d.advice.map((a) => esc(a)).join('<br>') + '</div>');
    }
    if (pairs.length) {
      parts.push('<h2 class="st-h">Như đúc từ một khuôn</h2><div class="t-list">' + pairs.map((x) =>
        '<div class="t-row warn">' + ico('users') +
        '<div class="tr-main"><div class="tr-title">«' + esc(x.a) + '» và «' + esc(x.b) +
        '» giống nhau ' + Math.round(x.similarity * 100) + '%</div>' +
        '<div class="tr-sub wrap">' + esc(x.why) +
        (x.shared && x.shared.length ? ' · Đều nói: ' + esc(x.shared.join(', ')) : '') +
        '</div></div></div>').join('') + '</div>');
    }
    parts.push('<h2 class="st-h">Mỗi người nói chuyện thế nào</h2>');
    if (people.length) {
      parts.push('<div class="t-list">' + people.map((q, i) => {
        const fp = q.fingerprint || {};
        const sub = fp.lines
          ? (fp.lines + ' câu thoại · trung bình ' + fp.avgLen + ' chữ/câu · câu hỏi ' +
             Math.round((fp.askRatio || 0) * 100) + '%' +
             ((fp.topWords || []).length ? ' · Hay nói: ' + fp.topWords.slice(0, 4).join(', ') : ''))
          : 'Chưa tìm thấy lời thoại của người này trong chính văn (sau lời thoại viết một câu «XX nói» là nhận ra được)';
        return '<div class="t-row" data-who="' + esc(q.name) + '">' + ico('users') +
          '<div class="tr-main"><div class="tr-title">' + esc(q.name) +
          (q.hasProfile ? ' <span class="t-pill ok">Có hồ sơ</span>'
                        : ' <span class="t-pill gray">Chưa có hồ sơ</span>') +
          '</div><div class="tr-sub wrap">' + esc(sub) +
          ((q.issues || []).length ? '<br>' + esc(q.issues[0].text) : '') + '</div></div>' +
          '<button class="t-btn sm" data-open="' + i + '">' +
          (q.hasProfile ? 'Sửa hồ sơ' : 'Lập hồ sơ') + '</button></div>';
      }).join('') + '</div>');
    } else {
      parts.push('<div class="t-empty">Cuốn này chưa có nhân vật. Hãy vào «Thế giới» tạo vài người trước.</div>');
    }
    pane.innerHTML = parts.join('');
    pane.querySelectorAll('[data-open]').forEach((b) => {
      b.onclick = () => {
        hap();
        const q = people[Number(b.dataset.open)];
        push('Cách nói chuyện · ' + q.name, (h) => voiceForm(h, slug, q.name, () => lintVoice(pane, slug)));
      };
    });
  }

  /* 一个人的声音档案：照着后端给的字段定义渲染（只有一份定义，不在这里另写一遍） */
  async function voiceForm(host, slug, name, after) {
    loading(host, 'Đang đọc lời thoại của người này…');
    let d, fields;
    try {
      d = await get('/api/voice/profile', { slug, name });
      fields = (await get('/api/voice/fields')).items || [];
    } catch (e) { empty(host, 'Không đọc được: ' + e.message); return; }
    const v = d.voice || {};
    const asLines = (k) => (v[k] || []).join('\n');
    const asPairs = (k) => Object.entries(v[k] || {}).map(([a, b]) => a + '=' + b).join('\n');
    const field = (f) => {
      const key = f.key, lab = '<label>' + esc(f.label) + '</label>';
      if (f.kind === 'choice') {
        return '<div class="t-field">' + lab + '<div class="t-chips" data-f="' + key + '">' +
          f.options.map((o) => '<button class="t-pill ' + (v[key] === o ? 'ok' : 'gray') +
            '" data-v="' + esc(o) + '">' + esc(o) + '</button>').join('') + '</div>' +
          '<div class="t-hint">' + esc(f.hint) + '</div></div>';
      }
      if (f.kind === 'lines') {
        return '<div class="t-field">' + lab + '<textarea class="t-area" data-f="' + key +
          '" style="min-height:72px" placeholder="Mỗi dòng một mục">' + esc(asLines(key)) + '</textarea>' +
          '<div class="t-hint">' + esc(f.hint) + '</div></div>';
      }
      if (f.kind === 'pairs') {
        return '<div class="t-field">' + lab + '<textarea class="t-area" data-f="' + key +
          '" style="min-height:64px" placeholder="Với ai=gọi thế nào">' + esc(asPairs(key)) + '</textarea>' +
          '<div class="t-hint">' + esc(f.hint) + '</div></div>';
      }
      if (f.kind === 'scale') {
        return '<div class="t-field">' + lab + '<input class="t-input" type="number" min="0" max="10" data-f="' +
          key + '" value="' + esc(v[key] == null ? '' : v[key]) + '">' +
          '<div class="t-hint">' + esc(f.hint) + '</div></div>';
      }
      return '<div class="t-field">' + lab + '<input class="t-input" data-f="' + key +
        '" value="' + esc(v[key] || '') + '"><div class="t-hint">' + esc(f.hint) + '</div></div>';
    };
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">Điền những mục này thì khi viết chính văn, **lời thoại của người này** sẽ theo đó —— ' +
      ' «Mọi nhân vật một giọng» là kiểu giọng AI điển hình nhất, 568 quy tắc không quy tắc nào xử lý được.</div>' +
      '<div class="t-form">' + fields.map(field).join('') + '</div>' +
      ((d.candidates || []).length
        ? '<h2 class="st-h">Câu người này hay nói (bấm để thêm vào câu cửa miệng)</h2><div class="t-chips" data-cands>' +
          d.candidates.map((c) => '<button class="t-pill gray" data-w="' + esc(c.word) + '">' +
            esc(c.word) + ' <b>' + c.count + '</b></button>').join('') + '</div>' : '') +
      ((d.issues || []).length
        ? '<h2 class="st-h">Vấn đề hiện có</h2><div class="t-list">' + d.issues.map((i) =>
            '<div class="t-row' + (i.level === 'warn' ? ' warn' : '') + '">' + ico('dot') +
            '<div class="tr-main"><div class="tr-title">' + esc(i.text) + '</div>' +
            '<div class="tr-sub wrap">' + esc(i.advice || '') + '</div></div></div>').join('') + '</div>' : '') +
      ((d.samples || []).length
        ? '<h2 class="st-h">Lời thoại của người này (kèm nguồn)</h2><div class="t-list">' + d.samples.slice(0, 8).map((x) =>
            '<div class="t-row static">' + ico('text') +
            '<div class="tr-main"><div class="tr-title">«' + esc(x.line) + '»</div>' +
            '<div class="tr-sub">' + esc((x.path || '').split('/').pop() + ' dòng ' + x.lineNo + '') +
            '</div></div></div>').join('') + '</div>' : '') +
      '<div class="t-bar" style="margin-top:var(--sp-4)"><button class="t-btn pri" data-save>Lưu cách nói chuyện của người này</button>' +
      '<button class="t-btn" data-clear>Xóa sạch hồ sơ</button></div>';
    host.querySelectorAll('[data-f].t-chips').forEach((row) => {
      row.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]'); if (!b) return;
        hap();
        row.querySelectorAll('button').forEach((x) => {
          x.classList.toggle('ok', x === b);
          x.classList.toggle('gray', x !== b);
        });
      });
    });
    const candBox = host.querySelector('[data-cands]');
    const catchTa = host.querySelector('[data-f="catchphrases"]');
    if (candBox && catchTa) {
      candBox.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-w]'); if (!b) return;
        hap();
        const w = b.dataset.w;
        const have = catchTa.value.split('\n').map((x) => x.trim()).filter(Boolean);
        if (have.indexOf(w) > -1) { toast('Đã có rồi'); return; }
        have.push(w);
        catchTa.value = have.join('\n');
        toast('Đã thêm: ' + w);
      });
    }
    host.querySelector('[data-save]').onclick = async () => {
      const voice = {};
      host.querySelectorAll('[data-f]').forEach((el) => {
        const key = el.dataset.f;
        if (el.classList.contains('t-chips')) {
          const on = el.querySelector('button.ok');
          if (on) voice[key] = on.dataset.v;
        } else if (el.tagName === 'TEXTAREA') {
          if (el.value.trim()) voice[key] = el.value;
        } else if (el.value !== '' && el.value != null) {
          voice[key] = el.value;
        }
      });
      try {
        await post('/api/voice/profile', { slug, name, voice });
        toast('Đã lưu'); hap();
        if (after) after();
        U().back();
      } catch (e) { toast('Không lưu được: ' + e.message); }
    };
    host.querySelector('[data-clear]').onclick = async () => {
      if (!(await confirmBox('Xóa sạch hồ sơ giọng nói của «' + name + '»? (dữ kiện, quan hệ của người này không bị động tới)'))) return;
      try {
        await del('/api/voice/profile', { slug, name });
        toast('Đã xóa sạch'); hap();
        if (after) after();
        U().back();
      } catch (e) { toast('Không xóa được: ' + e.message); }
    };
  }

  /* ── 质检 · 角色体检：正文里写出来的和别处对不上 ── */
  async function lintBody(pane, slug) {
    loading(pane, 'Đang đối chiếu mọi người trong toàn sách…');
    let d;
    try { d = await get('/api/consistency/report', { slug }); }
    catch (e) { empty(pane, 'Không đọc được: ' + e.message); return; }
    const st = d.stats || {};
    pane.innerHTML =
      '<div class="t-stats">' + statCell(d.score, 'Điểm nhất quán') + statCell(st.people || 0, 'Nhân vật') +
      statCell(st.warn || 0, 'Cần sửa') + statCell(st.info || 0, 'Xem cho biết') + '</div>' +
      '<div class="t-bar"><span class="t-pill ' + pillOf(d.score) + '">' + esc(d.grade) + '</span></div>' +
      '<div class="t-hint" style="margin:var(--sp-3) 0">Tuổi, ngoại hình, xưng hô, đại từ, tên giống viết nhầm, ' +
      ' người lâu không xuất hiện — truyện dài dễ vỡ nhất ở đây, mà tác giả tự mình không nhận ra.</div>' +
      ((d.issues || []).length
        ? '<div class="t-list">' + d.issues.map((i, n) =>
            '<div class="t-row' + (i.level === 'warn' ? ' warn' : '') + '">' + ico('dot') +
            '<div class="tr-main"><div class="tr-title">' + esc(i.text) + '</div>' +
            '<div class="tr-sub wrap">' + esc(i.advice || '') +
            (i.where || []).slice(0, 3).map((w) => '<br>' + esc((w.path || '').split('/').pop()) +
              (w.line ? ' dòng ' + w.line + '' : '') + (w.quote ? ': ' + esc(w.quote) : '')).join('') +
            '</div></div>' +
            (i.suggestAlias ? '<button class="t-btn sm" data-ali="' + n + '">Ghi làm tên khác</button>' : '') +
            '</div>').join('') + '</div>'
        : '<div class="t-empty">Không phát hiện chỗ nào trước sau không khớp.</div>');
    pane.querySelectorAll('[data-ali]').forEach((b) => {
      b.onclick = async () => {
        const i = d.issues[Number(b.dataset.ali)];
        const [who, alias] = i.suggestAlias;
        if (!(await confirmBox('Gộp «' + alias + '» thành tên khác của «' + who + '»? Về sau thống kê xuất hiện sẽ tính chung.'))) return;
        try {
          await post('/api/consistency/alias', { slug, name: who, alias });
          toast('Đã ghi xong'); hap(); lintBody(pane, slug);
        } catch (e) { toast('Không ghi được: ' + e.message); }
      };
    });
  }

  async function lintRules(pane) {
    loading(pane, 'Đang đọc bảng quy tắc…');
    let d;
    try { d = await get('/api/lint/rules'); } catch (e) { empty(pane, 'Không đọc được: ' + e.message); return; }
    const cats = d.categories || [];
    const items = d.items || [];
    pane.innerHTML = '<div class="t-hint" style="margin:0 0 var(--sp-3)">' + esc(d.summary || '') + '</div>' +
      cats.map((c) => {
        const rs = items.filter((r) => r.category === c);
        if (!rs.length) return '';
        return '<h2 class="st-h">' + esc(c) + ' · ' + rs.length + ' mục</h2><div class="t-list">' +
          rs.map((r) => '<div class="t-row static">' + ico('check') +
            '<div class="tr-main"><div class="tr-title">' + esc(r.name) + '</div>' +
            '<div class="tr-sub wrap">' + esc(r.advice || '') + '</div>' +
            '<div class="tr-sub"><span style="font:400 var(--t-sm)/1.5 ui-monospace,Menlo,monospace">' +
            esc(r.pattern || '') + '</span></div></div>' +
            (r.fixable ? '<span class="t-pill">Tự sửa được</span>' : '') + '</div>').join('') + '</div>';
      }).join('');
  }

  /* ══════════════════════════════════════════════════════════
     5. 统计与成就：日历 / 曲线 / 花费 / 日报周报
     ══════════════════════════════════════════════════════════ */
  function openStats(host) { Push.book('Thống kê', statsHome); }

  function statsHome(host, slug) {
    tabShell(host, [['overview', 'Tổng quan'], ['pacing', 'Nhịp truyện'], ['calendar', 'Lịch'], ['ach', 'Thành tựu'],
                    ['cost', 'Chi phí'], ['report', 'Báo cáo']], {
      overview: (pane, repaint) => statsOverview(pane, slug, repaint),
      pacing: (pane) => statsPacing(pane, slug),
      calendar: (pane) => statsCalendar(pane, slug),
      ach: (pane) => statsAchievements(pane, slug),
      cost: (pane) => statsCost(pane, slug),
      report: (pane) => statsReport(pane, slug),
    });
  }

  async function statsOverview(pane, slug, repaint) {
    loading(pane, 'Đang tính…');
    let d;
    try { d = await get('/api/stats/book', { slug, days: 30 }); }
    catch (e) { empty(pane, 'Không đọc được: ' + e.message); return; }
    const perDay = d.perDay || [];
    const chs = d.perChapter || [];
    const maxDay = Math.max(1, ...perDay.map((x) => x.words || 0));
    const maxCh = Math.max(1, ...chs.map((c) => c.words || 0));
    pane.innerHTML =
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + (d.totalWords || 0) + '</b><span>Tổng số chữ</span></div>' +
      '<div class="t-stat"><b>' + (d.chapters || 0) + '</b><span>Chương</span></div>' +
      '<div class="t-stat"><b>' + (d.todayWords || 0) + '</b><span>Hôm nay đã viết</span></div>' +
      '</div>' +
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + (d.streak || 0) + '</b><span>Viết liên tục (ngày)</span></div>' +
      '<div class="t-stat"><b>' + (d.avgPerDay || 0) + '</b><span>Trung bình mỗi ngày</span></div>' +
      '<div class="t-stat"><b>' + (d.daysWritten || 0) + '</b><span>Số ngày đã viết</span></div>' +
      '</div>' +
      (d.target ? '<div class="t-form"><div class="t-field"><label>Mục tiêu ' + d.target +
        ' chữ · đã hoàn thành ' + (d.progress || 0) + '%</label>' +
        '<div class="st-bar"><i style="width:' + Math.min(100, d.progress || 0) + '%"></i></div></div></div>' : '') +
      '<div class="t-bar"><button class="t-btn" data-refresh>Tính lại</button></div>' +
      '<h2 class="st-h">30 ngày gần đây</h2>' +
      (perDay.length
        ? '<div class="st-chart">' + perDay.map((x) =>
            '<i style="height:' + Math.max(3, Math.round((x.words || 0) / maxDay * 100)) + '%" ' +
            'title="' + esc(x.date + ' ' + (x.words || 0) + ' chữ') + '"></i>').join('') + '</div>' +
          '<div class="t-hint" style="margin:0 0 var(--sp-4)">Cột càng cao thì hôm đó viết càng nhiều, ngày nhiều nhất ' + maxDay + ' chữ</div>'
        : '<div class="t-empty">Chưa có ghi chép viết nào</div>') +
      '<h2 class="st-h">Số chữ mỗi chương</h2>' +
      (chs.length ? '<div class="t-list">' + chs.map((c) =>
        '<div class="t-row static">' + ico('file') +
        '<div class="tr-main"><div class="tr-title">' + esc(c.name || c.path) + '</div>' +
        '<div class="st-bar" style="margin-top:var(--sp-2)"><i style="width:' +
        Math.max(2, Math.round((c.words || 0) / maxCh * 100)) + '%"></i></div></div>' +
        '<span class="t-pill gray">' + (c.words || 0) + ' chữ</span></div>').join('') + '</div>'
        : '<div class="t-empty">Chưa có chương nào</div>');
    pane.querySelector('[data-refresh]').onclick = () => { hap(); repaint(); };
  }

  /* ── 统计 · 节奏：连着三章都在吵架，图上看得出来 ── */
  async function statsPacing(pane, slug) {
    loading(pane, 'Đang tính nhịp truyện…');
    let d;
    try { d = await get('/api/pacing/curve', { slug }); }
    catch (e) { empty(pane, 'Không tính được: ' + e.message); return; }
    const pts = d.points || [];
    if (!pts.length) { empty(pane, 'Cuốn này chưa có chương nào.'); return; }
    const sm = d.summary || {};
    const X = (i) => (pts.length <= 1 ? 50 : (i / (pts.length - 1)) * 100);
    const Y = (v) => (40 - Math.max(0, Math.min(1, v)) * 40).toFixed(2);
    const YV = (v) => (40 - ((Math.max(-1, Math.min(1, v)) + 1) / 2) * 40).toFixed(2);
    const path = (f) => pts.map((p, i) => X(i).toFixed(2) + ',' + f(p)).join(' ');
    const last = pts[pts.length - 1];
    pane.innerHTML =
      '<div class="t-stats">' + statCell(sm.chapters || pts.length, 'chương') +
      statCell(Math.round((sm.words || 0) / 1000) + 'k', 'Số chữ') +
      statCell((sm.dialogueAvg * 100).toFixed(0) + '%', 'Tỷ lệ thoại') +
      statCell(sm.arousalMaxAt ? ('Chương ' + sm.arousalMaxAt + '') : '-', 'Chương căng nhất') + '</div>' +
      '<h2 class="st-h">Đường căng thẳng (hồng) và cảm xúc tích cực/tiêu cực (xanh trên, đỏ dưới)</h2>' +
      '<div class="t-pre" style="padding:0"><svg viewBox="0 0 100 40" preserveAspectRatio="none" ' +
      'style="width:100%;height:110px;display:block">' +
      '<line x1="0" y1="20" x2="100" y2="20" style="stroke:var(--line);stroke-width:.4" ' +
      'vector-effect="non-scaling-stroke"></line>' +
      '<polyline fill="none" vector-effect="non-scaling-stroke" style="stroke:var(--accent);stroke-width:1.6" points="' +
      path((p) => Y(p.arousal)) + '"></polyline>' +
      '<polyline fill="none" vector-effect="non-scaling-stroke" style="stroke:var(--ok);stroke-width:1.2;opacity:.85" points="' +
      path((p) => YV(p.valence)) + '"></polyline>' +
      '</svg></div>' +
      '<div class="t-hint" style="margin:var(--sp-2) 0 var(--sp-4)">Trục ngang là thứ tự chương, trục dọc: căng thẳng 0 (thư thả) → 1 (căng); ' +
      ' đường nét đứt ở giữa là «cảm xúc nhạt nhẽo». Đường cong cứ bám sát mép trên = luôn căng, bám sát mép dưới = luôn bị đè nén.</div>' +
      ((d.alerts || []).length
        ? '<h2 class="st-h">Vấn đề trong diễn tiến</h2><div class="t-list">' + d.alerts.map((a) =>
            '<div class="t-row' + (a.level === 'warn' ? ' warn' : '') + '">' + ico('chart') +
            '<div class="tr-main"><div class="tr-title">' + esc(a.text) + '</div>' +
            '<div class="tr-sub wrap">' + esc(a.advice) + '</div></div></div>').join('') + '</div>'
        : '<div class="t-empty">Diễn tiến không có vấn đề gì.</div>') +
      '<h2 class="st-h">Từng chương</h2><div class="t-list">' + pts.map((p) =>
        '<div class="t-row static">' + ico('file') +
        '<div class="tr-main"><div class="tr-title">' + esc((p.title || p.path).split('/').pop()) +
        '</div><div class="tr-sub">' + p.chars + ' chữ · căng thẳng ' + p.arousal.toFixed(2) +
        ' · cảm xúc ' + p.valence.toFixed(2) + ' · thoại ' + Math.round(p.dialogue * 100) +
        '% · độ dài câu trung bình ' + p.avgSent + ' chữ</div></div></div>').join('') + '</div>' +
      '<div class="t-hint" style="margin-top:var(--sp-3)">Chương cuối (' +
      esc((last.title || last.path).split('/').pop()) + ') căng thẳng ' + last.arousal.toFixed(2) + '. </div>';
  }

  async function statsCalendar(pane, slug) {
    loading(pane, 'Đang lật lịch…');
    let d;
    try { d = await get('/api/stats/calendar', { slug, days: 182 }); }
    catch (e) { empty(pane, 'Không đọc được: ' + e.message); return; }
    const days = d.days || [];
    if (!days.length) { empty(pane, 'Chưa có ghi chép viết nào', 'clock'); return; }
    const map = {};
    days.forEach((x) => { map[x.date] = x.words || 0; });
    const today = new Date();
    const start = new Date(days[0].date + 'T00:00:00');
    start.setDate(start.getDate() - start.getDay());          // 从那一周的周日排起
    const cells = [];
    const cur = new Date(start);
    while (cur <= today) { cells.push(fmtDate(cur)); cur.setDate(cur.getDate() + 1); }
    const max = Math.max(1, ...Object.values(map));
    const lvl = (w) => (w <= 0 ? 0 : Math.min(4, Math.ceil(w / max * 4)));
    let html = '';
    for (let i = 0; i < cells.length; i += 7) {
      html += '<div class="st-heat-col">' + cells.slice(i, i + 7).map((k) => {
        const w = map[k] || 0;
        const f = new Date(k + 'T00:00:00') > today;
        return '<i class="lv' + lvl(w) + '"' + (f ? ' style="visibility:hidden"' : '') +
          ' title="' + esc(k + ' ' + w + ' chữ') + '"></i>';
      }).join('') + '</div>';
    }
    const last30 = days.slice(-30).reduce((a, x) => a + (x.words || 0), 0);
    pane.innerHTML =
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + Object.keys(map).length + '</b><span>Số ngày đã viết</span></div>' +
      '<div class="t-stat"><b>' + last30 + '</b><span>Số chữ 30 ngày gần đây</span></div>' +
      '<div class="t-stat"><b>' + max + '</b><span>Nhiều nhất một ngày</span></div></div>' +
      '<div class="st-heat">' + html + '</div>' +
      '<div class="t-hint">Mỗi cột là một tuần (Chủ nhật ở trên), màu càng đậm viết càng nhiều. Gần đây nhất ở bên phải cùng.</div>';
  }

  async function statsAchievements(pane, slug) {
    loading(pane, 'Đang đếm thành tựu…');
    let d;
    try { d = await get('/api/stats/achievements', { slug }); }
    catch (e) { empty(pane, 'Không đọc được: ' + e.message); return; }
    const items = d.items || [];
    pane.innerHTML =
      '<div class="t-form"><div class="t-field"><label>Đã mở khóa ' + (d.done || 0) + ' / ' +
      (d.total || 0) + '(' + (d.percent || 0) + '%)</label>' +
      '<div class="st-bar"><i style="width:' + (d.percent || 0) + '%"></i></div></div></div>' +
      '<div class="t-list">' + items.map((a) => {
        const pct = Math.min(100, Math.round((a.progress || 0) / (a.at || 1) * 100));
        return '<div class="t-row static">' + ico(a.done ? 'check' : 'clock') +
          '<div class="tr-main"><div class="tr-title">' + esc(a.title) + '</div>' +
          '<div class="tr-sub">' + esc(a.hint || '') +
          (a.done ? '' : ' hiện tại ' + (a.progress || 0) + ' / ' + a.at) + '</div>' +
          (a.done ? '' : '<div class="st-bar" style="margin-top:var(--sp-2)"><i style="width:' +
            pct + '%"></i></div>') +
          '</div><span class="t-pill ' + (a.done ? 'ok' : 'gray') + '">' +
          (a.done ? 'Đã đạt' : pct + '%') + '</span></div>';
      }).join('') + '</div>';
  }

  async function statsCost(pane, slug) {
    loading(pane, 'Đang tính tiền…');
    let d;
    try { d = await get('/api/stats/cost', { slug, days: 30 }); }
    catch (e) { empty(pane, 'Không đọc được: ' + e.message); return; }
    const items = d.items || [];
    if (!items.length) { empty(pane, '30 ngày gần đây chưa để AI làm việc gì', 'cpu'); return; }
    const tin = items.reduce((a, x) => a + (x.input || 0), 0);
    const tout = items.reduce((a, x) => a + (x.output || 0), 0);
    const calls = items.reduce((a, x) => a + (x.calls || 0), 0);
    pane.innerHTML =
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + calls + '</b><span>Số lần gọi</span></div>' +
      '<div class="t-stat"><b>' + tin + '</b><span>Đầu vào token</span></div>' +
      '<div class="t-stat"><b>' + tout + '</b><span>Đầu ra token</span></div></div>' +
      '<div class="t-form"><div class="t-field"><label>Quy đổi ' + esc(d.currency || 'tệ') + ': ' +
      money(d.totalCost) + '</label>' +
      '<div class="t-hint" style="margin:0">Tính theo đơn giá điền trong «Công cụ → Mô hình»; mục chưa điền đơn giá thì chỉ thống kê token.</div>' +
      '</div></div>' +
      '<h2 class="st-h">Theo mô hình</h2><div class="t-list">' + items.map((x) =>
        '<div class="t-row static">' + ico('cpu') +
        '<div class="tr-main"><div class="tr-title">' + esc(x.model) + '</div>' +
        '<div class="tr-sub">' + esc(x.calls + ' lần · vào ' + x.input + ' / ra ' + x.output +
          (x.cacheRead ? ' · đọc đệm ' + x.cacheRead : '') +
          (x.ms ? ' · Tổng ' + Math.round(x.ms / 1000) + ' giây' : '')) + '</div></div>' +
        '<span class="t-pill ' + (x.priced ? '' : 'gray') + '">' +
        (x.priced ? money(x.cost) + ' tệ' : 'Chưa điền đơn giá') + '</span></div>').join('') + '</div>';
  }

  async function statsReport(pane, slug) {
    pane.innerHTML =
      '<div class="t-seg wide" data-kind>' +
      '<button class="on" data-v="day">Hôm nay</button>' +
      '<button data-v="week">Tuần này</button><button data-v="month">Tháng này</button></div>' +
      '<div class="t-bar" style="margin-top:var(--sp-3)"><button class="t-btn pri" data-go>Tạo một bản</button></div>' +
      '<div data-out><div class="t-hint">Số liệu đều tính từ ghi chép viết thật, không bịa.</div></div>';
    pane.querySelector('[data-kind]').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]'); if (!b) return;
      hap();
      pane.querySelectorAll('[data-kind] button').forEach((x) => x.classList.toggle('on', x === b));
    });
    pane.querySelector('[data-go]').onclick = async () => {
      const on = pane.querySelector('[data-kind] button.on');
      const kind = on ? on.dataset.v : 'week';
      const out = pane.querySelector('[data-out]');
      loading(out, 'Đang viết báo cáo…');
      try {
        const d = await get('/api/stats/report', { slug, kind });
        out.innerHTML = '<div class="t-pre selectable">' + esc(d.text || '') + '</div>' +
          '<div class="t-bar"><button class="t-btn" data-copy>Sao chép đoạn này</button></div>';
        out.querySelector('[data-copy]').onclick = () => {
          try {
            navigator.clipboard.writeText(d.text || '').then(() => toast('Đã sao chép'), () => toast('Máy này không cho sao chép'));
          } catch (e) { toast('Máy này không cho sao chép'); }
        };
      } catch (e) { out.innerHTML = '<div class="t-empty">Không tạo được: ' + esc(e.message) + '</div>'; }
    };
    pane.querySelector('[data-go]').click();
  }

  /* ══════════════════════════════════════════════════════════
     6. 导出 / 导入
     ══════════════════════════════════════════════════════════ */
  function openExport(host) { Push.book('Xuất / Nhập', exportHome); }

  function exportHome(host, slug) {
    tabShell(host, [['out', 'Xuất'], ['in', 'Nhập']], {
      out: (pane) => exportOut(pane, slug),
      in: (pane) => importIn(pane, slug),
    });
  }

  async function exportOut(pane, slug) {
    loading(pane, 'Đang đọc mục lục…');
    let d;
    try { d = await get('/api/book', { slug }); } catch (e) { empty(pane, 'Không đọc được: ' + e.message); return; }
    const chs = d.chapters || [];
    if (!chs.length) { empty(pane, 'Cuốn này chưa có chương nào', 'file'); return; }
    const picked = new Set(chs.map((c) => c.path));
    const sel = () => chs.filter((c) => picked.has(c.path)).map((c) => c.path).join(',');

    const doExport = (f) => {
      const use = sel();
      if (!use) { toast('Hãy chọn vài chương trước'); return; }
      hap();
      const q = qs({ slug, chapters: use });
      if (f === 'txt') return download('api/export/text?' + q);
      if (f === 'md') return download('api/export/markdown?' + q);
      if (f === 'epub') return download('api/export/epub?' + q);
      if (f === 'pdf') return download('api/export/pdf?' + q);
      if (f === 'print') { window.open('api/export/print?' + q, '_blank'); return; }
      if (f === 'bundle') { download('api/export/bundle?' + qs({ slug })); return; }
    };

    const paint = () => {
      const n = picked.size;
      pane.innerHTML =
        '<div class="t-hint" style="margin:0 0 var(--sp-3)">Xuất những chương nào: bấm để bật/tắt. Xuất chỉ đọc chính văn, không thay đổi gì. ' +
        ' Đã chọn ' + n + ' / ' + chs.length + ' chương.</div>' +
        '<div class="t-list" style="max-height:270px;overflow-y:auto">' + chs.map((c, i) =>
          '<div class="t-row" data-i="' + i + '">' + ico('file') +
          '<div class="tr-main"><div class="tr-title">' + esc(c.name || c.path) + '</div>' +
          '<div class="tr-sub">' + esc((c.words || 0) + ' chữ') + '</div></div>' +
          '<span class="t-pill ' + (picked.has(c.path) ? 'ok' : 'gray') + '">' +
          (picked.has(c.path) ? 'Đã chọn' : 'Không chọn') + '</span></div>').join('') + '</div>' +
        '<div class="t-bar"><button class="t-btn sm" data-all>Chọn tất cả</button>' +
        '<button class="t-btn sm" data-none>Bỏ chọn tất cả</button></div>' +
        '<div class="t-form"><div class="t-field"><label>Mang đi dạng gì</label>' +
        '<div class="t-hint" style="margin:0">TXT phổ biến nhất; Markdown mỗi chương một tệp, nén thành gói; ' +
        'EPUB / PDF cho trình đọc và in ấn; «Trọn gói» đóng gói kèm thiết lập, phục bút, dòng thời gian.</div></div></div>' +
        '<div class="t-bar"><button class="t-btn pri" data-f="txt">TXT</button>' +
        '<button class="t-btn" data-f="md">Markdown</button>' +
        '<button class="t-btn" data-f="epub">EPUB</button></div>' +
        '<div class="t-bar"><button class="t-btn" data-f="pdf">PDF</button>' +
        '<button class="t-btn" data-f="print">Chế độ in</button>' +
        '<button class="t-btn" data-f="bundle">Mang trọn gói</button></div>';
      pane.querySelectorAll('[data-i]').forEach((r) => {
        r.onclick = () => {
          const p = chs[Number(r.dataset.i)].path;
          if (picked.has(p)) picked.delete(p); else picked.add(p);
          hap(); paint();
        };
      });
      pane.querySelector('[data-all]').onclick = () => { chs.forEach((c) => picked.add(c.path)); hap(); paint(); };
      pane.querySelector('[data-none]').onclick = () => { picked.clear(); hap(); paint(); };
      pane.querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => doExport(b.dataset.f); });
    };
    paint();
  }

  function importIn(pane, slug) {
    pane.innerHTML =
      '<div class="t-form">' +
      '<div class="t-field"><label>Nhập từ tệp</label>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-2)">Hỗ trợ .md / .txt, cũng có thể nén nhiều tệp md thành một zip rồi tải lên cùng lúc. ' +
      ' Mỗi chương một tệp là tiện nhất, tên tệp chính là tên chương.</div>' +
      '<input type="file" data-md multiple accept=".md,.txt,.zip" class="t-input" style="padding:var(--sp-2)"></div>' +
      '<div class="t-field"><label>Nhập thẻ nhân vật</label>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-2)">SillyTavern xuất ra thẻ nhân vật (PNG hoặc JSON), ' +
      ' nhập vào sẽ thành một nhân vật trong động cơ thế giới.</div>' +
      '<input type="file" data-card accept=".png,.json,image/png,application/json" class="t-input" style="padding:var(--sp-2)"></div>' +
      '<div class="t-field"><label>Khôi phục trọn gói</label>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-2)">Đưa tệp zip xuất từ «Mang trọn gói» trở lại: chính văn, thiết lập, ' +
      ' phục bút, dòng thời gian cùng trở về. **Sẽ tạo một cuốn sách mới**, tuyệt đối không ghi đè cuốn hiện tại.</div>' +
      '<input type="file" data-bundle accept=".zip,application/zip" class="t-input" style="padding:var(--sp-2)"></div>' +
      '</div>' +
      '<div class="t-bar"><button class="t-btn pri" data-paste>Dán một đoạn chính văn vào</button></div>' +
      '<div data-out></div>';

    const out = pane.querySelector('[data-out]');
    pane.querySelector('[data-md]').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      loading(out, 'Đang nhập, ' + files.length + ' tệp…');
      const fd = new FormData();
      fd.append('slug', slug);
      fd.append('prefix', 'manuscript');
      files.forEach((f) => fd.append('files', f, f.name));
      try {
        const d = await upload('api/import/markdown', fd);
        out.innerHTML = '<div class="t-form"><div class="t-field"><label>Đã nhập ' +
          (d.imported || d.count || 0) + ' chương</label><div class="t-hint" style="margin:0">' +
          esc(d.note || 'Vào «Tệp» hoặc bàn viết sẽ thấy.') + '</div></div></div>';
        toast('Đã nhập'); hap();
      } catch (err) { out.innerHTML = '<div class="t-empty">Nhập thất bại: ' + esc(err.message) + '</div>'; }
      e.target.value = '';
    });

    pane.querySelector('[data-card]').addEventListener('change', async (e) => {
      const f = (e.target.files || [])[0];
      if (!f) return;
      loading(out, 'Đang đọc thẻ nhân vật…');
      const fd = new FormData();
      fd.append('slug', slug);
      fd.append('file', f, f.name);
      try {
        const d = await upload('api/import/character-card', fd);
        out.innerHTML = '<div class="t-form"><div class="t-field"><label>Đã thu: ' +
          esc(d.name || '(Chưa đặt tên)') + '</label><div class="t-hint" style="margin:0">' +
          ' Vào «Công cụ → Thế giới» sẽ thấy hồ sơ của nó.</div></div></div>';
        toast('Đã thu thẻ nhân vật'); hap();
      } catch (err) { out.innerHTML = '<div class="t-empty">Không đọc được: ' + esc(err.message) + '</div>'; }
      e.target.value = '';
    });

    pane.querySelector('[data-bundle]').addEventListener('change', async (e) => {
      const f = (e.target.files || [])[0];
      if (!f) return;
      loading(out, 'Đang khôi phục trọn gói…');
      const fd = new FormData();
      fd.append('file', f, f.name);
      try {
        const d = await upload('api/import/bundle', fd);
        const tables = Object.keys(d.restored || {});
        out.innerHTML = '<div class="t-form"><div class="t-field"><label>Đã khôi phục thành «' +
          esc(d.title || '') + '»</label><div class="t-hint" style="margin:0">' +
          ' Chính văn ' + (d.chapters || 0) + ' chương, tệp ' + (d.files || 0) + ' ' +
          (tables.length ? (', ngoài ra đã bổ sung lại: ' + esc(tables.join(', '))) : '') +
          '. Lên giá sách xem cuốn mới này, cuốn cũ không bị động chữ nào.</div></div></div>';
        toast('Đã khôi phục trọn gói'); hap();
      } catch (err) { out.innerHTML = '<div class="t-empty">Khôi phục thất bại: ' + esc(err.message) + '</div>'; }
      e.target.value = '';
    });

    pane.querySelector('[data-paste]').onclick = async () => {
      let name = await ask('Chương này tên là gì', '', { placeholder: 'VD: Chương 7 - Nợ cũ' });
      if (!name) return;
      name = (window.VI && VI.chapterName ? VI.chapterName : function (x) { return x; })(name);
      const text = await ask('Dán chính văn vào', '', { placeholder: 'Dán chính văn…', multiline: true, ok: 'Nhập' });
      if (text == null) return;
      if (!text.trim()) { toast('Bên trong trống trơn'); return; }
      try {
        const d = await post('/api/import/text', { slug, name, text });
        toast('Đã thu, ' + (d.words || 0) + ' chữ'); hap();
        out.innerHTML = '<div class="t-hint">Đã đặt vào ' + esc(d.path || name) + '. </div>';
      } catch (err) { toast('Không nhập được: ' + err.message); }
    };
  }

  /* ══════════════════════════════════════════════════════════
     7. 听书升级：音色 / 引擎 / 语速 / 从哪一章开始听
     （真正播放还是阅读器那一套，这里只负责挑和试，不另开一个播放器）
     ══════════════════════════════════════════════════════════ */
  function openListen(host) { Push.book('Nghe truyện', listenHome); }

  /* 试听用的那一个 <audio>：现在收在 VoiceTry 里（全 App 只有这一个，
     切音色/离开面板都会把它停掉）。这里只留一个转调，别在写作台里再养第二只。
     抽出 VoiceTry 的原因：设置页的音色也要能试听，照抄一份就是"两套实现"。 */
  function stopTry() { if (window.VoiceTry) VoiceTry.stop(); }

  /* 语速：**界面上给出倍数**（0.8x/1.0x/1.2x/1.5x），值还是后端认的 `-20%/+0%/+25%/+50%`。
     原来只写「慢 / 正常 / 快 / 更快」，用户不知道"更快"到底快多少。 */
  const RATES = [['-20%', '0.8x', 'Chậm một chút'], ['+0%', '1.0x', 'Bình thường'],
                 ['+25%', '1.2x', 'Nhanh một chút'], ['+50%', '1.5x', 'Nhanh hơn nhiều']];

  async function listenHome(host, slug) {
    loading(host, 'Đang xem giọng đọc…');
    let d, cache = null;
    try { d = await get('/api/tts/voices'); } catch (e) { empty(host, 'Không đọc được: ' + e.message); return; }
    try { cache = await get('/api/tts/cache'); } catch (e) {}
    const voices = d.voices || [];
    const engines = d.engines || [];
    const curVoice = Prefs.get('voice');
    const curEng = Prefs.get('ttsEngine') || d.engine || 'edge';
    const curRate = Prefs.get('rate');
    const follow = Prefs.get('ttsFollow') !== false;
    /* 同一个东西只有一种叫法：引擎名一律取后端 label 里括号前的那一段（edge-tts / CosyVoice），
       音色行下面的小字也用这个名字，不再出现「edge 引擎」这种另一个写法。 */
    const engName = {};
    engines.forEach((e) => { engName[e.key] = String(e.label || e.key).split('(')[0].trim(); });
    const engOf = (k) => engName[k] || k || 'edge-tts';
    const badEngs = engines.filter((e) => !e.available);

    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">Chọn giọng đọc, bộ máy và tốc độ, bấm «Bắt đầu nghe» bên dưới là vào trình đọc để đọc to. ' +
      ' Tổng hợp theo từng câu, đoạn đầu một hai giây là có tiếng, không phải chờ cả chương. Bấm cái loa bên trái giọng đọc để nghe thử.</div>' +
      '<div class="t-form">' +
      '<div class="t-field"><label>Bộ máy</label><div class="t-seg wide" data-engine>' +
      (engines.length ? engines.map((e) => {
        const nm = String(e.label || e.key).split('(')[0].trim();
        return '<button data-v="' + esc(e.key) + '" class="' + (e.key === curEng ? 'on' : '') + '"' +
          (e.available ? '' : ' disabled data-na="1" aria-disabled="true"') + '>' + esc(nm) + '</button>';
      }).join('') : '<button data-v="' + esc(curEng) + '" class="on">' + esc(engOf(curEng)) + '</button>') +
      '</div>' + (badEngs.length ? '<div class="t-hint">' + badEngs.map((e) =>
        esc(engName[e.key] || e.key) + '  hiện không dùng được: ' + esc(e.reason || 'chưa cấu hình') +
        ' (chỉ dùng khi chọn nó, bình thường không ảnh hưởng nghe truyện)').join('; ') + '</div>' : '') +
      '</div>' +
      '<div class="t-field"><label>Tốc độ đọc</label><div class="t-seg wide" data-rate>' +
      RATES.map(([v, x, w]) =>
        '<button data-v="' + v + '" class="' + (v === curRate ? 'on' : '') + '" title="' + esc(w) + '">' +
        x + '</button>').join('') +
      '</div><div class="t-hint">' + RATES.map(([, x, w]) => x + ' ' + w).join(' ／ ') + '</div></div>' +
      '<div class="t-field"><label>Trang chạy theo giọng đọc</label><div class="t-seg wide" data-follow>' +
      '<button data-v="1" class="' + (follow ? 'on' : '') + '">Bật</button>' +
      '<button data-v="0" class="' + (follow ? '' : 'on') + '">Tắt</button>' +
      '</div><div class="t-hint">Bật: đọc tới đâu lật tới đó. Tắt: màn hình đứng yên, chỉ phát tiếng.</div></div>' +
      '</div>' +
      '<h2 class="st-h">Giọng đọc · ' + voices.length + ' </h2>' +
      '<div class="t-list">' + (voices.length ? voices.map((v, i) =>
        '<div class="t-row' + (v.id === curVoice ? ' on' : '') + '" data-vi="' + i + '">' +
        '<button class="tr-act" data-try="' + i + '" aria-label="Nghe thử">' + window.iconHtml('sound') + '</button>' +
        '<div class="tr-main"><div class="tr-title">' + esc(v.name || v.id) + '</div>' +
        '<div class="tr-sub">' + esc([engOf(v.engine), v.id].filter(Boolean).join(' · ')) +
        '</div></div>' +
        '<span class="t-pill ' + (v.id === curVoice ? 'ok' : 'gray') + '">' +
        (v.id === curVoice ? 'Đang dùng ảnh' : 'Dùng cái này') + '</span></div>').join('')
        : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">Máy chủ chưa cấu hình giọng đọc</div></div></div>') +
      '</div>' +
      (cache ? '<div class="t-hint">Đã lưu đệm ' + (cache.files || 0) + ' đoạn âm thanh, chiếm ' +
        esc(U().bytes(cache.bytes)) + '. Đoạn đã nghe lần sau không phải tổng hợp lại.</div>' : '') +
      /* 主操作吸底：以前它在滚动内容的最后一行，被底部导航挡掉，用户根本看不见「开始听」。 */
      '<div class="t-foot">' +
      '<button class="t-btn pri" data-start>Bắt đầu nghe (từ đầu cuốn sách)</button>' +
      '<button class="t-btn" data-pick>Chọn một chương</button>' +
      '</div>';
    host.classList.add('has-foot');

    const seg = (sel, apply) => {
      host.querySelector(sel).addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]'); if (!b) return;
        if (b.disabled || b.dataset.na) { toast('Bộ máy này hiện không dùng được'); return; }
        host.querySelectorAll(sel + ' button').forEach((x) => x.classList.toggle('on', x === b));
        apply(b.dataset.v); hap();
      });
    };
    seg('[data-engine]', (v) => { stopTry(); Prefs.set('ttsEngine', v); });
    seg('[data-rate]', (v) => { stopTry(); Prefs.set('rate', v); });
    seg('[data-follow]', (v) => Prefs.set('ttsFollow', v === '1'));

    /* 点喇叭 = 试听这一把声音；点整行 = 用它。
       两个动作分开，试听不会顺手把当前音色换掉（那正是"点错了"的来源）。 */
    const tryBtn = (r, i) => {
      const v = voices[i];
      const b = r.querySelector('[data-try]');
      VoiceTry.play({
        voice: v.id,
        engine: Prefs.get('ttsEngine') || curEng,
        rate: Prefs.get('rate') || '+0%',
        el: b,
        busyHTML: '<i class="tr-spin"></i>',
        idleHTML: window.iconHtml('sound'),
        onDone: (msg) => { if (msg) toast(msg); },
      });
      hap();
    };
    host.querySelectorAll('[data-vi]').forEach((r) => {
      const i = Number(r.dataset.vi);
      r.querySelector('[data-try]').onclick = (e) => { e.stopPropagation(); tryBtn(r, i); };
      r.onclick = () => {
        const v = voices[i];
        stopTry();
        Prefs.set('voice', v.id);
        hap();
        host.querySelectorAll('[data-vi]').forEach((x) => {
          const on = x === r;
          x.classList.toggle('on', on);
          const pill = x.querySelector('.t-pill');
          pill.className = 't-pill ' + (on ? 'ok' : 'gray');
          pill.textContent = on ? 'Đang dùng ảnh' : 'Dùng cái này';
        });
        toast('Đã đổi sang ' + (v.name || v.id));
      };
    });
    host.querySelector('[data-start]').onclick = () => { hap(); startListen(slug, ''); };
    host.querySelector('[data-pick]').onclick = () => {
      hap();
      push('Chọn một chương để bắt đầu nghe', (h2) => chapterPicker(h2, slug, (ch) => {
        startListen(slug, ch.path);
      }, { hint: 'Bắt đầu đọc từ chương nào' }));
    };
  }

  /* 进阅读器开始朗读 —— 播放只有 reader.js 那一套，这里不重写 */
  async function startListen(slug, path) {
    if (!(window.Shelf && Shelf.openBook)) { toast('Trình đọc chưa sẵn sàng'); return; }
    try {
      await Shelf.openBook(slug, path ? { slug, path } : { slug });
    } catch (e) { toast('Không mở được: ' + e.message); return; }
    setTimeout(() => {
      try { if (window.Reader && Reader.toggleTts) Reader.toggleTts(); }
      catch (e) { toast('Không bắt đầu đọc to được: ' + e.message); }
    }, 460);
  }

  /* ══════════════════════════════════════════════════════════
     8. 术语与一致：术语表 / 一致性扫描 / 全书替换
     ══════════════════════════════════════════════════════════ */
  function openTerm(host) { Push.book('Thuật ngữ', termHome); }

  async function termHome(host, slug) {
    let items = [];
    host.innerHTML =
      '<div class="t-bar"><button class="t-btn pri" data-add>Thêm một thuật ngữ</button>' +
      '<button class="t-btn" data-check>Kiểm tra nhất quán</button></div>' +
      '<div class="t-bar"><button class="t-btn" data-replace>Thay thế toàn sách…</button></div>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">Bảng thuật ngữ quản lý danh từ riêng như tên người, địa danh, môn phái. ' +
      ' «Kiểm tra nhất quán» sẽ tìm ra cách gọi khác của cùng một thứ và các chữ nghi viết sai.</div>' +
      '<input class="t-input" data-q placeholder="Tìm thuật ngữ / tên khác" style="margin-bottom:var(--sp-3)">' +
      '<div data-list></div><div data-results></div>';

    const q = host.querySelector('[data-q]');
    const listBox = host.querySelector('[data-list]');
    const out = host.querySelector('[data-results]');

    const paint = () => {
      const n = q.value.trim().toLowerCase();
      const list = n ? items.filter((t) => t.name.toLowerCase().indexOf(n) >= 0
        || (t.aliases || []).some((a) => a.toLowerCase().indexOf(n) >= 0)) : items;
      listBox.innerHTML = list.length
        ? '<div class="t-list">' + list.map((t, i) =>
          '<div class="t-row" data-i="' + i + '">' + ico('text') +
          '<div class="tr-main"><div class="tr-title">' + esc(t.name) + '</div>' +
          '<div class="tr-sub">' + esc([(t.aliases || []).join(', '), t.kind || '',
            t.note || ''].filter(Boolean).join(' · ') || '(không có tên khác)') + '</div></div>' +
          '<button class="t-btn sm dim" data-rm="' + t.id + '">Xóa</button></div>').join('') + '</div>'
        : '<div class="t-empty">' + (items.length ? 'Không tìm thấy' : 'Chưa có thuật ngữ, hãy thêm một mục') + '</div>';
      listBox.querySelectorAll('[data-i]').forEach((r) => {
        r.onclick = (e) => { if (e.target.closest('[data-rm]')) return; termEdit(list[Number(r.dataset.i)]); };
      });
      listBox.querySelectorAll('[data-rm]').forEach((b) => {
        b.onclick = async (e) => {
          e.stopPropagation();
          const t = items.find((x) => String(x.id) === String(b.dataset.rm));
          if (!(await confirmBox('Xóa «' + ((t && t.name) || 'mục này') + '»? '))) return;
          try { await del('/api/term', { slug, id: b.dataset.rm }); toast('Đã xóa'); hap(); await reload(); }
          catch (err) { toast('Không xóa được: ' + err.message); }
        };
      });
    };

    const reload = async () => {
      const d = await get('/api/term', { slug });
      items = d.items || [];
      paint();
    };

    const termEdit = async (t) => {
      const name = await ask('Thuật ngữ (cách viết đúng)', t ? t.name : '', { placeholder: 'VD: nhân vật chính' });
      if (!name) return;
      const alias = await ask('Tên khác (cách nhau bằng dấu phẩy, có thể trống)',
        t ? (t.aliases || []).join(', ') : '', { placeholder: 'VD: Tiểu Nặc, Nặc ca' });
      if (alias == null) return;
      const kind = await ask('Nó là gì (có thể trống)', t ? (t.kind || '') : '', { placeholder: 'Người / Nơi / Môn phái / Vật phẩm…' });
      const aliases = alias.split(/[、,，;；\/]+/).map((x) => x.trim()).filter(Boolean);
      try {
        await post('/api/term', { slug, id: t ? t.id : undefined, name, aliases, kind: kind || '' });
        toast('Đã lưu'); hap(); out.innerHTML = ''; await reload();
      } catch (e) { toast('Không lưu được: ' + e.message); }
    };

    q.addEventListener('input', paint);
    host.querySelector('[data-add]').onclick = () => termEdit(null);
    host.querySelector('[data-check]').onclick = () => termCheck(out, slug);
    host.querySelector('[data-replace]').onclick = async () => {
      const find = await ask('Thay thế cái gì', '', { placeholder: 'Cách viết cần bỏ' });
      if (!find) return;
      const to = await ask('Đổi thành gì', '', { placeholder: 'Cách viết đúng' });
      if (to == null) return;
      replaceFlow(out, slug, find, to);
    };

    try { await reload(); }
    catch (e) { empty(host, 'Không đọc được bảng thuật ngữ: ' + e.message); }
  }

  async function termCheck(out, slug) {
    loading(out, 'Đang đối chiếu toàn bản thảo…');
    let d;
    try { d = await post('/api/term/check', { slug }); }
    catch (e) { out.innerHTML = '<div class="t-empty">Không kiểm tra được: ' + esc(e.message) + '</div>'; return; }
    const items = d.items || [];
    if (!items.length) { out.innerHTML = '<div class="t-hint">Toàn bản thảo nhất quán, không phát hiện vấn đề.</div>'; return; }
    out.innerHTML = '<h2 class="st-h">Phát hiện ' + items.length + ' chỗ</h2><div class="t-list">' +
      items.map((it, i) => '<div class="t-row static">' + ico('link') +
        '<div class="tr-main"><div class="tr-title">' + esc(it.name || '') + ' ' +
        '<span style="color:var(--danger)">' + esc(it.variant || '') + '</span></div>' +
        '<div class="tr-sub wrap">' + esc(it.hint || '') + '</div></div>' +
        '<button class="t-btn sm" data-i="' + i + '">Sửa lại</button></div>').join('') + '</div>';
    out.querySelectorAll('[data-i]').forEach((b) => {
      b.onclick = () => {
        const it = items[Number(b.dataset.i)];
        if (!it.variant) return;
        replaceFlow(out, slug, it.variant, it.term, 'Chỉ xem chương này: ' + (it.name || ''));
      };
    });
  }

  async function replaceFlow(slot, slug, find, to, extra) {
    loading(slot, 'Đang xem trước sẽ sửa ở đâu…');
    let d;
    try { d = await post('/api/replace', { slug, find, replace: to }); }
    catch (e) { slot.innerHTML = '<div class="t-empty">Không kiểm tra được: ' + esc(e.message) + '</div>'; return; }
    if (!d.total) {
      slot.innerHTML = '<div class="t-hint">Toàn bản thảo không có «' + esc(find) + '». </div>';
      return;
    }
    slot.innerHTML = '<h2 class="st-h">Sẽ sửa ' + d.total + ' chỗ, nằm trong ' + d.files.length + ' chương</h2>' +
      (extra ? '<div class="t-hint" style="margin:0 0 var(--sp-2)">' + esc(extra) + '</div>' : '') +
      '<div class="t-list">' + d.files.slice(0, 20).map((f) =>
        '<div class="t-row static">' + ico('file') +
        '<div class="tr-main"><div class="tr-title">' + esc(f.name) + ' · ' + f.count + ' chỗ</div>' +
        '<div class="tr-sub wrap">' + esc(f.preview || '') + '</div></div></div>').join('') + '</div>' +
      (d.files.length > 20 ? '<div class="t-hint">Còn ' + (d.files.length - 20) + ' chương chưa liệt kê.</div>' : '') +
      '<div class="t-bar"><button class="t-btn pri" data-yes>Xác nhận thay thế</button>' +
      '<button class="t-btn" data-no>Thôi</button></div>';
    slot.querySelector('[data-yes]').onclick = async () => {
      try {
        const r = await post('/api/replace', { slug, find, replace: to, apply: true });
        toast('Đã thay ' + r.replaced + ' chỗ'); hap();
        slot.innerHTML = '<div class="t-hint">Đã sửa xong, sửa trực tiếp vào tệp chính văn gốc (có thể xem ghi chép trong «Thay đổi»).</div>';
      } catch (e) { toast('Không đổi được: ' + e.message); }
    };
    slot.querySelector('[data-no]').onclick = () => { slot.innerHTML = ''; };
  }

  /* ══════════════════════════════════════════════════════════
     9. 素材库：灵感碎片、资料、图片链接
     ══════════════════════════════════════════════════════════ */
  const MATERIAL_KINDS = [['note', 'Ghi chép'], ['idea', 'Ý tưởng'], ['doc', 'Tư liệu'],
                          ['image', 'Hình ảnh'], ['link', 'Liên kết']];
  const KIND_OF = {}; MATERIAL_KINDS.forEach(([k, l]) => { KIND_OF[k] = l; });

  function openMaterial(host) { Push.book('Tư liệu', materialHome); }

  /* 素材列表：**只拿摘要**（?preview=1），正文点进去再看。
     踩过的坑：以前列表接口把每条素材的正文整段吐出来、列表也整段铺进 DOM ——
     真实那本书 11 条素材 = 16.8 万字全在列表里，跑 e2e 时量出来"一个面板 16.7 万字"，
     手机上滚动发涩、想找一条素材得往下划半天。现在列表 1.7 千字、正文点开才取。 */
  async function materialHome(host, slug) {
    let items = [], kind = '';
    /* 多选：sel=null 表示平时状态；是 Set 时进入"多选"，点一行是勾选而不是打开。
       素材一多（真实那本书 11 条，还会长），一条条点进去删太费劲。 */
    let sel = null;
    const visible = () => (kind ? items.filter((x) => x.kind === kind) : items);
    const rowHtml = (m, i) => {
      const tags = (m.tags || []).slice(0, 5);
      const more = Math.max(0, (m.tags || []).length - tags.length);
      const on = sel && sel.has(m.id);
      return '<div class="t-row m-row' + (on ? ' on' : '') + '" data-open="' + i + '">' +
        (sel
          ? '<span class="m-check' + (on ? ' on' : '') + '">' +
            (on ? window.iconHtml('check') : '') + '</span>'
          : ico('bookmark')) +
        '<div class="tr-main">' +
          '<div class="tr-title">' + esc(m.title) + '</div>' +
          /* 这一行固定是「分类 · 多久以前 · 多少字」，永远完整。
             以前它跟标签挤在同一行里被截掉，于是有的条目有"13 小时前 · 20765 字"、
             有的没有 —— 其实都有，只是被截了。 */
          '<div class="m-meta">' + esc([KIND_OF[m.kind] || m.kind, ago(m.updated_at),
            (m.bodyLen ? Number(m.bodyLen).toLocaleString('en-US') + ' chữ' : '')]
            .filter(Boolean).join(' · ')) + '</div>' +
          (tags.length ? '<div class="m-tags">' + tags.map((t) =>
            '<i>' + esc(t) + '</i>').join('') +
            (more ? '<i class="more">+' + more + '</i>' : '') + '</div>' : '') +
          ((m.body || '').trim() ? '<div class="m-prev">' + esc(m.body) +
            (m.truncated ? '…' : '') + '</div>' : '') +
        '</div>' +
        (sel ? '' : '<span class="tr-go">' + window.iconHtml('chevron') + '</span>') +
        '</div>';
    };
    const paint = () => {
      const list = visible();
      const picked = sel ? sel.size : 0;
      host.innerHTML =
        (sel
          ? '<div class="t-bar"><button class="t-btn" data-all>' +
            (picked >= list.length && list.length ? 'Bỏ chọn tất cả' : 'Chọn tất cả') + '</button>' +
            '<button class="t-btn dan" data-del-sel' + (picked ? '' : ' disabled') + '>Xóa mục đã chọn ' +
            (picked ? '(' + picked + ')' : '') + '</button>' +
            '<button class="t-btn pri" data-done>Xong</button></div>'
          : '<div class="t-bar"><button class="t-btn" data-sel>Chọn nhiều</button>' +
            '<button class="t-btn pri" data-add>Thêm một tư liệu</button></div>') +
        '<div class="t-seg wide" data-kind>' +
        [['', 'Tất cả']].concat(MATERIAL_KINDS).map(([k, l]) =>
          '<button data-v="' + k + '" class="' + (k === kind ? 'on' : '') + '">' + l + '</button>').join('') +
        '</div>' +
        '<div class="t-hint" style="margin:var(--sp-3) 0 var(--sp-3)">' +
        (sel ? 'Bấm mục để tích chọn, tích xong bấm «Xóa mục đã chọn».'
             : 'Ý tưởng, tư liệu tra được, link ảnh đều có thể ném vào đây trước, lúc viết quay lại lật. Bấm một mục để xem toàn văn.') + '</div>' +
        (list.length ? '<div class="t-list">' + list.map(rowHtml).join('') + '</div>'
          : '<div class="t-empty">' + (items.length ? 'Loại này chưa có gì' : 'Kho tư liệu trống') + '</div>');

      const addBtn = host.querySelector('[data-add]');
      if (addBtn) addBtn.onclick = async () => {
        const title = await ask('Tư liệu này tên là gì', '', { placeholder: 'Tiêu đề một câu' });
        if (!title) return;
        const kindPick = await ask('Nó thuộc loại nào (' + MATERIAL_KINDS.map(([k, l]) => k + '=' + l).join(', ') + ')',
          'note', { placeholder: 'note' });
        if (kindPick == null) return;
        const body = await ask('Nội dung (có thể trống)', '', { placeholder: 'Nguyên văn, liên kết, ghi chú…', multiline: true });
        const tags = await ask('Nhãn (cách nhau bằng dấu phẩy, có thể trống)', '', { placeholder: 'pháp khí,phục bút' });
        try {
          await post('/api/material', { slug, title, kind: (kindPick || 'note').trim(),
            body: body || '', tags: (tags || '').split(/[,，;；]+/).map((x) => x.trim()).filter(Boolean) });
          toast('Đã thu xong'); hap(); await reload();
        } catch (e) { toast('Không lưu được: ' + e.message); }
      };
      const selBtn = host.querySelector('[data-sel]');
      if (selBtn) selBtn.onclick = () => { sel = new Set(); hap(); paint(); };
      const doneBtn = host.querySelector('[data-done]');
      if (doneBtn) doneBtn.onclick = () => { sel = null; hap(); paint(); };
      const allBtn = host.querySelector('[data-all]');
      if (allBtn) allBtn.onclick = () => {
        if (sel.size >= list.length && list.length) sel.clear();
        else list.forEach((m) => sel.add(m.id));
        hap(); paint();
      };
      const delSel = host.querySelector('[data-del-sel]');
      if (delSel) delSel.onclick = async () => {
        if (!sel.size) return;
        if (!(await confirmBox('Xóa ' + sel.size + ' tư liệu đã chọn? Xóa rồi không lấy lại được.', true))) return;
        try {
          const r = await del('/api/material', { slug, ids: Array.from(sel).join(',') });
          toast('Đã xóa ' + ((r && r.count) || sel.size) + ' mục'); hap();
          sel = null;
          await reload();
        } catch (e) { toast('Không xóa được: ' + e.message); }
      };
      host.querySelector('[data-kind]').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]'); if (!b) return;
        kind = b.dataset.v; hap(); paint();
      });
      host.querySelectorAll('[data-open]').forEach((row) => {
        row.onclick = () => {
          const m = list[Number(row.dataset.open)];
          hap();
          if (sel) {
            if (sel.has(m.id)) sel.delete(m.id); else sel.add(m.id);
            paint();
            return;
          }
          push('Tư liệu · ' + m.title, (h) => materialOne(h, slug, m.id));
        };
      });
    };
    const reload = async () => {
      const d = await get('/api/material', { slug, preview: 1 });
      items = d.items || [];
      if (sel) {                    // 删完/刷新后，勾选里只留还存在的
        const alive = new Set(items.map((m) => m.id));
        Array.from(sel).forEach((id) => { if (!alive.has(id)) sel.delete(id); });
      }
      paint();
    };
    try { await reload(); } catch (e) { empty(host, 'Không đọc được kho tư liệu: ' + e.message); }
  }

  /* 单条素材：全文 + 改标题/标签 + 改正文（要改才拉，平时不占内存）+ 删（二次确认） */
  async function materialOne(host, slug, id) {
    loading(host, 'Đang lấy tư liệu…');
    let it = null;
    try { it = (await get('/api/material/item', { slug, id })).item; }
    catch (e) { empty(host, 'Không lấy được tư liệu này: ' + e.message); return; }
    const paint = () => {
      host.innerHTML =
        '<div class="t-hint" style="margin:0 0 var(--sp-2)">' +
          esc([KIND_OF[it.kind] || it.kind, (it.tags || []).join(', '), ago(it.updated_at),
               (it.body || '').length + ' chữ'].filter(Boolean).join(' · ')) + '</div>' +
        '<div class="t-bar"><button class="t-btn" data-edit>Sửa tiêu đề / nhãn</button>' +
        '<button class="t-btn" data-body>Sửa nội dung</button>' +
        '<button class="t-btn dan" data-del>Xóa</button></div>' +
        ((it.body || '').trim()
          ? '<div class="t-pre" style="margin-top:var(--sp-3)">' + esc(it.body) + '</div>'
          : '<div class="t-empty">Mục này chỉ có tiêu đề, không có nội dung</div>');
      host.querySelector('[data-edit]').onclick = async () => {
        const title = await ask('Sửa tiêu đề', it.title);
        if (!title) return;
        const kindPick = await ask('Sửa phân loại (' + MATERIAL_KINDS.map(([k, l]) => k + '=' + l).join(', ') + ')',
          it.kind || 'note');
        if (kindPick == null) return;
        const tags = await ask('Sửa nhãn (cách nhau bằng dấu phẩy)', (it.tags || []).join(','));
        if (tags == null) return;
        try {
          await post('/api/material', { slug, id: it.id, title, kind: (kindPick || 'note').trim(),
            body: it.body || '', tags: tags.split(/[,，;；]+/).map((x) => x.trim()).filter(Boolean) });
          toast('Đã sửa xong'); hap();
          const d = await get('/api/material/item', { slug, id: it.id });
          it = d.item; paint();
        } catch (e) { toast('Không đổi được: ' + e.message); }
      };
      host.querySelector('[data-body]').onclick = async () => {
        const body = await ask('Sửa nội dung', it.body || '', { multiline: true });
        if (body == null) return;
        try {
          await post('/api/material', { slug, id: it.id, title: it.title, kind: it.kind,
            body, tags: it.tags || [] });
          toast('Đã sửa xong'); hap();
          const d = await get('/api/material/item', { slug, id: it.id });
          it = d.item; paint();
        } catch (e) { toast('Không đổi được: ' + e.message); }
      };
      host.querySelector('[data-del]').onclick = async () => {
        if (!(await confirmBox('Xóa «' + it.title + '»? Xóa rồi không lấy lại được.', true))) return;
        try { await del('/api/material', { slug, id: it.id }); toast('Đã xóa'); U().back(); }
        catch (e) { toast('Không xóa được: ' + e.message); }
      };
    };
    paint();
  }

  /* ══════════════════════════════════════════════════════════
     10. 数据与日志：备份 / 审计 / 日志 / 通知 / 自检
     ══════════════════════════════════════════════════════════ */
  /* ══════════════════════════════════════════════════════════
     参考书架：把"值得学的写法"存下来，写的时候能挑一句带进提示词
     ══════════════════════════════════════════════════════════ */
  /* 参考书架里那张图 / 那个文件的地址。App 里页面是 file://、拿不到 cookie，
     所以必须走 API.media()（换成带口令的绝对地址），跟封面同一套办法。 */
  function refFileUrl(slug, id) {
    const p = 'api/refs/file?slug=' + encodeURIComponent(slug) + '&id=' + encodeURIComponent(id);
    return window.API && window.API.media ? window.API.media(p) : p;
  }

  /* 看大图：整屏黑底、点一下就关。手机上可以双指放大（image 天然支持）。 */
  function bigImage(src, title) {
    const box = document.createElement('div');
    box.className = 't-bigpic';
    box.innerHTML = '<img src="' + esc(src) + '" alt="' + esc(title || '') + '">' +
                    '<div class="t-bigpic-cap">' + esc(title || '') + '</div>';
    box.onclick = () => box.remove();
    document.body.appendChild(box);
  }

  function openRefs(host) { Push.book('Giá sách tham khảo', refsHome); }

  async function refsHome(host, slug, q) {
    loading(host, 'Đang lật giá sách…');
    let d;
    try { d = await get('/api/refs', { slug, q: q || '' }); }
    catch (e) { empty(host, 'Không đọc được: ' + e.message); return; }
    const items = d.items || [];
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">Giá sách tham khảo: trích đoạn, cảm nhận, văn mẫu nguyên bài đều để ở đây. ' +
      ' Khi viết chính văn, tích chọn trong bàn viết là được, nó sẽ vào prompt dưới dạng «cách viết tham khảo». Chỉ học thủ pháp, không chép câu.<br>' +
      ' Nhận cả ảnh và tệp: gửi một ảnh tham khảo nhân vật, ghi rõ hiệu quả mong muốn trong phần mô tả. Khi viết, đoạn mô tả này cũng vào prompt. ' +
      '<b>Lưu ý: mô hình không thấy được bản thân ảnh</b>, nó chỉ thấy phần mô tả bạn viết.</div>' +
      '<input class="t-input" data-q placeholder="Tìm tiêu đề / nội dung / nguồn" value="' + esc(q || '') + '">' +
      '<div class="t-bar" style="margin:var(--sp-3) 0"><button class="t-btn pri" data-new>Thêm một mục</button>' +
      '<button class="t-btn" data-pick>Thu ảnh / tệp</button>' +
      '<input type="file" data-file hidden multiple accept="image/*,.md,.txt,.json,.csv,.yml,.yaml">' +
      ((d.tags || []).length ? (d.tags || []).map((t) =>
        '<button class="t-pill gray" data-tag="' + esc(t) + '">' + esc(t) + '</button>').join('') : '') +
      '</div>' +
      (items.length
        ? '<div class="t-list">' + items.map((it, i) => '<div class="t-row' +
            (it.kind === 'image' ? ' m-row' : '') + '" data-open="' + i + '">' +
            (it.kind === 'image' && it.hasFile
              ? '<img class="t-thumb" data-zoom="' + i + '" alt="' + esc(it.title) + '" src="' +
                esc(refFileUrl(slug, it.id)) + '">'
              : ico(it.kind === 'file' ? 'file' : 'note')) +
            '<div class="tr-main"><div class="tr-title">' + esc(it.title) + '</div>' +
            '<div class="tr-sub wrap">' + esc(it.preview || '(trống)') + '<br>' +
            esc([it.kind === 'image' ? 'Ảnh tham khảo' : (it.kind === 'file' ? 'Tệp tham khảo' : ''),
                 it.source, (it.tags || []).join(', '), it.words + ' chữ'].filter(Boolean).join(' · ')) +
            '</div></div><button class="t-btn sm dim" data-del="' + i + '">Xóa</button></div>').join('') + '</div>'
        : '<div class="t-empty">Giá sách trống. Thấy cách viết hay thì trích một câu vào — khi viết truyện dài đây là cách tự nâng cấp đỡ tốn công nhất.<br>' +
          ' Muốn gửi ảnh tham khảo thì bấm «Thu ảnh / tệp» ở trên.</div>');
    const box = host.querySelector('[data-q]');
    let timer = null;
    box.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => refsHome(host, slug, box.value.trim()), 350);
    });
    host.querySelector('[data-new]').onclick = () => { hap(); push('Thêm một mục', (h) => refForm(h, slug, null)); };
    const pick = host.querySelector('[data-pick]');
    const fileBox = host.querySelector('[data-file]');
    pick.onclick = () => { hap(); fileBox.click(); };
    fileBox.onchange = async () => {
      const files = Array.from(fileBox.files || []);
      fileBox.value = '';
      if (!files.length) return;
      const fd = new FormData();
      fd.append('slug', slug);
      files.forEach((f) => fd.append('files', f, f.name));
      const t = toast('Đang tải lên ' + files.length + ' …', 0);
      try {
        const d2 = await upload('api/refs/upload', fd);
        if (t) t.close();
        toast('Đã thu ' + (d2.count || files.length) + ' mục · bấm vào để viết mô tả');
        hap(); refsHome(host, slug, q);
      } catch (e) { if (t) t.close(); toast('Không tải lên được: ' + e.message); }
    };
    host.querySelectorAll('[data-zoom]').forEach((im) => {
      im.onclick = (e) => {
        e.stopPropagation();
        hap();
        const it = items[Number(im.dataset.zoom)];
        bigImage(refFileUrl(slug, it.id), it.title);
      };
    });
    host.querySelectorAll('[data-tag]').forEach((b) => {
      b.onclick = () => { hap(); refsHome(host, slug, b.dataset.tag); };
    });
    host.querySelectorAll('[data-open]').forEach((row) => {
      row.onclick = (e) => {
        if (e.target.closest('[data-del]')) return;
        hap();
        push('Sửa: ' + items[Number(row.dataset.open)].title,
             (h) => refForm(h, slug, items[Number(row.dataset.open)]));
      };
    });
    host.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const it = items[Number(b.dataset.del)];
        if (!(await confirmBox('Xóa «' + it.title + '»? ', true))) return;
        try { await del('/api/refs/item', { slug, id: it.id }); toast('Đã xóa'); hap(); refsHome(host, slug, q); }
        catch (err) { toast('Không xóa được: ' + err.message); }
      };
    });
  }

  async function refForm(host, slug, item) {
    let full = item;
    if (item && item.id) {
      loading(host, 'Mở…');
      try { full = await get('/api/refs/item', { slug, id: item.id }); }
      catch (e) { empty(host, 'Không đọc được: ' + e.message); return; }
    }
    const it = full || { title: '', source: '', kind: 'excerpt', tags: [], text: '' };
    const isImg = it.kind === 'image' && it.hasFile;
    host.innerHTML =
      '<div class="t-form">' +
      (it.hasFile
        ? '<div class="t-field"><label>' + (isImg ? 'Ảnh này' : 'Tệp này') + '</label>' +
          (isImg
            ? '<img class="t-pic" data-big src="' + esc(refFileUrl(slug, it.id)) + '" alt="' +
              esc(it.title || 'Ảnh tham khảo') + '">'
            : '<div class="t-hint" style="margin:0">Tệp:<b>' + esc(it.file || '') + '</b></div>') +
          '<div class="t-hint">Bấm ảnh để xem ảnh lớn (trên điện thoại có thể dùng hai ngón phóng to). Muốn đổi ảnh khác thì xóa mục này rồi tải lại.</div></div>'
        : '') +
      '<div class="t-field"><label>Đặt tên</label><input class="t-input" data-title value="' +
      esc(it.title || '') + '" placeholder="VD: viết cảnh đánh nhau thế nào / lời thoại chương ba"></div>' +
      '<div class="t-field"><label>Nguồn</label><input class="t-input" data-source value="' +
      esc(it.source || '') + '" placeholder="Sách nào / trang web nào / tự ghi"></div>' +
      '<div class="t-field"><label>Nhãn</label><input class="t-input" data-tags value="' +
      esc((it.tags || []).join(', ')) + '" placeholder="Cách nhau bằng dấu phẩy: đánh nhau, nhịp truyện"></div>' +
      '<div class="t-field"><label>' + (it.hasFile ? 'Mô tả (đoạn này sẽ vào prompt)' : 'Chính văn') + '</label>' +
      '<textarea class="t-area" data-text style="min-height:' + (it.hasFile ? '120' : '200') + 'px" ' +
      'placeholder="' + (it.hasFile
        ? 'Viết rõ ảnh này muốn thể hiện gì: VD «trước khi nói nàng luôn mím môi một cái, ánh mắt hơi bướng»'
        : 'Chép đoạn văn khiến bạn vỗ đùi khen hay vào đây') + '">' + esc(it.text || '') + '</textarea>' +
      '<div class="t-hint">' + (it.hasFile
        ? 'Mô hình không thấy bản thân ảnh — nó đọc «đoạn bạn viết ở đây» cộng với tên tệp. Vì vậy<b>mô tả càng cụ thể càng hữu ích</b>. '
        : 'Trích đoạn dùng để học thủ pháp: khi viết chỉ vào prompt dưới dạng «cách viết tham khảo». Sẽ ghi rõ không chép nguyên câu.') + '</div></div>' +
      '</div>' +
      '<div class="t-bar"><button class="t-btn pri" data-save>' + (it.id ? 'Lưu thay đổi' : 'Đặt lên giá') + '</button>' +
      '</div>';
    const big = host.querySelector('[data-big]');
    if (big) big.onclick = () => { hap(); bigImage(big.src, it.title || 'Ảnh tham khảo'); };
    host.querySelector('[data-save]').onclick = async () => {
      const body = { slug, title: host.querySelector('[data-title]').value.trim(),
                     source: host.querySelector('[data-source]').value.trim(),
                     tags: host.querySelector('[data-tags]').value,
                     text: host.querySelector('[data-text]').value,
                     kind: it.kind || 'excerpt' };
      if (!body.title) { toast('Hãy đặt tên trước'); return; }
      if (it.id) body.id = it.id;
      try {
        await post('/api/refs/item', body);
        toast('Đã thu xong'); hap();
        U().back();
      } catch (e) { toast('Không đặt vào được: ' + e.message); }
    };
  }

  /* 写作台里挑参考：勾几条，写的时候一起喂进去 */
  async function refPicker(host, slug, chosen, after) {
    let d;
    try { d = await get('/api/refs', { slug }); }
    catch (e) { toast('Không đọc được giá sách: ' + e.message); return; }
    const items = d.items || [];
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">Mục được tích sẽ vào prompt lần này dưới dạng «cách viết tham khảo» (tối đa 4 mục).</div>' +
      (items.length
        ? '<div class="t-list">' + items.map((it) => '<div class="t-row' +
            (it.kind === 'image' ? ' m-row' : '') + '" data-id="' + it.id + '">' +
            (it.kind === 'image' && it.hasFile
              ? '<img class="t-thumb" alt="" src="' + esc(refFileUrl(slug, it.id)) + '">'
              : ico(it.kind === 'file' ? 'file' : 'note')) +
            '<div class="tr-main"><div class="tr-title">' + esc(it.title) + '</div>' +
            '<div class="tr-sub wrap">' + esc(it.preview || '') + '</div></div>' +
            '<span class="t-pill ' + (chosen.indexOf(it.id) > -1 ? 'ok' : 'gray') + '" data-tick="' + it.id + '">' +
            (chosen.indexOf(it.id) > -1 ? 'Đã chọn' : 'Chọn') + '</span></div>').join('') + '</div>'
        : '<div class="t-empty">Giá sách còn trống, hãy vào «Giá sách tham khảo» đặt vài mục trước.</div>') +
      '<div class="t-bar" style="margin-top:var(--sp-3)"><button class="t-btn pri" data-ok>Xong</button></div>';
    host.querySelectorAll('[data-tick]').forEach((b) => {
      b.onclick = () => {
        hap();
        const id = Number(b.dataset.tick);
        const at = chosen.indexOf(id);
        if (at > -1) chosen.splice(at, 1);
        else if (chosen.length >= 4) { toast('Tích tối đa 4 mục'); return; }
        else chosen.push(id);
        refPicker(host, slug, chosen, after);
      };
    });
    const ok = host.querySelector('[data-ok]');
    if (ok) ok.onclick = () => { hap(); U().back(); if (after) after(); };
  }

  /* 数据与日志这一屏是**整包**的（备份整包、日志整机），不跟着某本书走；
     但切换入口照样给（全站同一个组件），在任何一屏都能看到现在在写哪本、随手就换。 */
  function openLogs(host) { Push.book('Dữ liệu và nhật ký', (h) => logsHome(h), { global: true }); }

  function logsHome(host) {
    tabShell(host, [['backup', 'Sao lưu'], ['audit', 'Thay đổi'], ['logs', 'Nhật ký'],
                    ['notify', 'Thông báo'], ['doctor', 'Tự kiểm tra']], {
      backup: (pane, repaint) => backupPane(pane, repaint),
      audit: (pane) => auditPane(pane),
      logs: (pane) => logsPane(pane),
      notify: (pane) => notifyPane(pane),
      doctor: (pane) => doctorPane(pane),
    });
  }

  async function backupPane(pane, repaint) {
    loading(pane, 'Đang xem sao lưu…');
    let d;
    try { d = await get('/api/backup/list'); } catch (e) { empty(pane, 'Không đọc được: ' + e.message); return; }
    const items = d.items || [];
    const auto = d.auto || {};
    pane.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">Sao lưu là trọn gói: tệp bản thảo + một ảnh chụp cơ sở dữ liệu, ' +
      ' lưu trên máy chủ, tổng cộng ' + esc(U().bytes(d.totalSize || 0)) + '. </div>' +
      '<div class="t-bar"><button class="t-btn pri" data-new>Sao lưu ngay bây giờ</button></div>' +
      '<div class="t-form">' +
      '<div class="t-field"><label>Tự động sao lưu</label><div class="t-seg wide" data-auto>' +
      '<button data-v="1" class="' + (auto.enabled ? 'on' : '') + '">Bật</button>' +
      '<button data-v="0" class="' + (auto.enabled ? '' : 'on') + '">Tắt</button></div>' +
      '<div class="t-hint">Cứ ' + (auto.everyHours || 24) + ' giờ sao lưu một lần, giữ lại ' +
      (auto.keep || 14) + ' bản gần nhất, bản cũ tự xóa.</div></div></div>' +
      (items.length ? '<div class="t-list">' + items.map((b, i) =>
        '<div class="t-row" data-i="' + i + '">' + ico('shield') +
        '<div class="tr-main"><div class="tr-title">' + esc(b.note || b.name) + '</div>' +
        '<div class="tr-sub">' + esc([ago(b.createdAt), U().bytes(b.size),
          b.books ? (b.books + ' cuốn') : '', b.withDb ? 'có cơ sở dữ liệu' : 'chỉ bản thảo'].filter(Boolean).join(' · ')) +
        '</div></div><span class="tr-go">' + window.iconHtml('chevron') + '</span></div>').join('') + '</div>'
        : '<div class="t-empty">Chưa có bản sao lưu nào</div>');
    pane.querySelector('[data-new]').onclick = async () => {
      const note = await ask('Bản sao lưu này tên là gì (có thể trống)', '', { placeholder: 'VD: trước khi sửa đại kết cục' });
      if (note == null) return;
      loading(pane, 'Đang đóng gói, sách nhiều thì mất vài giây…');
      try { await post('/api/backup/create', { note: note || 'Sao lưu thủ công' }); toast('Đã sao lưu'); hap(); }
      catch (e) { toast('Sao lưu thất bại: ' + e.message); }
      repaint();
    };
    pane.querySelector('[data-auto]').addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-v]'); if (!b) return;
      try {
        await post('/api/backup/auto', { enabled: b.dataset.v === '1' });
        toast('Đã ghi lại'); hap(); repaint();
      } catch (err) { toast('Không đổi được: ' + err.message); }
    });
    pane.querySelectorAll('[data-i]').forEach((r) => {
      r.onclick = () => {
        const b = items[Number(r.dataset.i)];
        hap();
        push('Sao lưu · ' + (b.note || b.name), (h2) => backupDetail(h2, b));
      };
    });
  }

  function backupDetail(host, b) {
    host.innerHTML =
      '<div class="t-form">' +
      '<div class="t-field"><label>Bản này có những gì</label>' +
      '<div class="t-hint" style="margin:0">' + esc([ago(b.createdAt), U().bytes(b.size),
        b.withDb ? 'Có cơ sở dữ liệu (thiết lập, phục bút, dòng thời gian)' : 'Chỉ có tệp bản thảo',
        b.books ? (b.books + ' cuốn') : ''].filter(Boolean).join(' · ')) + '</div></div>' +
      '<div class="t-field"><label>Khôi phục sẽ thế nào</label>' +
      '<div class="t-hint" style="margin:0">Trước khi khôi phục sẽ tự tạo một bản «ảnh chụp trước khôi phục», ' +
      ' bản thảo hiện tại chuyển vào data/trash/, tuyệt đối không xóa thẳng.</div></div>' +
      '</div>' +
      '<div class="t-bar"><button class="t-btn" data-dl>Tải về máy</button></div>' +
      '<div class="t-bar"><button class="t-btn" data-restore>Chỉ khôi phục bản thảo</button>' +
      '<button class="t-btn dan" data-restore-all>Khôi phục cả cơ sở dữ liệu</button></div>' +
      '<div class="t-bar"><button class="t-btn dan" data-del>Xóa bản sao lưu này</button></div>' +
      '<div data-out></div>';
    host.querySelector('[data-dl]').onclick = () => {
      download('api/backup/download?' + qs({ name: b.name }));
    };
    const restore = async (withDb) => {
      const ok = await confirmBox('Khôi phục bản này? ' +
        (withDb ? 'Thiết lập, phục bút, dòng thời gian cũng sẽ về trạng thái lúc đó.' : 'Chỉ thay tệp bản thảo, dữ liệu thiết lập không đổi.') +
        ' Trước khi khôi phục sẽ tự chụp một bản, có thể hoàn lại.', true);
      if (!ok) return;
      const out = host.querySelector('[data-out]');
      loading(out, 'Đang khôi phục…');
      try {
        await post('/api/backup/restore', { name: b.name, confirm: true, withDb });
        out.innerHTML = '<div class="t-hint">Đã khôi phục xong. Trong App nên kéo xuống làm mới giá sách.</div>';
        toast('Khôi phục hoàn tất'); hap();
      } catch (e) { out.innerHTML = '<div class="t-empty">Khôi phục thất bại: ' + esc(e.message) + '</div>'; }
    };
    host.querySelector('[data-restore]').onclick = () => restore(false);
    host.querySelector('[data-restore-all]').onclick = () => restore(true);
    host.querySelector('[data-del]').onclick = async () => {
      if (!(await confirmBox('Xóa bản sao lưu này? Xóa rồi không lấy lại được.', true))) return;
      try { await del('/api/backup/item', { name: b.name }); toast('Đã xóa'); hap(); U().back(); }
      catch (e) { toast('Không xóa được: ' + e.message); }
    };
  }

  const ACTION_CN = {
    'backup.create': 'Đã sao lưu', 'backup.auto': 'Tự động sao lưu', 'backup.restore': 'Đã khôi phục sao lưu',
    replace: 'Thay thế toàn văn', write: 'AI ghi vào', import: 'Nhập',
  };

  async function auditPane(pane) {
    loading(pane, 'Đang đọc ghi chép…');
    let d;
    try { d = await get('/api/audit', { limit: 150 }); } catch (e) { empty(pane, 'Không đọc được: ' + e.message); return; }
    const items = d.items || [];
    pane.innerHTML = '<div class="t-hint" style="margin:0 0 var(--sp-3)">Ai, lúc nào, đã động vào gì, đều ghi ở đây. ' +
      ' Sửa hỏng muốn tìm nguyên nhân thì vào đây xem trước.</div>' +
      (items.length ? '<div class="t-list">' + items.map((a) =>
        '<div class="t-row static">' + ico('history') +
        '<div class="tr-main"><div class="tr-title">' + esc(ACTION_CN[a.action] || a.action) +
        (a.slug ? ' ' + esc(a.slug) : '') + '</div>' +
        '<div class="tr-sub">' + esc([ago(a.at), a.actor === 'system' ? 'Hệ thống' : 'Bạn',
          JSON.stringify(a.detail || {}) === '{}' ? '' : JSON.stringify(a.detail)].filter(Boolean).join(' · ')) +
        '</div></div></div>').join('') + '</div>'
        : '<div class="t-empty">Chưa có ghi chép nào</div>');
  }

  async function logsPane(pane) {
    loading(pane, 'Đang xem nhật ký…');
    let d;
    try { d = await get('/api/app/logs/status'); } catch (e) { empty(pane, 'Không đọc được: ' + e.message); return; }
    const files = d.files || [];
    pane.innerHTML =
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + (d.fileCount || 0) + '</b><span>Tệp nhật ký</span></div>' +
      '<div class="t-stat"><b>' + esc(U().bytes(d.totalBytes || 0)) + '</b><span>Tổng dung lượng</span></div>' +
      '<div class="t-stat"><b>' + (d.latestMtimeMs ? ago(d.latestMtimeMs) : '—') + '</b><span>Ghi gần nhất</span></div>' +
      '</div>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">Nhật ký nằm trên máy chủ ở ' + esc(d.directory || '') +
      '. Khi có sự cố, tải về để đưa AI xem.</div>' +
      (files.length ? '<div class="t-list">' + files.slice().reverse().map((f) =>
        '<div class="t-row static">' + ico('terminal') +
        '<div class="tr-main"><div class="tr-title">' + esc(f.name) + '</div>' +
        '<div class="tr-sub">' + esc(U().bytes(f.size) + ' · ' + ago(f.mtimeMs)) + '</div></div>' +
        '<button class="t-btn sm" data-dl="' + esc(f.name) + '">Tải về</button></div>').join('') + '</div>'
        : '<div class="t-empty">Chưa có tệp nhật ký</div>');
    pane.querySelectorAll('[data-dl]').forEach((b) => {
      b.onclick = () => download('api/app/logs/download?' + qs({ file: b.dataset.dl }));
    });

    /* 离线缓存：读过就存一份在本机（浏览器/App 都是这块 localStorage），断网接着看 */
    const off = window.Offline ? Offline.stats() : { books: 0, chapters: 0, chars: 0 };
    const box = document.createElement('div');
    box.innerHTML =
      '<h2 class="st-h">Bộ nhớ đệm ngoại tuyến</h2>' +
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + off.books + '</b><span>Sách đã lưu đệm</span></div>' +
      '<div class="t-stat"><b>' + off.chapters + '</b><span>Chương đã lưu đệm</span></div>' +
      '<div class="t-stat"><b>' + off.chars + '</b><span>Số chữ</span></div></div>' +
      '<div class="t-hint">Chương đã đọc sẽ tự lưu một bản trên máy, mất mạng vẫn đọc tiếp được (tối đa 120 chương, ' +
      ' quá thì bỏ chương đọc sớm nhất). Xóa đi không ảnh hưởng bản gốc trên máy chủ.</div>' +
      '<div class="t-bar"><button class="t-btn dan" data-offclear>Xóa bộ nhớ đệm ngoại tuyến</button></div>';
    pane.appendChild(box);
    box.querySelector('[data-offclear]').onclick = async () => {
      if (!(await confirmBox('Xóa bộ nhớ đệm ngoại tuyến trên máy? Bản thảo trên máy chủ không bị động chữ nào.', true))) return;
      const st = window.Offline ? Offline.clear() : { chapters: 0 };
      toast('Đã xóa ' + st.chapters + ' chương đệm'); hap();
      logsPane(pane);
    };
  }

  async function notifyPane(pane) {
    loading(pane, 'Đang xem thông báo…');
    let d;
    try { d = await get('/api/notifications', { limit: 50 }); }
    catch (e) { empty(pane, 'Không đọc được: ' + e.message); return; }
    const items = d.items || [];
    pane.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">' + (d.unread || 0) + ' mục chưa đọc.</div>' +
      '<div class="t-bar"><button class="t-btn" data-read>Đánh dấu tất cả đã đọc</button></div>' +
      (items.length ? '<div class="t-list">' + items.map((n) =>
        '<div class="t-row static' + (n.read_at ? '' : '') + '">' + ico('dot') +
        '<div class="tr-main"><div class="tr-title">' + esc(n.title) + '</div>' +
        '<div class="tr-sub wrap">' + esc([n.body || '', n.slug || '', ago(n.created_at)].filter(Boolean).join(' · ')) +
        '</div></div>' + (n.read_at ? '<span class="t-pill gray">Đã đọc</span>' : '<span class="t-pill">Mới</span>') +
        '</div>').join('') + '</div>'
        : '<div class="t-empty">Chưa có thông báo</div>');
    pane.querySelector('[data-read]').onclick = async () => {
      try { await post('/api/notifications/read', { all: true }); toast('Đã đánh dấu tất cả đã đọc'); hap();
        notifyPane(pane); }
      catch (e) { toast('Không đổi được: ' + e.message); }
    };
  }

  async function doctorPane(pane) {
    loading(pane, 'Đang khám dữ liệu…');
    let d;
    try { d = await get('/api/backup/doctor'); } catch (e) { empty(pane, 'Không kiểm tra được: ' + e.message); return; }
    const issues = d.issues || [];
    pane.innerHTML =
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + (d.books || 0) + '</b><span>cuốn</span></div>' +
      '<div class="t-stat"><b>' + (d.count || 0) + '</b><span>Vấn đề</span></div>' +
      '<div class="t-stat"><b>' + (d.backups || 0) + '</b><span>bản sao lưu</span></div></div>' +
      (d.clean ? '<div class="t-empty">' + window.iconHtml('check') +
        '<div style="margin-top:var(--sp-3)">Dữ liệu sạch, không phát hiện vấn đề</div></div>'
        : '<div class="t-list">' + issues.map((it) =>
          '<div class="t-row static warn">' + ico('shield') +
          '<div class="tr-main"><div class="tr-title">' + esc(it.kind || 'Vấn đề') +
          (it.slug ? ' ' + esc(it.slug) : '') + '</div>' +
          '<div class="tr-sub wrap">' + esc(it.hint || '') +
          (it.path ? ' ' + esc(it.path) : '') + '</div></div></div>').join('') + '</div>') +
      (d.brokenBackups && d.brokenBackups.length
        ? '<h2 class="st-h">Danh sách sao lưu có chỗ không khớp</h2><div class="t-hint">' +
          esc(d.brokenBackups.join(', ')) + '</div>' : '');
  }

  /* ══════════════════════════════════════════════════════════
     11. 提示词库：AI 人设提示词（可改 / 可版本 / 可回滚 / 可对比）+ 常用片段
     改完立刻生效——拼系统提示词的地方（server/llm/prompts.build_system）读的就是这份。
     ══════════════════════════════════════════════════════════ */
  const SOURCE_CN = { book: 'riêng của cuốn này', global: 'Tùy chỉnh toàn cục', builtin: 'Mặc định dựng sẵn' };

  function openPrompt(host) { Push.book('Prompt', promptHome); }

  function promptHome(host, slug) {
    tabShell(host, [['book', 'Cuốn này'], ['global', 'Toàn cục'], ['snippet', 'Đoạn thường dùng']], {
      book: (pane) => promptList(pane, slug, 'book'),
      global: (pane) => promptList(pane, '', 'global'),
      snippet: (pane) => snippetList(pane),
    });
  }

  async function promptList(pane, slug, scope) {
    loading(pane, 'Đang đọc prompt…');
    let d;
    try { d = await get('/api/prompts', scope === 'book' ? { slug: slug } : {}); }
    catch (e) { empty(pane, 'Không đọc được: ' + e.message); return; }
    const items = d.items || [];
    pane.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">' +
      (scope === 'book'
        ? 'Ở đây sửa bản dành riêng cho cuốn này; mục nào chưa sửa thì theo toàn cục hoặc dựng sẵn.'
        : 'Bản toàn cục: mọi sách mặc định đều dùng bản này, từng cuốn còn có thể ghi đè thêm một lớp.') +
      '</div>' +
      '<div class="t-list">' + items.map((it, i) =>
        '<div class="t-row" data-i="' + i + '">' + ico('spark') +
        '<div class="tr-main"><div class="tr-title">' + esc(it.name) + '</div>' +
        '<div class="tr-sub">' + esc(SOURCE_CN[it.source] || it.source) +
        (it.version ? ' · v' + it.version : '') + ' · ' + (it.body || '').length + ' chữ</div></div>' +
        '<span class="t-pill ' + (it.source === 'builtin' ? 'gray' : 'ok') + '">' +
        (it.source === 'builtin' ? 'Mặc định' : 'Đã sửa') + '</span>' +
        '<span class="tr-go">' + window.iconHtml('chevron') + '</span></div>').join('') +
      '</div>';
    pane.querySelectorAll('[data-i]').forEach((r) => {
      r.onclick = () => {
        hap();
        const it = items[Number(r.dataset.i)];
        push('Prompt · ' + it.name, (h) => promptDetail(h, it, slug, scope));
      };
    });
  }

  async function promptDetail(host, item, slug, scope) {
    loading(host, 'Đang mở bản này…');
    let it = item;
    try {
      const d = await get('/api/prompts', scope === 'book' ? { slug: slug } : {});
      it = (d.items || []).find((x) => x.key === item.key) || item;
    } catch (e) {}
    const src = SOURCE_CN[it.source] || it.source;
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">' + esc(it.description || '') + '</div>' +
      '<div class="t-form"><div class="t-field"><label>Nội dung bản này</label>' +
      '<textarea class="t-area" id="pm-body" rows="12" spellcheck="false"></textarea>' +
      '<div class="t-hint" id="pm-hint" style="margin:0"></div></div></div>' +
      '<div class="t-bar">' +
      '<button class="t-btn pri" data-save>Lưu phiên bản này</button>' +
      '<button class="t-btn" data-hist>Lịch sử (' + (it.version || 0) + ')</button>' +
      '<button class="t-btn" data-builtin>Xem bản gốc dựng sẵn</button>' +
      (it.source === 'builtin' ? '' : '<button class="t-btn dan" data-reset>Khôi phục dựng sẵn</button>') +
      '</div>';
    const ta = host.querySelector('#pm-body');
    ta.value = it.body || '';
    const hint = host.querySelector('#pm-hint');
    hint.textContent = 'Đang dùng: ' + src + (it.version ? '(v' + it.version + ')' : '')
      + '. Mỗi lần lưu sẽ ghi một phiên bản, sửa hỏng có thể quay lại.';

    host.querySelector('[data-save]').onclick = async () => {
      const body = ta.value;
      if (!body.trim()) { toast('Nội dung không được để trống'); return; }
      const note = await ask('Phiên bản này sửa gì (có thể để trống)', '', { host });
      if (note === null) return;
      try {
        const r = await post('/api/prompts/save', { key: it.key, scope, slug: scope === 'book' ? slug : '', body, note: note || '' });
        hap(); toast('Đã lưu (v' + r.version + ')');
        promptDetail(host, it, slug, scope);
      } catch (e) { toast('Không lưu được: ' + e.message); }
    };
    host.querySelector('[data-builtin]').onclick = () => {
      hap();
      App.sheet('<div class="t-dialog"><h3>Bản gốc dựng sẵn (chỉ đọc)</h3>' +
        '<div class="t-hint" style="white-space:pre-wrap;max-height:56vh;overflow:auto">' +
        esc(it.builtin || '(Bản này không có nội dung dựng sẵn)') + '</div>' +
        '<div class="t-acts"><button class="t-btn" data-close>Đóng</button></div></div>');
    };
    host.querySelector('[data-hist]').onclick = () => { hap(); push('Prompt · Lịch sử', (h) => promptHistory(h, it, slug, scope, host)); };
    const rb = host.querySelector('[data-reset]');
    if (rb) rb.onclick = async () => {
      const yes = await confirmBox('Xóa bản tùy chỉnh này, để nó quay về lớp dưới (' +
        (scope === 'book' ? 'toàn cục hoặc dựng sẵn' : 'dựng sẵn') + ')? Lịch sử vẫn được giữ, lúc nào cũng lấy lại được.', true);
      if (!yes) return;
      try {
        await del('/api/prompts/override', { key: it.key, scope, slug: scope === 'book' ? slug : '' });
        hap(); toast('Đã khôi phục'); promptDetail(host, it, slug, scope);
      } catch (e) { toast('Không xóa được: ' + e.message); }
    };
  }

  async function promptHistory(host, item, slug, scope, backHost) {
    loading(host, 'Đang đọc lịch sử…');
    let d;
    try {
      d = await get('/api/prompts/versions', { key: item.key, scope, slug: scope === 'book' ? slug : '' });
    } catch (e) { empty(host, 'Không đọc được: ' + e.message); return; }
    const vs = d.versions || [];
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">Mọi phiên bản đã sửa của prompt này đều giữ ở đây (tổng ' + vs.length + ' bản). ' +
      ' Quay lại không phải xóa lịch sử, mà là lấy bản cũ lưu thành một bản mới.</div>' +
      (vs.length ? '<div class="t-list">' + vs.map((v, i) =>
        '<div class="t-row" data-i="' + i + '">' + ico('history') +
        '<div class="tr-main"><div class="tr-title">v' + v.version + ' ' + esc(v.note || '(Không ghi chú)') + '</div>' +
        '<div class="tr-sub">' + esc(ago(v.createdAt)) + ' · ' + v.chars + ' chữ</div></div>' +
        '<span class="tr-go">' + window.iconHtml('chevron') + '</span></div>').join('') + '</div>'
        : '<div class="t-empty">Chưa sửa lần nào, không có bản cũ nào</div>') +
      (vs.length ? '<div class="t-bar"><button class="t-btn dan" data-clear>Xóa lịch sử</button></div>' : '');
    host.querySelectorAll('[data-i]').forEach((r) => {
      r.onclick = () => {
        hap();
        const v = vs[Number(r.dataset.i)];
        push('v' + v.version + ' So sánh', (h) => promptDiff(h, item, v, slug, scope, host));
      };
    });
    const cb = host.querySelector('[data-clear]');
    if (cb) cb.onclick = async () => {
      const yes = await confirmBox('Xóa các phiên bản lịch sử của prompt này? Bản đang có hiệu lực không bị động tới.', true);
      if (!yes) return;
      try {
        await del('/api/prompts/versions', { key: item.key, scope, slug: scope === 'book' ? slug : '' });
        hap(); toast('Đã xóa sạch'); promptHistory(host, item, slug, scope, backHost);
      } catch (e) { toast('Không xóa được: ' + e.message); }
    };
  }

  async function promptDiff(host, item, ver, slug, scope, histHost) {
    loading(host, 'So sánh…');
    let d;
    try {
      d = await get('/api/prompts/diff', { key: item.key, version: ver.version, scope, slug: scope === 'book' ? slug : '' });
    } catch (e) { empty(host, 'Không so sánh được: ' + e.message); return; }
    const lines = (d.diff || []).map((l) => {
      const cls = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : '';
      return '<div' + (cls ? ' class="' + cls + '"' : '') + '>' + esc(l || ' ') + '</div>';
    }).join('');
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">v' + ver.version + '(' + esc(ver.note || 'Không ghi chú') +
      ') so với<b>bản đang có hiệu lực</b>:<span style="color:var(--ok)">màu xanh là phần hiện tại có thêm</span>, ' +
      '<span style="color:var(--danger)">màu đỏ là phần hiện tại thiếu</span>. </div>' +
      (lines ? '<div class="st-diff">' + lines + '</div>' : '<div class="t-empty">Phiên bản này giống hệt hiện tại</div>') +
      '<div class="t-bar"><button class="t-btn pri sm" data-roll>Đổi về v' + ver.version + ' </button></div>';
    host.querySelector('[data-roll]').onclick = async () => {
      const yes = await confirmBox('Đổi nội dung thành v' + ver.version + ' ? Sẽ thêm một bản ghi phiên bản mới, lịch sử không mất.', false);
      if (!yes) return;
      try {
        const r = await post('/api/prompts/rollback', { key: item.key, version: ver.version, scope, slug: scope === 'book' ? slug : '' });
        hap(); toast('Đã quay về v' + ver.version + '  (phiên bản mới v' + r.version + ')');
        promptHistory(host, item, slug, scope, histHost);
      } catch (e) { toast('Không quay lại được: ' + e.message); }
    };
  }

  async function snippetList(pane) {
    loading(pane, 'Đang đọc đoạn…');
    let d;
    try { d = await get('/api/snippets'); } catch (e) { empty(pane, 'Không đọc được: ' + e.message); return; }
    const items = d.items || [];
    pane.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">Mảnh lệnh thường dùng: những câu cứ phải dùng đi dùng lại khi viết chính văn, sửa bản thảo, lưu ở đây để lấy bất cứ lúc nào.</div>' +
      '<div class="t-bar"><button class="t-btn pri" data-new>Tạo đoạn mới</button></div>' +
      (items.length ? '<div class="t-list">' + items.map((it, i) =>
        '<div class="t-row" data-i="' + i + '">' + ico('note') +
        '<div class="tr-main"><div class="tr-title">' + esc(it.name) + '</div>' +
        '<div class="tr-sub wrap">' + esc((it.body || '').slice(0, 60)) +
        (it.tags ? ' #' + esc(it.tags) : '') + '</div></div>' +
        '<button class="t-btn sm dan" data-del="' + i + '">Xóa</button></div>').join('') + '</div>'
        : '<div class="t-empty">Chưa có đoạn nào</div>');

    const refresh = () => snippetList(pane);

    const addOne = async (it) => {
      const name = await ask('Đoạn này tên là gì', it ? it.name : '', { host: pane });
      if (name === null || !name.trim()) return;
      const body = await ask('Nội dung đoạn', it ? it.body : '', { host: pane, multiline: true });
      if (body === null || !body.trim()) return;
      const tags = await ask('Đánh dấu (có thể để trống)', it ? it.tags : '', { host: pane });
      if (tags === null) return;
      try {
        await post('/api/snippets/save', { key: it ? it.key : '', name, body, tags });
        hap(); toast('Đã lưu'); refresh();
      } catch (e) { toast('Không lưu được: ' + e.message); }
    };
    pane.querySelector('[data-new]').onclick = () => addOne(null);
    pane.querySelectorAll('[data-i]').forEach((r) => {
      r.onclick = (e) => { if (e.target.closest('[data-del]')) return; hap(); addOne(items[Number(r.dataset.i)]); };
    });
    pane.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const it = items[Number(b.dataset.del)];
        const yes = await confirmBox('Xóa đoạn «' + it.name + '»? ', true);
        if (!yes) return;
        try { await del('/api/snippets', { key: it.key }); hap(); toast('Đã xóa'); clipaint(); }
        catch (err) { toast('Không xóa được: ' + err.message); }
      };
    });
  }

  /* ══════════════════════════════════════════════════════════
     注册到工具宫格（宫格和分组在 tools.js 里，这里只加卡片）
     ══════════════════════════════════════════════════════════ */
  if (window.Tools && window.Tools.add) {
    window.Tools.add([
      { id: 'write', name: 'Bàn viết', sub: 'Tạo · Viết tiếp', icon: 'wand', sec: 'Viết', run: openWrite },
      { id: 'world', name: 'Thế giới', sub: 'Nhân vật · Dòng thời gian', icon: 'layers', sec: 'Viết', run: openWorld },
      { id: 'plot', name: 'Cốt truyện', sub: 'Phục bút · Quyết định', icon: 'bookmark', sec: 'Viết', run: openPlot },
      { id: 'lint', name: 'Soát lỗi', sub: 'Giọng AI', icon: 'check', sec: 'Viết', run: openLint },
      { id: 'prompt', name: 'Prompt', sub: 'Nhân vật · Đoạn', icon: 'spark', sec: 'Viết', run: openPrompt },
      { id: 'stats', name: 'Thống kê', sub: 'Số chữ · Thành tựu', icon: 'chart', sec: 'Viết', run: openStats },
      { id: 'export', name: 'Xuất', sub: 'TXT·EPUB', icon: 'download', sec: 'Bản thảo', run: openExport },
      { id: 'material', name: 'Tư liệu', sub: 'Mảnh ý tưởng', icon: 'note', sec: 'Bản thảo', run: openMaterial },
      { id: 'refs', name: 'Giá sách tham khảo', sub: 'Học cách viết', icon: 'bookmark', sec: 'Bản thảo', run: openRefs },
      { id: 'term', name: 'Thuật ngữ', sub: 'Thống nhất cách gọi', icon: 'tag', sec: 'Bản thảo', run: openTerm },
      { id: 'listen', name: 'Nghe truyện', sub: 'Giọng đọc · Tốc độ', icon: 'sound', sec: 'Hệ thống', run: openListen },
      { id: 'logs', name: 'Dữ liệu', sub: 'Sao lưu · Nhật ký', icon: 'shield', sec: 'Hệ thống', run: openLogs },
    ]);
  }
})();
