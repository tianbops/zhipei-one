/* ===== 智配One 自建选择/日期弹层（zp-picker）=====
   动机：Android WebView 的原生 <select> 下拉与日期对话框跟随「系统」字号与
   系统深浅，不认 App 内「全局文字大小」滑杆与网页主题（详见 css/zp-picker.css）。
   做法：原生控件保留在 DOM 作数据源（.value/.options/change 语义不变），
   视觉替换为触发按钮 + 页内底部弹层；选中后写回 value 并派发 change，
   对既有业务 JS 零侵入。弹层为普通 HTML，自动继承主题令牌与字号缩放。
   加载即自动升级页面内全部 select 与 input[type=date]（幂等）。 */
(function () {
  "use strict";

  /* ================= 纯函数核心（Node 可单测，无 DOM 依赖） ================= */
  var WEEK = ["日", "一", "二", "三", "四", "五", "六"];
  function pad2(n) { return String(n).padStart(2, "0"); }
  function clampScale(n) { n = Number(n); return Number.isFinite(n) ? Math.max(0.85, Math.min(1.3, n)) : 1; }
  function toISO(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function parseISO(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s == null ? "" : s).trim());
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    var dt = new Date(y, mo - 1, d);
    if (isNaN(dt.getTime())) return null;
    /* 溢出防护：new Date(2026,12,1) 不抛错，会静默滚成 2027-01-01；
       逐一比对年月日组件，把 2/30、13 月这类脏值挡在门外。 */
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return dt;
  }
  /* 月矩阵：6 行 × 7 列，月初前以 null 补位，rows[w][i] 为 Date 或 null。 */
  function monthMatrix(year, month) {
    var first = new Date(year, month, 1);
    var lead = first.getDay();
    var rows = [];
    for (var w = 0; w < 6; w++) {
      var row = [];
      for (var i = 0; i < 7; i++) {
        var idx = w * 7 + i;
        row.push(idx < lead ? null : new Date(year, month, 1 + (idx - lead)));
      }
      rows.push(row);
    }
    return rows;
  }
  function fmtCN(d) { return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日"; }
  /* select 当前展示文本：selectedIndex>=0 取选中项（无 text 返回空串，与原生
     selectedOptions.textContent 一致）；无选中（-1）退回首项——与原生 select
     未选中时显示首项的表现一致。 */
  function selectLabel(selectLike) {
    var opts = selectLike.options || [];
    var sel = selectLike.selectedIndex;
    var target = sel >= 0 && opts[sel] ? opts[sel] : opts[0];
    if (!target || target.text == null) return "";
    return String(target.text);
  }
  function dateLabel(iso) {
    var d = parseISO(iso);
    return d ? fmtCN(d) : "";
  }
  var zpPickerCore = {
    WEEK: WEEK, pad2: pad2, clampScale: clampScale, toISO: toISO, parseISO: parseISO,
    monthMatrix: monthMatrix, fmtCN: fmtCN, selectLabel: selectLabel, dateLabel: dateLabel,
  };
  globalThis.zpPickerCore = zpPickerCore;

  /* ================= DOM 装配（浏览器外加载时跳过） ================= */
  if (typeof document === "undefined") return;

  var OPEN_ATTR = "data-zp-pk-open";
  var current = null; /* 当前打开的弹层 { bg, restoreFocus } */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function closeSheet() {
    if (!current) return;
    var bg = current.bg, restore = current.restoreFocus;
    current = null;
    document.removeEventListener("keydown", onKey, true);
    document.body.style.overflow = "";
    bg.remove();
    if (restore && restore.focus) try { restore.focus(); } catch (e) {}
  }
  function onKey(e) {
    if (!current) return;
    if (e.key === "Escape") { e.preventDefault(); closeSheet(); return; }
    if (e.key !== "Tab") return;
    var focusables = current.sheet.querySelectorAll("button:not([disabled])");
    if (!focusables.length) return;
    var first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  /* 打开底部弹层：headEl 为调用方构建好的完整头部；返回 sheet 元素。
     关闭按钮由本函数追加到 sheet 末尾（绝对定位于右上角，不占用 head 布局）。 */
  function openSheet(headEl, restoreFocus) {
    closeSheet();
    var bg = el("div", "zp-pk-bg");
    bg.addEventListener("click", function (e) { if (e.target === bg) closeSheet(); });
    var sheet = el("div", "zp-pk-sheet");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    var closeBtn = el("button", "zp-pk-close", "✕");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "关闭");
    closeBtn.addEventListener("click", closeSheet);
    sheet.appendChild(headEl);
    sheet.appendChild(closeBtn);
    bg.appendChild(sheet);
    document.body.appendChild(bg);
    document.body.style.overflow = "hidden";
    current = { bg: bg, sheet: sheet, restoreFocus: restoreFocus };
    document.addEventListener("keydown", onKey, true);
    return sheet;
  }

  /* ---------------- select 升级 ----------------
     触发器直接插入原生 select 之前顶替其布局位置；原生 select 加 .zp-pk-src
     绝对定位移出视口，保留 value/options/change 语义作数据源。 */
  function upgradeSelect(select) {
    if (!select || select.multiple || select.dataset.zpPk) return;
    select.dataset.zpPk = "1";
    var trigger = el("button", "zp-pk-trigger");
    trigger.type = "button";
    /* 复制原生控件的行内样式（flex 占位/高度/边框等），保证触发器顶替原位置 */
    if (select.getAttribute("style")) trigger.setAttribute("style", select.getAttribute("style"));
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-label", select.getAttribute("aria-label") || "请选择");
    var valueEl = el("span", "zp-pk-value");
    var caret = el("span", "zp-pk-caret", "▾");
    caret.setAttribute("aria-hidden", "true");
    trigger.appendChild(valueEl);
    trigger.appendChild(caret);
    select.parentNode.insertBefore(trigger, select);
    select.removeAttribute("style");
    select.classList.add("zp-pk-src");
    select.setAttribute("aria-hidden", "true");
    select.tabIndex = -1;

    function syncLabel() {
      var text = selectLabel(select);
      valueEl.textContent = text;
      valueEl.classList.toggle("zp-pk-ph", !text);
    }
    syncLabel();
    select.addEventListener("change", syncLabel);
    /* 选项被动态替换（如线路列表加载完）时同步标签 */
    if (typeof MutationObserver === "function") {
      new MutationObserver(syncLabel).observe(select, { childList: true, subtree: true });
    }

    trigger.addEventListener("click", function () {
      if (current && current.restoreFocus === trigger) { closeSheet(); return; }
      var head = el("div", "zp-pk-head");
      head.appendChild(el("span", "zp-pk-title", select.getAttribute("aria-label") || "请选择"));
      var sheet = openSheet(head, trigger);
      var list = el("div", "zp-pk-list");
      list.setAttribute("role", "listbox");
      list.setAttribute("aria-label", select.getAttribute("aria-label") || "请选择");
      var opts = Array.prototype.slice.call(select.options);
      if (!opts.length) {
        list.appendChild(el("div", "zp-pk-row", "暂无选项"));
      }
      opts.forEach(function (opt) {
        var row = el("button", "zp-pk-row");
        row.type = "button";
        row.setAttribute("role", "option");
        var selected = opt.selected || (!select.value && opts[0] === opt);
        row.setAttribute("aria-selected", selected ? "true" : "false");
        row.appendChild(el("span", "zp-pk-radio"));
        row.appendChild(el("span", "zp-pk-row-label", opt.text || opt.value || ""));
        row.addEventListener("click", function () {
          select.value = opt.value;
          select.dispatchEvent(new Event("change", { bubbles: true }));
          syncLabel();
          closeSheet();
        });
        list.appendChild(row);
      });
      sheet.appendChild(list);
      var first = list.querySelector('.zp-pk-row[aria-selected="true"]') || list.querySelector(".zp-pk-row");
      if (first) first.focus();
    });
  }

  /* ---------------- input[type=date] 升级 ---------------- */
  function upgradeDate(input) {
    if (!input || input.dataset.zpPk) return;
    input.dataset.zpPk = "1";
    var trigger = el("button", "zp-pk-trigger zp-pk-date-trigger");
    trigger.type = "button";
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.setAttribute("aria-label", input.getAttribute("aria-label") || "选择日期");
    var valueEl = el("span", "zp-pk-value");
    var caret = el("span", "zp-pk-caret", "▾");
    caret.setAttribute("aria-hidden", "true");
    trigger.appendChild(valueEl);
    trigger.appendChild(caret);
    input.parentNode.insertBefore(trigger, input);
    input.classList.add("zp-pk-src");
    input.setAttribute("aria-hidden", "true");
    input.tabIndex = -1;

    function syncLabel() {
      var text = dateLabel(input.value);
      valueEl.textContent = text || "选择日期";
      valueEl.classList.toggle("zp-pk-ph", !text);
    }
    syncLabel();
    input.addEventListener("change", syncLabel);

    trigger.addEventListener("click", function () {
      if (current && current.restoreFocus === trigger) { closeSheet(); return; }
      var selected = parseISO(input.value) || new Date();
      var viewY = selected.getFullYear(), viewM = selected.getMonth();
      var title = el("button", "zp-pk-title", "");
      title.type = "button";
      title.setAttribute("aria-label", "切换年月");
      var prev = el("button", "zp-pk-nav", "‹");
      prev.type = "button"; prev.setAttribute("aria-label", "上个月");
      var next = el("button", "zp-pk-nav", "›");
      next.type = "button"; next.setAttribute("aria-label", "下个月");
      var head = el("div", "zp-pk-head");
      head.appendChild(prev); head.appendChild(title); head.appendChild(next);
      var sheet = openSheet(head, trigger);
      var body = el("div", "zp-pk-body");
      sheet.appendChild(body);

      function pick(d) {
        input.value = toISO(d);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        syncLabel();
        closeSheet();
      }
      function renderGrid() {
        body.innerHTML = "";
        title.textContent = viewY + "年" + (viewM + 1) + "月";
        var week = el("div", "zp-pk-week");
        WEEK.forEach(function (w) { week.appendChild(el("span", null, w)); });
        body.appendChild(week);
        var grid = el("div", "zp-pk-grid");
        var rows = monthMatrix(viewY, viewM);
        var todayISO = toISO(new Date());
        rows.forEach(function (row) {
          row.forEach(function (d) {
            if (!d) { grid.appendChild(el("span", "zp-pk-cell")); return; }
            var iso = toISO(d);
            var cell = el("button", "zp-pk-cell", String(d.getDate()));
            cell.type = "button";
            if (d.getMonth() !== viewM) cell.setAttribute("data-out", "1");
            if (iso === todayISO) cell.setAttribute("data-today", "1");
            if (iso === input.value) cell.setAttribute("aria-selected", "true");
            cell.addEventListener("click", function () { pick(d); });
            grid.appendChild(cell);
          });
        });
        body.appendChild(grid);
        var foot = el("div", "zp-pk-datefoot");
        var todayBtn = el("button", "zp-pk-today", "今天");
        todayBtn.type = "button";
        todayBtn.addEventListener("click", function () { pick(new Date()); });
        foot.appendChild(todayBtn);
        body.appendChild(foot);
      }
      function renderYM() {
        body.innerHTML = "";
        title.textContent = "选择年月";
        var panel = el("div", "zp-pk-ymp");
        var baseYear = viewY - 6;
        for (var y = baseYear; y < baseYear + 13; y++) {
          (function (yy) {
            var b = el("button", "zp-pk-cell", String(yy) + "年");
            b.type = "button";
            if (yy === viewY) b.setAttribute("aria-selected", "true");
            b.addEventListener("click", function () { viewY = yy; renderGrid(); });
            panel.appendChild(b);
          })(y);
        }
        for (var m = 0; m < 12; m++) {
          (function (mm) {
            var b = el("button", "zp-pk-cell", (mm + 1) + "月");
            b.type = "button";
            if (mm === viewM) b.setAttribute("aria-selected", "true");
            b.addEventListener("click", function () { viewM = mm; renderGrid(); });
            panel.appendChild(b);
          })(m);
        }
        body.appendChild(panel);
      }
      prev.addEventListener("click", function () { viewM--; if (viewM < 0) { viewM = 11; viewY--; } renderGrid(); });
      next.addEventListener("click", function () { viewM++; if (viewM > 11) { viewM = 0; viewY++; } renderGrid(); });
      title.addEventListener("click", function () {
        if (body.firstChild && body.firstChild.className === "zp-pk-ymp") renderGrid(); else renderYM();
      });
      renderGrid();
      var sel = body.querySelector('.zp-pk-cell[aria-selected="true"]');
      if (sel) sel.focus();
    });
  }

  function upgradeAll(root) {
    root = root || document;
    root.querySelectorAll && root.querySelectorAll("select").forEach(upgradeSelect);
    root.querySelectorAll && root.querySelectorAll('input[type="date"]').forEach(upgradeDate);
  }
  globalThis.zpPicker = { upgradeSelect: upgradeSelect, upgradeDate: upgradeDate, upgradeAll: upgradeAll };

  /* 页面脚本（含动态填充选项的业务 JS）同步执行完毕后再升级 */
  function boot() { upgradeAll(document); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
