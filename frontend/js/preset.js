/* ============================================================
   preset.js — 「预设」页
   小说软件里管写作人设 / 文风 / 尺度 / 模型参数的那套东西，
   就是酒馆里的「预设」。这里把它整页搬进 App。
   数据全部来自 /api/presets，字段名和可选项都由平台自己给，不写死。
   ============================================================ */
(function () {
  const q = (s, r) => (r || document).querySelector(s);
  const CHEV = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" '
    + 'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* 置顶规则单独一张卡——它优先级最高，是 AI 的总开关 */
  const TOP_PATH = 'customTopSystemPrompt';
  const EFFORT = [['', 'Theo mặc định'], ['off', 'Tắt'], ['low', 'Thấp'], ['medium', 'Vừa'], ['high', 'Cao'], ['xhigh', 'Rất cao'], ['max', 'Tối đa']];

  const S = { data: null, key: null, draft: null, dirty: false, busy: false, loaded: false,
              scope: 'global', slug: '', hasOwn: false };

  const prof = () => (S.data.profiles || []).find((p) => p.profileKey === S.key) || {};
  const vals = () => S.draft[S.key].values;
  const mdl = () => S.draft[S.key].model;

  function mark(dirty) {
    S.dirty = dirty;
    const bar = q('#preset-save');
    if (bar) bar.classList.add('show');           // 常驻，别让用户找保存键
    const btn = q('#preset-save [data-save]');
    if (btn) btn.disabled = !dirty;
    const msg = q('#preset-save .msg');
    if (msg) msg.textContent = dirty ? 'Có thay đổi, chưa lưu' : 'Khớp với nền tảng';
    const top = q('#preset-save-top');
    if (top) top.classList.toggle('has-dot', !!dirty);
  }

  /* ---------------- 渲染 ---------------- */

  function ctrl(f) {
    const v = vals()[f.path];
    const ph = esc(f.placeholder || '');
    if (f.component === 'radio' || f.component === 'select') {
      const opts = f.options || [];
      if (opts.length > 4) return picker(f);
      /* 标签长的选项（后端发来的「短（2000 字上下）」这种）横排时会被挤成 2~3 行 ——
         毛病「跟随系统被挤成两行」是同一类。长标签改成竖排一行一个，左对齐。 */
      const longLabel = opts.some((o) => String(o.label || '').replace(/\s+/g, '').length > 5);
      return '<div class="pradio' + (longLabel ? ' pradio-list' : '') + '" data-radio="' + esc(f.path) + '">' + opts.map((o) =>
        '<button type="button" data-v="' + esc(o.value) + '"'
        + (String(v) === String(o.value) ? ' class="on"' : '') + '>'
        + esc(o.label) + (o.description ? '<small>' + esc(o.description) + '</small>' : '')
        + '</button>').join('') + '</div>';
    }
    if (f.component === 'resource-preset') return picker(f);
    if (f.component === 'textarea') {
      return '<textarea class="ptextarea" data-in="' + esc(f.path) + '" rows="' + (f.rows || 6)
        + '" placeholder="' + ph + '">' + esc(v == null ? '' : v) + '</textarea>';
    }
    const isNum = f.component === 'number';
    if (isNum) {
      return '<input class="pinput" type="number" inputmode="decimal" '
        + 'data-in="' + esc(f.path) + '" value="' + esc(v == null ? '' : v) + '" placeholder="' + ph + '">';
    }
    // 自由文本一律用「会自己长高的多行框」：
    // 单行 input 放长文（比如 200 多字的写作要求）会横向滚出去，很丑。
    return '<textarea class="ptextarea pgrow" rows="1" data-in="' + esc(f.path)
      + '" placeholder="' + ph + '">' + esc(v == null ? '' : v) + '</textarea>';
  }

  /* 多行框自增高：CSS field-sizing 优先，老 WebView 用脚本兜底 */
  function grow(el) {
    if (!el || !el.classList.contains('pgrow')) return;
    el.style.height = 'auto';
    el.style.height = Math.max(44, Math.min(el.scrollHeight, window.innerHeight * 0.42)) + 'px';
  }
  document.addEventListener('input', (e) => grow(e.target), true);
  

  function picker(f) {
    const v = vals()[f.path];
    const hit = (f.options || []).find((o) => o.value === v);
    const empty = v === '' || v == null;
    const sub = empty ? 'Bấm để chọn một mục từ kho preset' : String(v).split('/').pop();
    return '<button type="button" class="ppick' + (empty ? ' empty' : '') + '" data-pick="' + esc(f.path) + '">'
      + '<span class="txt"><b>' + esc(hit ? hit.label : (empty ? 'Chưa chỉ định · dùng mặc định nền tảng' : v)) + '</b>'
      + '<span>' + esc(sub) + '</span></span><span class="chev">' + CHEV + '</span></button>';
  }

  function fieldHtml(f) {
    const tags = f.component === 'resource-preset' ? '<span class="tag">Kho preset</span>'
      : (f.component === 'textarea' ? '<span class="tag">Văn bản dài</span>' : '');
    return '<div class="pfield"><div class="pfield-lb">' + esc(f.label) + tags + '</div>'
      + (f.description ? '<p class="pfield-ds">' + esc(f.description) + '</p>' : '')
      + '<div class="pfield-ct">' + ctrl(f) + '</div></div>';
  }

  function modelCard() {
    const m = mdl();
    const hit = (S.data.models || []).find((x) => x.key === m.modelKey);
    const row = (k, c) => '<div class="pfield"><div class="pfield-lb">' + k + '</div><div class="pfield-ct">' + c + '</div></div>';
    return '<div class="pcard"><div class="pcard-hd"><h3>Mô hình và cảm giác</h3><span class="hint">Sửa xong bấm Lưu ở góc dưới phải</span></div>'
      + '<div class="pcard-bd">'
      + row('Dùng mô hình nào', '<button type="button" class="ppick' + (m.modelKey ? '' : ' empty') + '" data-pick="__model">'
        + '<span class="txt"><b>' + esc(hit ? hit.label : (m.modelKey || 'Theo mặc định nền tảng')) + '</b>'
        + '<span>' + esc(m.modelKey || 'Bấm để chọn một mô hình') + '</span></span><span class="chev">' + CHEV + '</span></button>')
      + row('Nhiệt độ <span class="hint">càng cao càng phân tán, để trống = mặc định</span>',
        '<input class="pinput" inputmode="decimal" data-model="temperature" value="'
        + esc(m.temperature == null ? '' : m.temperature) + '" placeholder="Mặc định (để trống)">')
      + row('TopK <span class="hint">phạm vi ứng viên, để trống = mặc định</span>',
        '<input class="pinput" inputmode="numeric" data-model="topK" value="'
        + esc(m.topK == null ? '' : m.topK) + '" placeholder="Mặc định (để trống)">')
      + row('Cường độ suy nghĩ', '<button type="button" class="ppick" data-pick="__effort">'
        + '<span class="txt"><b>' + esc((EFFORT.find((e) => e[0] === (m.reasoningEffort || '')) || EFFORT[0])[1]) + '</b>'
        + '<span>' + esc(m.reasoningEffort || 'Theo cài đặt mặc định của nền tảng') + '</span></span>'
        + '<span class="chev">' + CHEV + '</span></button>')
      + row('Xuất dạng luồng', '<div class="pradio" data-stream>'
        + '<button type="button" data-v="1"' + (m.stream === false ? '' : ' class="on"') + '>Vừa nghĩ vừa ra chữ</button>'
        + '<button type="button" data-v="0"' + (m.stream === false ? ' class="on"' : '') + '>Ra hết một lần</button></div>')
      + '</div></div>';
  }

  function render() {
    const host = q('#preset-body');
    if (!host) return;
    const p = prof();
    const fields = p.fields || [];
    const top = fields.filter((f) => f.path === TOP_PATH);
    const rest = fields.filter((f) => f.path !== TOP_PATH);

    host.innerHTML =
      '<div class="preset-seg">' + (S.data.profiles || []).map((x) =>
        '<button type="button" data-key="' + esc(x.profileKey) + '"'
        + (x.profileKey === S.key ? ' class="on"' : '') + '>' + esc(x.name) + '</button>').join('')
      + '</div>'
      + modelCard()
      + (top.length ? '<div class="pcard"><div class="pcard-hd"><h3>Quy tắc ghim</h3>'
        + '<span class="hint">Ưu tiên cao nhất, chương nào cũng đưa cho AI</span></div><div class="pcard-bd">'
        + top.map(fieldHtml).join('') + '</div></div>' : '')
      + (rest.length ? '<div class="pcard"><div class="pcard-hd"><h3>Thiết lập viết</h3>'
        + '<span class="hint">' + rest.length + ' mục</span></div><div class="pcard-bd">'
        + rest.map(fieldHtml).join('') + '</div></div>' : '')
      + '<p class="pfield-ds" style="padding:2px var(--sp-2) var(--sp-2)">Thay đổi chỉ ảnh hưởng bản thảo viết mới sau này của danh tính này, các chương đã có không bị động tới.</p>';

    const body = q('#preset-body');
    if (body) body.scrollTop = 0;
    mark(false);
  }

  /* ---------------- 交互 ---------------- */

  function onInput(e) {
    const t = e.target;
    if (t.dataset.in) {
      vals()[t.dataset.in] = t.value;
      mark(true);                     // 必须走 mark：它负责把「保存」按钮解禁
    } else if (t.dataset.model) {
      const raw = t.value.trim();
      mdl()[t.dataset.model] = raw === '' ? null : (isNaN(Number(raw)) ? raw : Number(raw));
      mark(true);
    }
  }

  function onClick(e) {
    const seg = e.target.closest('[data-key]');
    if (seg) { S.key = seg.dataset.key; render(); return; }

    const rb = e.target.closest('.pradio[data-radio] button');
    if (rb) {
      const grp = rb.closest('[data-radio]');
      vals()[grp.dataset.radio] = rb.dataset.v;
      grp.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === rb));
      mark(true); App.haptic && App.haptic(); return;
    }
    const eb = e.target.closest('[data-effort] button');
    if (eb) {
      mdl().reasoningEffort = eb.dataset.v || null;
      eb.parentNode.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === eb));
      mark(true); App.haptic && App.haptic(); return;
    }
    const sb = e.target.closest('[data-stream] button');
    if (sb) {
      mdl().stream = sb.dataset.v === '1';
      sb.parentNode.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === sb));
      mark(true); App.haptic && App.haptic(); return;
    }
    const pk = e.target.closest('[data-pick]');
    if (pk) {
      const path = pk.dataset.pick;
      if (path === '__model') openModelPick();
      else if (path === '__effort') openEffortPick();
      else openPick(prof().fields.find((f) => f.path === path));
      return;
    }
  }

  /* 选择抽屉：预设库 / 模型，都带搜索 */
  function openList(title, items, cur, onPick, previewPath, opts) {
    opts = opts || {};
    const html =
      '<div class="sheet-grip"></div>'
      + '<div class="pk-search"><input id="pk-q" placeholder="Tìm kiếm" autocomplete="off"></div>'
      + (previewPath ? '<div style="padding:var(--sp-3) var(--sp-4) 0"><button type="button" class="btn sm" id="pk-view">Xem mục hiện tại viết gì</button></div>' : '')
      + (opts.head || '')
      + '<div class="pk-preview hidden" id="pk-prev"></div>'
      + '<ul class="pk-list" id="pk-list"></ul>';
    App.sheet(html, {
      onMount(panel) {
        const list = q('#pk-list', panel);
        const input = q('#pk-q', panel);
        const draw = (kw) => {
          const k = (kw || '').trim().toLowerCase();
          const hit = items.filter((it) => !k || (it.label || '').toLowerCase().includes(k)
            || String(it.value).toLowerCase().includes(k));
          list.innerHTML = hit.slice(0, 400).map((it) =>
            '<li data-v="' + esc(it.value) + '"' + (it.value === cur ? ' class="on"' : '') + '>'
            + '<span class="t">' + esc(it.label) + '</span>'
            + (it.value === cur ? '<span class="s">Hiện tại</span>' : '')
            /* 每行右侧的「⋯」：模型列表用它打开"这个模型自己的参数"面板。
               要的：右上角三个点，点进去调上下文（1M/256K…）和高级参数。 */
            + (opts.rowExtra ? '<button type="button" class="pk-more" data-more="' + esc(it.value)
               + '" aria-label="Tham số của mô hình này">' + '\u22ef' + '</button>' : '')
            + '</li>').join('')
            || '<li><span class="t muted">Không tìm thấy</span></li>';
        };
        draw('');
        input.addEventListener('input', () => draw(input.value));
        list.addEventListener('click', (e) => {
          const more = e.target.closest('button[data-more]');
          if (more && opts.onExtra) {           // 点的是「⋯」：开参数面板，不算选中
            e.stopPropagation();
            opts.onExtra(more.dataset.more);
            return;
          }
          const li = e.target.closest('li[data-v]');
          if (!li) return;
          onPick(li.dataset.v);
          App.closeSheet();
          App.haptic && App.haptic();
        });
        const vw = q('#pk-view', panel);
        if (vw) vw.addEventListener('click', async () => {
          const box = q('#pk-prev', panel);
          if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
          box.classList.remove('hidden');
          box.innerHTML = '<span class="spinner"></span> Đang đọc…';
          try {
            const r = await API.presetResource(S.key, previewPath, cur, S.scope, S.slug);
            box.textContent = r.content || '(Mục này trống)';
          } catch (err) { box.textContent = 'Không đọc được: ' + err.message; }
        });
      },
    });
  }

  function openPick(f) {
    if (!f) return;
    const isRes = f.component === 'resource-preset';
    const items = (f.options || []).map((o) => ({ value: o.value, label: o.label, custom: !!o.custom }));
    /* 文风 / 范文这一类的列表顶部加一个「＋ 新建自定义」——
       。
       自己加的排在最前面，并且带一个「删」（只让自己删自己加的）。 */
    const opts = isRes ? {
      head: '<div style="padding:var(--sp-3) var(--sp-4) 0">'
        + '<button type="button" class="btn sm" id="pk-new">+ Tạo văn phong tùy chỉnh</button></div>',
      rowExtra: (it) => !!(it.custom && it.value),
      onExtra: async (v) => {
        if (!confirm('Xóa «' + String(v).replace(/\.md$/, '') + '»? Xóa rồi sẽ không chọn được nữa.')) return;
        try {
          const r = await API.styleDelete(v);
          App.toast('Đã xóa');
          try { S.data = null; } catch (e) {}
          const f2 = (prof().fields || []).find((x) => x.path === f.path);
          if (f2 && r && r.options) f2.options = r.options;
          App.closeSheet && App.closeSheet();
          openPick(f2 || f);
        } catch (err) { App.toast('Không xóa được: ' + (err.message || err)); }
      },
    } : undefined;
    openList(f.label, items, vals()[f.path], (v) => {
      vals()[f.path] = v;
      render();
      mark(true);
    }, f.path, opts);
    if (isRes) {
      setTimeout(() => {
        const btn = document.getElementById('pk-new');
        if (btn) btn.addEventListener('click', () => openStyleForm(f));
      }, 60);
    }
  }

  /* 新建自定义文风的表单：名字 + 内容，点确认就存下去并回到列表 */
  function openStyleForm(f) {
    App.sheet(
      '<div class="sheet-grip"></div>'
      + '<h3 class="sheet-h">Tạo văn phong tùy chỉnh</h3>'
      + '<p class="pfield-ds">Viết rõ bạn muốn gì, không muốn gì. Lưu xong sẽ hiện ở đầu danh sách, chọn hay xóa lúc nào cũng được.</p>'
      + '<div class="pfield"><div class="pfield-lb">Đặt tên</div><div class="pfield-ct">'
      + '<input class="pinput" id="cs-name" placeholder="VD: Bình dân đời thường / Lạnh lùng thẳng thắn" autocomplete="off"></div></div>'
      + '<div class="pfield"><div class="pfield-lb">Văn phong này cần gì <span class="hint">càng cụ thể càng dễ dùng</span></div>'
      + '<p class="pfield-ds">Có thể chép thẳng đoạn văn bạn thích, cũng có thể liệt kê từng yêu cầu (muốn gì / không muốn gì / kiểu câu / dùng từ).</p>'
      + '<div class="pfield-ct"><textarea class="pinput" id="cs-body" rows="8" spellcheck="false" '
      + 'placeholder="VD:\n- Dùng từ: đời thường, không chồng chất tính từ.\n- Kiểu câu: chủ yếu câu ngắn, ít dùng phép liệt kê song song.\n- Không viết câu tổng kết cuối đoạn. "></textarea></div></div>'
      + '<div class="pk-actions"><button type="button" class="btn" id="cs-cancel">Hủy</button>'
      + '<button type="button" class="btn btn-primary" id="cs-save">Xác nhận</button></div>',
      { onMount(panel) {
        const nm = panel.querySelector('#cs-name');
        const bd = panel.querySelector('#cs-body');
        const save = async () => {
          const name = (nm.value || '').trim();
          const body = (bd.value || '').trim();
          if (!name) { App.toast('Hãy đặt tên trước'); nm.focus(); return; }
          if (!body) { App.toast('Nội dung không được trống'); bd.focus(); return; }
          try {
            const r = await API.styleSave({ name, content: body });
            try { S.data = null; } catch (e) {}
            const f2 = (prof().fields || []).find((x) => x.path === f.path);
            if (f2 && r && r.options) f2.options = r.options;
            App.toast('Đã thêm vào danh sách');
            App.closeSheet && App.closeSheet();
            setTimeout(() => openPick(f2 || f), 120);
          } catch (e) { App.toast('Không lưu được: ' + (e.message || e)); }
        };
        panel.querySelector('#cs-cancel').addEventListener('click', () => { App.closeSheet && App.closeSheet(); openPick(f); });
        panel.querySelector('#cs-save').addEventListener('click', save);
        if (nm) setTimeout(() => nm.focus(), 100);
      } });
  }

  function openModelPick() {
    const list = (S.data.models || []).map((m) => ({ value: m.key,
      label: (m.name || m.label || m.key) + (m.provider ? '  ·  ' + m.provider : '') }));
    openList('Chọn mô hình', list, mdl().modelKey, (v) => {
      mdl().modelKey = v;
      render();
      mark(true);
    }, null, {
      rowExtra: () => true,
      onExtra: (k) => openModelParams(k),
    });
  }


  /* ── 单个模型的参数面板（模型列表每行右上角那个「⋯」）──────────────
     要的：「所有模型的右上角都应该加三个小点，点击之后可以调这个模型的具体参数，
     比如最高的上下文 1M、256K 都可以让他们自己调，以及一些代码的填写，
     因为一些 AI 是可以通过这种高级的修改来修改思考强度的。」
     存在的意义：同一个模型在不同渠道上，能吃多长、一次能出多少、是不是推理模型都不一样，
     平台猜不准，得让用户自己说了算。 */
  function openModelParams(key, sourceHint) {
    const it = ((S.data && S.data.models) || []).find((x) => x.key === key) || {};
    const parts = String(key).split('/');
    const group = it.group || parts[0] || '';
    /* sourceHint：别处（聊天的「选模型」）传进来的渠道名。
       两处的列表都调这一个面板，不写第二套实现。 */
    if (!it.provider && sourceHint) it.provider = sourceHint;
    const mid = parts.slice(1).join('/') || key;
    const PRE = [['1000000', '1M'], ['256000', '256K'], ['128000', '128K'],
                 ['64000', '64K'], ['32000', '32K'], ['16000', '16K']];
    const html =
      '<div class="sheet-grip"></div>'
      + '<h3 class="sheet-h">' + esc(it.name || mid) + '</h3>'
      + '<p class="pfield-ds" style="padding:0 var(--sp-4)">Tham số riêng của mô hình này. '
      + ' Sửa xong bấm «Lưu» — chỉ ảnh hưởng mô hình này, mô hình khác không đổi.</p>'
      + '<div class="pfield"><div class="pfield-lb">Giới hạn ngữ cảnh <span class="hint">một lần nhận tối đa bao nhiêu token</span></div>'
      + '<div class="pfield-ct"><input class="pinput" id="mp-ctx" inputmode="numeric" placeholder="VD 128000">'
      + '<div class="mp-chips">'
      + PRE.map(([v, lb]) => '<button type="button" class="mp-chip" data-ctx="' + v + '">' + lb + '</button>').join('')
      + '</div></div></div>'
      + '<div class="pfield"><div class="pfield-lb">Mỗi lần xuất tối đa <span class="hint">token, để trống = mặc định</span></div>'
      + '<div class="pfield-ct"><input class="pinput" id="mp-max" inputmode="numeric" placeholder="VD 8192"></div></div>'
      + '<div class="pfield"><div class="pfield-lb">Mô hình suy luận <span class="hint">một số kênh cần khai báo rõ</span></div>'
      + '<div class="pfield-ct"><div class="pradio" id="mp-rs">'
      + '<button type="button" data-v="0">Không phải</button>'
      + '<button type="button" data-v="1">Là mô hình suy luận</button></div></div></div>'
      + '<div class="pfield"><div class="pfield-lb">Tham số nâng cao <span class="hint">một đoạn JSON, gộp nguyên văn vào thân yêu cầu</span></div>'
      + '<p class="pfield-ds">Dành cho người hiểu: muốn chỉnh «cường độ suy nghĩ» thì ghi ở đây, ví dụ '
      + '<code>{"thinking": {"type": "enabled", "budget_tokens": 8192}}</code>. Để trống = không gửi gì.</p>'
      + '<div class="pfield-ct"><textarea class="pinput" id="mp-json" rows="5" spellcheck="false" '
      + 'autocomplete="off" placeholder=\'{"thinking": {"type": "enabled"}}\'></textarea></div></div>'
      + '<div class="mp-acts"><button type="button" class="btn" id="mp-cancel">Hủy</button>'
      + '<button type="button" class="btn btn-primary" id="mp-save">Lưu</button></div>';

    App.sheet(html, {
      onMount(panel) {
        const ctx = q('#mp-ctx', panel);
        const mx = q('#mp-max', panel);
        const js = q('#mp-json', panel);
        const rs = q('#mp-rs', panel);
        let reasoning = null;
        const setRs = (v) => {
          reasoning = v;
          [...rs.querySelectorAll('button')].forEach((b) => b.classList.toggle('on', b.dataset.v === String(v)));
        };
        panel.querySelectorAll('[data-ctx]').forEach((b) => b.addEventListener('click', () => {
          if (ctx) ctx.value = b.dataset.ctx;
        }));
        rs.addEventListener('click', (e) => {
          const b = e.target.closest('button[data-v]');
          if (b) setRs(b.dataset.v === '1');
        });
        // 拉这个模型现在的值
        API.models().then((d) => {
          const all = (d && d.models) || [];
          const hit = all.find((m) => m.id === mid && (!group || m.source === it.provider || m.source === it.group))
                   || all.find((m) => m.id === mid);
          if (hit) {
            if (ctx && !ctx.value) ctx.value = hit.contextWindowTokens || '';
            if (mx && !mx.value) mx.value = hit.maxTokens || '';
            setRs(!!hit.reasoning);
          } else { setRs(reasoning === null ? false : reasoning); }
        }).catch(() => setRs(false));
        // 高级参数：从渠道的 options 里把按模型存的那份取回来
        API.nb('api/config/snapshot').then((snap) => {
          const provs = (((snap || {}).effective || {}).models || {}).providers || {};
          for (const k of Object.keys(provs)) {
            const pr = provs[k];
            if (it.provider && pr.name !== it.provider) continue;
            const bym = (pr.options || {}).modelParams || {};
            if (bym[mid] && js) { js.value = JSON.stringify(bym[mid], null, 2); break; }
          }
        }).catch(() => {});
        q('#mp-cancel', panel).addEventListener('click', () => App.closeSheet());
        q('#mp-save', panel).addEventListener('click', async () => {
          const btn = q('#mp-save', panel);
          if (btn) { btn.disabled = true; btn.textContent = 'Đang lưu…'; }
          try {
            await API.modelSave({ source: it.provider || group, id: mid,
              contextWindowTokens: ctx ? ctx.value.trim() : '',
              maxTokens: mx ? mx.value.trim() : '',
              reasoning: reasoning === null ? undefined : reasoning,
              optionsJson: js ? js.value.trim() : '' });
            App.toast('Đã lưu');
            App.haptic && App.haptic();
            App.closeSheet();
            /* 让预设页下次重新拉一遍（模型库是缓存过的） */
            S.data = null;
          } catch (e) {
            if (btn) { btn.disabled = false; btn.textContent = 'Lưu'; }
            App.toast('Lưu thất bại: ' + (e.message || e));
          }
        });
      },
    });
  }

  function openEffortPick() {
    openList('Cường độ suy nghĩ', EFFORT.map(([v, lb]) => ({ value: v, label: lb })),
      mdl().reasoningEffort || '', (v) => {
        mdl().reasoningEffort = v || null;
        render();
        mark(true);
      });
  }

  /* ---------------- 保存 ---------------- */

  async function save() {
    if (S.busy || !S.dirty) return;
    S.busy = true;
    const bar = q('#preset-save');
    const btn = q('#preset-save .btn');
    const msg = q('#preset-save .msg');
    if (btn) { btn.disabled = true; btn.textContent = 'Đang lưu…'; }
    try {
      await API.presetSave(S.key, { ...vals() }, { ...mdl() }, S.scope, S.slug);
      if (msg) msg.textContent = 'Đã lưu';
      mark(false);
      S.data = null; S.draft = null;   // 下次进来重新拉，确保和平台一致
      App.toast('Đã lưu preset');
      App.haptic && App.haptic();
    } catch (e) {
      if (msg) msg.textContent = 'Lưu thất bại';
      App.toast('Lưu thất bại: ' + e.message);
    } finally {
      S.busy = false;
      if (btn) { btn.disabled = !S.dirty; btn.textContent = 'Lưu'; }
    }
  }

  /* 离开这一页时如果还有没存的，问一句 */
  function guardLeave() {
    if (!S.dirty) { App.show('shelf'); return; }
    App.confirm('Preset chưa lưu, rời đi bây giờ sẽ mất.', () => { mark(false); App.show('shelf'); }, 'Bỏ và rời đi');
  }

  /* ---------------- 作用域（这本书 / 所有书默认） ---------------- */

  function bookTitle() {
    if (window.BookCtx && BookCtx.slug() === S.slug && BookCtx.title()) return BookCtx.title();
    const b = (window.App && App.state && App.state.book) || null;
    if (b && b.slug === S.slug && b.title && b.title !== b.slug) return b.title;
    const list = (window.Shelf && Shelf.projects) || [];
    const p = list.find((x) => (x.slug || x.projectRoot) === S.slug);
    return (p && (p.title || p.name)) || (window.BookCtx && BookCtx.title()) || S.slug;
  }

  /* 面板顶上那条切书：切过去 = 从"所有书默认"换成"这本自带的"，并立刻重读 */
  function switchBookTo() {
    const go = () => {
      const slug = (window.BookCtx && BookCtx.slug()) || '';
      mark(false);
      S.slug = slug; S.scope = 'project'; S.data = null; S.draft = null; S.key = null;
      window.Preset.open('project', slug);
    };
    if (S.dirty) App.confirm('Bên này chưa lưu, chuyển sang sẽ mất.', go, 'Bỏ và chuyển');
    else go();
  }

  function renderScope() {
    const el = q('#preset-scope');
    if (!el) return;
    /* 以前没书时这里直接隐藏 → 用户看不到任何切书入口（监督人核实过 preset.js:311）。
       现在「当前书」是全局的，总有值；真没有也留一个提示，不再静默隐藏。 */
    if (!S.slug) {
      el.hidden = false;
      el.innerHTML = '<p class="pseg-hint">Chưa có tác phẩm · hãy tạo một cuốn trên giá sách trước</p>';
      return;
    }
    el.hidden = false;
    const on = S.scope === 'project';
    el.innerHTML = '<div class="pseg">'
      + '<button type="button" data-scope="project" class="' + (on ? 'on' : '') + '">Cuốn này</button>'
      + '<button type="button" data-scope="global" class="' + (on ? '' : 'on') + '">Mặc định mọi sách</button>'
      + '</div><p class="pseg-hint">'
      + (on
        ? 'Chỉ áp dụng cho «' + esc(bookTitle()) + '» ' + (S.hasOwn
            ? ' · nó đã có bộ thiết lập riêng <button type="button" class="plink" data-reset>Hủy thiết lập riêng của nó</button>'
            : ' · chưa có bộ riêng, lưu xong sẽ có')
        : 'Mọi sách<b>chưa đặt riêng</b> đều theo bộ này, không ảnh hưởng những cuốn đã đặt riêng')
      + '</p>';
  }

  /* 取消这本书的独立设定，让它重新跟着「所有书默认」走 */
  function resetProject() {
    App.confirm('«' + bookTitle() + '» sẽ quay lại theo «Mặc định mọi sách», các thiết lập đã sửa riêng cho cuốn này sẽ mất.',
      async () => {
        try {
          await API.presetReset('project', S.slug);
          App.toast('Đã khôi phục về mặc định mọi sách');
          S.data = null; S.draft = null; S.dirty = false;
          window.Preset.open('project', S.slug);
        } catch (e) { App.toast('Khôi phục thất bại: ' + (e.message || '')); }
      }, 'Khôi phục mặc định');
  }

  function switchScope(next) {
    if (next === S.scope) return;
    if (S.dirty) {
      App.confirm('Bên này chưa lưu, chuyển sang sẽ mất.', () => {
        mark(false); S.data = null; S.draft = null; S.scope = next;
        window.Preset.open(S.scope, S.slug);
      }, 'Bỏ và chuyển');
      return;
    }
    S.data = null; S.draft = null; S.scope = next;
    window.Preset.open(S.scope, S.slug);
  }

  /* ---------------- 对外 ---------------- */

  window.Preset = {
    /* 给聊天的「选模型」用：那边每一行也要能打开这个模型的参数（同一个面板） */
    modelParams: (key, source) => openModelParams(key, source),
    /* App.show() 切到这一页时会调 onShow */
    onShow() { return window.Preset.open(); },
    async open(scope, slug) {
      const host = q('#preset-body');
      if (!host) return;
      /* 顶上那条切书（三个面板之一）。没书时先兜一本，让入口始终在。 */
      if (window.BookCtx) {
        if (!BookCtx.has()) { try { await BookCtx.ensure(); } catch (e) {} }
        BookCtx.mount('preset-book', () => switchBookTo());
      }
      // 默认就是全站唯一的「当前书」
      const wantSlug = (slug === undefined)
        ? ((window.BookCtx && BookCtx.slug()) || (App.state && App.state.slug) || '')
        : (slug || '');
      const wantScope = scope || (wantSlug ? 'project' : 'global');
      if (wantSlug !== S.slug || wantScope !== S.scope) {
        S.slug = wantSlug; S.scope = wantScope; S.data = null; S.draft = null;
      }
      renderScope();
      if (S.data && S.draft && S.key) { render(); return; }   // 没改过就直接用缓存的
      loadInto(host);
    },
  };

  /* 真拉一次预设并画出来。**单独抽出来是为了「重试」能重跑同一段** ——
     出错态那个按钮按下去必须真的再来一次，不是摆着好看。
     三态跟全站一套（统一）：UI.loadingIn / UI.failedIn / UI.emptyIn。
     以前这里是 `.preset-loading` 一行字 + 出错时一句裸文案「读不到预设：…」——
     用户分不清"没东西"和"坏了"，也没有重试；而且**形状不对时会走进抛异常那条路**，
     屏上是错的、判据却当成空态报了绿（自己抓到的假绿）。 */
  function loadInto(host) {
    UI.loadingIn(host, 'Đang đọc preset…');
    return API.presets(S.scope, S.slug).then((d) => {
      const list = Array.isArray(d && d.profiles) ? d.profiles : [];
      S.data = d;
      S.hasOwn = !!(d && d.hasOwn);
      renderScope();
      if (!list.length) {
        /* 真·空态：一个身份都没有。说清"这是什么、怎么才会出现"，别给白纸。 */
        S.key = null; S.draft = {};
        return UI.emptyIn(host, S.slug ? 'Cuốn này chưa có preset' : 'Chưa có preset toàn cục',
          'Preset là «quy tắc viết» đưa cho AI (nhân vật, giọng kể, từ cấm). Điền xong lưu lại, bản thảo viết mới sau đó mới dùng tới.',
          'sliders');
      }
      if (!S.key || !list.some((p) => p.profileKey === S.key)) S.key = (list[0] || {}).profileKey;
      S.draft = {};
      list.forEach((p) => {
        S.draft[p.profileKey] = {
          values: JSON.parse(JSON.stringify(p.values || {})),
          model: JSON.parse(JSON.stringify(p.model || {})),
        };
      });
      render();
      return undefined;
    }).catch((e) => {
      /* 出错态：说人话 + 「重试」（重跑本次这一段）。连不上和"读不出来"分开说。 */
      UI.failedIn(host, 'Preset', e, () => loadInto(host));
      return undefined;
    });
  }

  /* 事件绑定（只绑一次） */
  let bound = false;
  function bind() {
    if (bound) return;
    bound = true;
    const body = q('#preset-body');
    if (body) {
      body.addEventListener('input', onInput);
      body.addEventListener('change', onInput);
      body.addEventListener('click', onClick);
    }
    const sc = q('#preset-scope');
    if (sc) sc.addEventListener('click', (e) => {
      if (e.target.closest('[data-reset]')) {
        App.haptic && App.haptic();
        resetProject();
        return;
      }
      const b = e.target.closest('[data-scope]');
      if (!b) return;
      App.haptic && App.haptic();
      switchScope(b.dataset.scope);
    });
    const sv = q('#preset-save [data-save]');
    if (sv) sv.addEventListener('click', save);
    const st2 = q('#preset-save-top');
    if (st2) st2.addEventListener('click', save);
    const bk = q('#preset-back');
    if (bk) bk.addEventListener('click', guardLeave);
  }
  document.addEventListener('DOMContentLoaded', bind);
  if (document.readyState !== 'loading') bind();
})();
