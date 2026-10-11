/* ============================================================
   authoring.js — 长在工具面板上的那几个：

     ① 故事线   —— **按用户拍板整个换了内容**：
                    这个名字一个字都不改，但点开是**大纲**（这本书要往哪走、什么调子、
                    防忘 / 防防跑偏 / 防 OOC；用户改的以用户为准，AI 不会覆盖）。
                    大纲那一块本身在 js/outline.js —— **一份实现、两个入口**
                    （「故事线」工具 + 「剧情」工具的「剧情线」页签），不许两套并存。
                    原来那份"一章一句话"的章节速览**没有丢**，收在同一页的**折叠区**里
                    （它就是防忘那一半：一眼看清写到哪了，点一行去写那一章）。
     ⑤ 章节顺序 —— 手机上给长篇插一章 / 调顺序，**细纲/出场角色/关键事件跟着走**

   另外三个长在别的界面上，就写在那个界面自己的文件里，不搬到这里来当"第二套实现"：
     · 常用指令（一键把话说完）→ chat.js，因为它长在对话框上
     · 小批注（给自己留的待办）→ reader.js，因为它长在正文选中上
     · 点一下看设定         → reader.js，因为它长在正文的文字上
   ============================================================ */
(function () {
  const U = () => window.Tools && window.Tools.ui;
  const qs = (o) => Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const get = (p, q) => window.API.nb(p + (q ? '?' + qs(q) : ''));
  const post = (p, b) => window.API.nb(p, { method: 'POST', body: b || {} });
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ico = (n) => '<span class="tr-ico">' + window.iconHtml(n) + '</span>';
  const num = (n) => Number(n || 0).toLocaleString('en-US');
  const hap = () => { try { App.haptic(6); } catch (e) {} };
  const toast = (m) => { try { App.toast(m); } catch (e) {} };

  /* ── 两个面板共用的一份"章节清单"（同一份实现，不许各写一套） ── */
  async function chapters(slug) {
    return await get('/api/storyline', { slug });
  }

  function head(d) {
    const bits = [d.count + ' chương', 'Tổng ' + num(d.words) + ' chữ'];
    if (d.emptyCount) bits.push('<b>' + d.emptyCount + ' chương vẫn còn trống</b>');
    return '<div class="t-hint">' + bits.join(' · ') + '</div>';
  }

  /* ══════════════════ ① 故事线 = 大纲（换的内容） ══════════════════
     页面从上到下就两块：
       · 大纲（js/outline.js，主区）—— 加/改/删，每行写着"谁定的"
       · 章节速览（折叠，默认收起）—— 一章一句话，防忘用；点一行去写那一章
     为什么把速览收进折叠区而不是删掉：此处说明是"把故事线的用处改成大纲"，
     不是"把章节速览这个能力从产品里拿掉"。收起来 = 一打开看到的还是大纲。 */
  /* 一行一章（章节速览的一行）：章号 + 章名 + 一句话 + 「自动 / 我写的」 */
  function rowHtml(it, i) {
    return '<div class="al-row" data-path="' + esc(it.path) + '">' +
      '<div class="al-no">' + (it.no || i + 1) + '</div>' +
      '<div class="al-main">' +
        '<div class="al-title">' + esc(it.title) + '</div>' +
        '<div class="al-sum' + (it.mine ? ' mine' : '') + '" data-edit="' + esc(it.path) + '">' +
          (it.summary ? esc(it.summary) : '<i>Chương này chưa có nội dung</i>') +
          (it.mine ? '<b class="al-tag">Tôi viết</b>' : '<b class="al-tag auto">Tự động</b>') +
        '</div>' +
      '</div>' +
      '<div class="al-side"><span>' + (it.empty ? 'Trống' : num(it.words) + ' chữ') + '</span>' +
        '<span class="al-go">' + window.iconHtml('chevron') + '</span></div>' +
      '</div>';
  }

  function capsHtml(items) {
    return items.length
      ? '<div class="al-list">' + items.map(rowHtml).join('') + '</div>'
      : '<div class="t-empty">Cuốn này chưa có chương nào.</div>';
  }

  /* 章节速览：读 /api/storyline（后端一个字没改），改一句话写回同一路接口 */
  async function capsHome(host, slug) {
    U().loading(host, 'Đang đọc chương…');
    let d;
    try { d = await chapters(slug); }
    catch (e) { U().empty(host, 'Không đọc được chương: ' + e.message); return; }
    const items = (d && d.items) || [];
    if (!items.length) { U().empty(host, 'Cuốn này chưa có chương nào', 'book'); return; }
    host.innerHTML = head(d) + capsHtml(items);
    host.querySelectorAll('.al-row').forEach((row) => {
      row.onclick = async (e) => {
        const edit = e.target.closest('[data-edit]');
        if (edit) {
          e.stopPropagation();
          hap();
          const cur = items.find((x) => x.path === edit.dataset.edit) || {};
          const v = await U().ask('Chương này xảy ra chuyện gì (một câu)', cur.summary || '', {
            placeholder: 'VD: Nhân vật chính nhặt được một mảnh đao gãy trong đêm tuyết, bị người tuần đêm phát hiện', host });
          if (v === null || v === undefined) return;
          try {
            await post('/api/storyline', { slug, path: cur.path, summary: String(v).trim() });
            toast('Đã lưu');
            capsHome(host, slug);            // 重画，让"自动/我写的"标记跟着变
          } catch (err) { toast('Không lưu được: ' + err.message); }
          return;
        }
        hap();
        try { await window.Shelf.openBook(slug, { slug, path: row.dataset.path }); }
        catch (err) { toast('Không mở được: ' + err.message); }
      };
    });
  }

  async function storyHome(host, slug) {
    if (!window.Outline) { U().empty(host, 'Mô-đun dàn ý chưa tải (trang thiếu js/outline.js)'); return; }
    host.innerHTML =
      '<div class="ol-mount" data-ol></div>' +
      '<details class="acc" data-caps-acc>' +
        '<summary><span class="acc-t">Xem nhanh chương · mỗi chương một câu</span>' +
          '<span class="acc-n">Viết tới đâu rồi, nhìn là thấy; bấm một dòng để viết chương đó</span>' +
          '<span class="acc-x">' + window.iconHtml('chevron') + '</span></summary>' +
        '<div class="acc-body" data-caps></div>' +
      '</details>';
    const box = host.querySelector('[data-caps]');
    /* 折叠区**点开才读**（省一次请求，也不会跟大纲抢第一次渲染的时间） */
    const acc = host.querySelector('[data-caps-acc]');
    let done = false;
    acc.addEventListener('toggle', () => {
      if (!acc.open || done) return;
      done = true;
      /* 读失败要说话 —— 以前这类 async 调用没人接住，界面就永远停在"读章节…"
         （自己踩的：rowHtml 没了 → ReferenceError → 一直转圈、一声不吭） */
      capsHome(box, slug).catch((e) => { toast('Không đọc được bản xem nhanh: ' + ((e && e.message) || e)); });
    });
    return window.Outline.mount(host.querySelector('[data-ol]'), slug);
  }

  /* ══════════════════ ⑤ 章节顺序 ══════════════════ */
  async function orderHome(host, slug) {
    U().loading(host, 'Đang đọc chương…');
    let d;
    try { d = await chapters(slug); }
    catch (e) { U().empty(host, 'Không đọc được chương: ' + e.message); return; }
    const items = (d && d.items) || [];
    if (!items.length) { U().empty(host, 'Cuốn này chưa có chương nào', 'book'); return; }
    host.innerHTML = head(d) +
      '<div class="t-hint">Lên / Xuống sẽ đánh lại số chương; chèn chương sẽ chèn sau chương này. ' +
      ' Dàn ý chi tiết, nhân vật xuất hiện, sự kiện chính của chương sẽ đi theo, không mất chữ nào.</div>' +
      '<div class="al-list">' + items.map((it, i) =>
        '<div class="al-row ord" data-path="' + esc(it.path) + '">' +
          '<div class="al-no">' + (it.no || i + 1) + '</div>' +
          '<div class="al-main"><div class="al-title">' + esc(it.title) + '</div>' +
            '<div class="al-meta">' + (it.empty ? 'Chưa viết' : num(it.words) + ' chữ') + '</div></div>' +
          '<div class="al-btns">' +
            '<button class="al-btn" data-mv="up" aria-label="Lên trên">' + window.iconHtml('chevron') + '</button>' +
            '<button class="al-btn dn" data-mv="down" aria-label="Xuống dưới">' + window.iconHtml('chevron') + '</button>' +
            '<button class="al-btn ins" data-ins="1" aria-label="Chèn một chương sau chương này">' +
              window.iconHtml('plus') + '</button>' +
          '</div></div>').join('') + '</div>';
    host.querySelectorAll('.al-row').forEach((row) => {
      row.onclick = async (e) => {
        const mv = e.target.closest('[data-mv]');
        const ins = e.target.closest('[data-ins]');
        const path = row.dataset.path;
        const it = items.find((x) => x.path === path) || {};
        if (mv) {
          hap();
          e.stopPropagation();
          try {
            const r = await post('/api/chapter/move', { slug, path, dir: mv.dataset.mv });
            if (r && r.moved === false) toast('Đã ở đầu/cuối rồi');
            else toast('Đã di chuyển');
            orderHome(host, slug);
          } catch (err) { toast('Không di chuyển được: ' + err.message); }
          return;
        }
        if (ins) {
          hap();
          e.stopPropagation();
          const name = await U().ask('Chèn sau «' + it.title + '», chương mới tên là gì', '',
            { placeholder: 'VD: Sau đêm tuyết', host });
          if (!name) return;
          try {
            const r = await post('/api/chapter/insert', { slug, after: path, title: String((window.VI && VI.chapterName ? VI.chapterName : function (x) { return x; })(String(name).trim())).replace(/^第\s*0*\d+\s*章\s*[-—·_]?\s*/, '').trim() || 'Chưa đặt tên' });
            toast(r && r.inserted ? 'Đã chèn' : 'Đã chèn');
            orderHome(host, slug);
          } catch (err) { toast('Không chèn được: ' + err.message); }
          return;
        }
        /* 这一屏只干"挪位置"这件事：点空白处不乱跳（想写正文请走「故事线」或书架） */
      };
    });
  }

  if (window.Tools && window.Tools.add) {
    window.Tools.add([
      { id: 'story', name: 'Tuyến truyện', sub: 'Dàn ý · cuốn sách đi về đâu', icon: 'list', sec: 'Viết',
        run: (host) => U().pushBook('Tuyến truyện', storyHome) },
      { id: 'order', name: 'Thứ tự chương', sub: 'Chèn chương · đổi thứ tự', icon: 'refresh', sec: 'Bản thảo',
        run: (host) => U().pushBook('Thứ tự chương', orderHome) },
    ]);
  }
})();
