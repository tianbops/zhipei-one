/* ui/mapnav.js —— 门店名 → 三家地图导航目标 + 点门店名弹选择菜单
   ------------------------------------------------------------
   门店数据里 name 必有，navigation（「导航地址」）与坐标（lat/lng，GCJ-02）可有可无。
   这里做两件事：
   1) 把一个门店对象解析成「三家各自的 URL」，交给渲染层拼 <a href> 与 data 载荷；
   2) 捕获门店名链接的点击，弹底部菜单让司机选高德 / 百度 / 腾讯，再跳对应软件。

   为什么是「每次点门店名弹菜单」而不是设置里选默认：
   浏览器无法枚举已安装的 App，也调不出「用哪个地图打开」的系统选择器。
   唯一可行的是让用户明确选一次；配送场景里每次选比进设置改默认更直观。

   为什么只送到「看位置」页、把是否用 App 留给司机自己点（成熟 H5 范式）：
   成熟 App 处理「点地址去导航」是「选择 → 打开 → 兜底」，下载永远是用户主动
   点击的动作，不是页面自动行为。我们是 H5，浏览器无法枚举已安装 App，因此
   把「是否用 App」也做成显式选择：只送到地图网页的「位置页」，页面里自带
   「打开高德APP」按钮，司机想用 App 导航就自己点，不想就只看位置。
   2026-11 真机回归（决定性差异是「落地页类型」，不是 callnative）：
     · uri.amap.com/navigation 驾车路线页一进去就要开始导航，未装 App 的手机
       会被高德整页引到 ap.amap.com / wap-org.amap.com 的「立即下载」；
     · callnative=1 由高德自动判定并拉起 App，同样把选择权从用户手里拿走；
     · 透传 surl.amap.com 短链会经 m.amap.com/callAPP 中转，未装 App 时
       超时兜底跳下载页，且落地页随出口漂移，不可依赖。
   所以高德有坐标时一律用 uri.amap.com/marker（位置标注页，落 m.amap.com/
   share/index）：零下载页特征、不带 callnative，这正是正式版 407（POI 详情 /
   搜索页）在真机上不跳下载页的原因。
   无坐标时（2026-11-06 起）不再退化成「按门店名搜索」——搜索页要用户自己从
   结果里挑门店，挑错就等于导到别家；改为不调用任何地图，只提示「暂无精确定位，
   请录入」。坐标在数据中心录入，一次录入全局可用。
   百度 / 腾讯同范式（2026-11 真机复核，三家必须一致）：
     · 百度 api.map.baidu.com/marker → 落 map.baidu.com/mobile/.../place/marker，
       自带门店名、地址、「导航 / 打车 / 到这去」；
       旧实现用 /direction 驾车路线页，移动端先落「路线搜索」（终点为空）再退回
       地图首页，等于没把位置带过去。
     · 腾讯 mapapi.qq.com/web/mapComponents/locationMarker → 轻量位置页，
       红色标记 + 门店名 + 逆地理地址 + 「去这里」；
       旧实现 map.qq.com/?what=…&center=… 在移动端被忽略，只给地图首页。
     两条都免开发者 key、都不自动拉起 App；自建 baidumap:// / qqmap:// 在 iOS
     未装会弹系统错误框、WebView 与微信普遍拦截，一律不做。起点不传：各家移动端
     默认用本机 GPS，比浏览器 geolocation 更准。

   坐标系：库里只存一组 GCJ-02（火星坐标）。高德 / 腾讯原生就是 GCJ-02；
   百度是 BD-09，但 URI 支持 coord_type=gcj02 让百度自己转，不存两套坐标。
   经纬度顺序三家不同（高德经度在前、百度纬度在前），各配单测锁死。

   为什么严格校验、且 new URL 不带 base：
   旧实现 new URL(v, location.origin) 会把 "A栋B1" 解析成站内路径并跳过去（404，
   且 back.js 的 replace 让返回键也救不回）。服务端对 navigation 无格式校验，
   历史数据里确实有这种纯文本。 */
(function () {
  "use strict";
  if (typeof window === "undefined" || window.zpMapNav) return;

  var MAP_HOSTS = ["amap.com", "map.baidu.com", "map.qq.com", "ditu.qq.com"];
  var SRC = "zhipei";

  var PROVIDERS = [
    { id: "amap", label: "高德地图", desc: "精准导航，出行无忧", note: "查看门店位置，是否用 App 导航由您选" },
    { id: "baidu", label: "百度地图", desc: "智能规划，精准到达", note: "查看门店位置，是否用 App 导航由您选" },
    { id: "qq", label: "腾讯地图", desc: "实时路况，出行更顺畅", note: "查看门店位置，是否用 App 导航由您选" },
  ];

  /* ===== 行内图标（2026-11-07 视觉重做）=====
     全部自绘、无外部资源：PWA 离线可用，CSP 也不需要新增域名。
     品牌 logo 只取「一眼认出」的特征（高德纸飞机 / 百度红水滴 / 腾讯双色指针），
     不做像素级复刻；白色圆角底由 CSS 提供，这里只画图形本身。 */
  var HERO_ICON = '<svg viewBox="0 0 64 64" fill="none" aria-hidden="true">' +
    '<defs>' +
    '<radialGradient id="zpMnGlow" cx="32" cy="30" r="30" gradientUnits="userSpaceOnUse">' +
    '<stop stop-color="#2F6BFF" stop-opacity=".38"/><stop offset="1" stop-color="#2F6BFF" stop-opacity="0"/>' +
    '</radialGradient>' +
    '<linearGradient id="zpMnPin" x1="20" y1="8" x2="46" y2="46" gradientUnits="userSpaceOnUse">' +
    '<stop stop-color="#5C9BFF"/><stop offset="1" stop-color="#1E5BE0"/>' +
    '</linearGradient>' +
    '</defs>' +
    '<circle cx="32" cy="30" r="30" fill="url(#zpMnGlow)"/>' +
    '<ellipse cx="32" cy="46" rx="20" ry="7" stroke="#3B82F6" stroke-opacity=".55" stroke-width="2"/>' +
    '<path d="M32 10c-7.7 0-14 6-14 13.4C18 33.6 32 48 32 48s14-14.4 14-24.6C46 16 39.7 10 32 10z" fill="url(#zpMnPin)"/>' +
    '<circle cx="32" cy="23.5" r="5.2" fill="#FFFFFF"/></svg>';

  var MAP_ICONS = {
    amap: '<svg viewBox="0 0 48 48" aria-hidden="true">' +
      '<path d="M8 40 40 8 30 41l-6.4-10.6z" fill="#1E88E5"/>' +
      '<path d="M23.6 30.4 30 41 40 8z" fill="#1565C0"/></svg>',
    baidu: '<svg viewBox="0 0 48 48" aria-hidden="true">' +
      '<path d="M24 6c-7 0-12.5 5.6-12.5 12.5C11.5 27.4 24 42 24 42s12.5-14.6 12.5-23.5C36.5 11.6 31 6 24 6z" fill="#E53935"/>' +
      '<text x="24" y="23" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="11" font-weight="700" fill="#FFFFFF">du</text></svg>',
    qq: '<svg viewBox="0 0 48 48" aria-hidden="true">' +
      '<circle cx="24" cy="24" r="17" fill="#EAF2FF"/>' +
      '<path d="M24 9l5.6 13.4L24 20l-5.6 2.4z" fill="#2F80ED"/>' +
      '<path d="M24 39l-5.6-13.4L24 28l5.6-2.4z" fill="#F2994A"/></svg>',
  };

  var CHEV_ICON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M9 5l7 7-7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  /* 字符串 → 节点：template 解析不执行脚本，也不会把 SVG 放进 HTML 命名空间之外 */
  function svgOf(markup) {
    var t = document.createElement("template");
    t.innerHTML = markup;
    return t.content.firstChild;
  }

  function text(v) {
    return v == null ? "" : String(v).trim();
  }

  function isMapHost(host) {
    var h = text(host).toLowerCase().replace(/\.$/, "");
    if (!h) return false;
    for (var i = 0; i < MAP_HOSTS.length; i++) {
      var d = MAP_HOSTS[i];
      /* 必须「等于」或「以 .d 结尾」：amap.com.evil.com 不算 amap.com 子域 */
      if (h === d || h.slice(-(d.length + 1)) === "." + d) return true;
    }
    return false;
  }

  function isMobile() {
    try {
      return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
    } catch (e) {
      return false;
    }
  }

  function standalone() {
    try {
      return (
        !!(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
        window.navigator.standalone === true
      );
    } catch (e) {
      return false;
    }
  }

  function pickName(store) {
    return (
      text(store && store.name) || text(store && store.rawName) || text(store && store.originalName)
    );
  }

  /* 基准库里的坐标（GCJ-02）优先。范围外的值直接忽略，避免拼出 0,0。 */
  function geoOf(store) {
    var lat = Number(store && store.lat);
    var lng = Number(store && store.lng);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    if (lat < 18 || lat > 54 || lng < 73 || lng > 136) return null;
    return { lat: lat, lng: lng };
  }

  /* 只认白名单地图域名下的 http(s) 链接；纯文本/非地图 URL 一律当没有。 */
  function linkOf(store) {
    var raw = text(store && store.navigation) || text(store && store.nav);
    if (!raw) return "";
    try {
      var u = new URL(raw);
      if (!u.username && !u.password && /^https?:$/.test(u.protocol) && isMapHost(u.hostname)) {
        return u.href;
      }
    } catch (e) {}
    return "";
  }

  function enc(v) {
    return encodeURIComponent(v);
  }

  /* 全程不带 callnative：不主动拉起 App，也不显式置 0（正式版 407 的
     搜索入口带 callnative=1 却不跳下载页，说明决定因素是落地页类型，
     不是这个参数；多带一个参数只是多一个不确定变量）。
     「是否用 App」由落地页自带的「打开高德APP」按钮交给司机自己点。 */

  /* 位置标注页（302 落 m.amap.com/share/index）：position 是「经度,纬度」，
     纬度在前会导到几百公里外。用门店自己的坐标标一个点，页面里自带
     「打开高德APP」按钮 —— 想导航就自己点，我们绝不主动进入导航流程。 */
  function markerUrl(geo, name) {
    var url = "https://uri.amap.com/marker?position=" +
      geo.lng.toFixed(6) + "," + geo.lat.toFixed(6);
    if (name) url += "&name=" + enc(name);
    return url + "&src=" + SRC;
  }

  /* 百度的位置页（URI API marker）。落点是 map.baidu.com 的移动端 place/marker，
     页面自带门店名、地址与「导航 / 打车 / 到这去」，与高德位置页同范式。
     location 是「纬度,经度」—— 与高德相反；coord_type=gcj02 让百度自己转 BD-09。
     content 传一个空格：不传时百度会把字面的「内容」渲染成副标题占位。 */
  function baiduMarkerUrl(geo, name) {
    var url = "https://api.map.baidu.com/marker?location=" +
      geo.lat.toFixed(6) + "," + geo.lng.toFixed(6) +
      "&output=html&coord_type=gcj02&src=" + SRC;
    if (name) url += "&title=" + enc(name) + "&content=%20";
    return url;
  }

  /* 腾讯的位置页（mapComponents 的 locationMarker 组件）。落点是 mapapi.qq.com
     的轻量地图页：红色标记 + 门店名 + 逆地理地址 + 「去这里」，同样不拉起 App。
     marker 整串要整体编码 —— 内含 : , ; 三个分隔符，逐个拼编码会拼错。
     不用 apis.map.qq.com/uri/v1/marker 中转：那条会先尝试 qqmap:// 拉起 App。 */
  function qqMarkerUrl(geo, name) {
    var m = "coord:" + geo.lat.toFixed(6) + "," + geo.lng.toFixed(6);
    if (name) m += ";title:" + name;
    return "https://mapapi.qq.com/web/mapComponents/locationMarker/v/index.html?marker=" + enc(m);
  }

  /* ===== 三家适配器：一张表收口差异 =====
     只在有精确坐标时构造 URL；无坐标直接返回 {_geo:false}，三家一个地址都不给，
     调用方据此只提示「暂无精确定位，请录入」。

     三家都只送「看位置」页，绝不走驾车路线页 / 短链中转页：
       · 高德 uri.amap.com/marker（经度在前）
       · 百度 api.map.baidu.com/marker（纬度在前，coord_type=gcj02 交给百度转）
       · 腾讯 mapapi.qq.com/web/mapComponents/locationMarker
     页面里自带「打开高德APP」「去这里」等入口，是否用 App 由司机自己点。 */
  function providerUrls(store) {
    var geo = geoOf(store);
    if (!geo) return { _geo: false };
    var name = pickName(store);
    return {
      amap: markerUrl(geo, name),
      baidu: baiduMarkerUrl(geo, name),
      qq: qqMarkerUrl(geo, name),
      _geo: true,
    };
  }

  /* 载荷：渲染层塞进 data-zp-nav-payload，菜单点击时还原，
     避免把整个门店对象挂 DOM 上，也不依赖渲染层作用域。 */
  function navPayload(store) {
    var geo = geoOf(store);
    return JSON.stringify({
      name: pickName(store),
      lat: geo ? geo.lat : null,
      lng: geo ? geo.lng : null,
      link: linkOf(store),
    });
  }

  /* 返回 {url, kind:"geo"|"missing"}；门店无名也无坐标时返回 null。
     有坐标 → 高德「看位置」链接（菜单脚本没加载时点门店名也能用，渐进增强）。
     无坐标 → href 用 # 占位：门店名仍可点（点了由菜单委托给出「请录入」提示），
     但绝不把司机带到按名称搜索的结果页 —— 搜索结果要人自己挑，挑错就导到别家。 */
  function resolve(store) {
    var geo = geoOf(store);
    var name = pickName(store);
    if (geo) return { url: markerUrl(geo, name), kind: "geo" };
    return name ? { url: "#", kind: "missing" } : null;
  }

  function linkAttrs(store) {
    var t = resolve(store);
    if (!t) return null;
    var blank = standalone();
    return {
      url: t.url,
      kind: t.kind,
      target: blank ? "_blank" : "_self",
      rel: blank ? "noopener" : "",
      payload: navPayload(store),
    };
  }

  /* ===== 底部选择菜单 ===== */
  var sheet = null;
  var lastAnchor = null;

  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  function closeMenu() {
    if (sheet) {
      var bg = sheet;
      sheet = null;
      if (bg.parentNode) bg.parentNode.removeChild(bg);
      document.body.classList.remove("zp-mn-open");
    }
    if (lastAnchor && lastAnchor.focus) {
      try { lastAnchor.focus({ preventScroll: true }); } catch (e) {}
    }
    lastAnchor = null;
  }

  function go(url, blank) {
    if (!url) return;
    if (blank) {
      try { window.open(url, "_blank", "noopener"); } catch (e) { location.href = url; }
    } else {
      location.href = url;
    }
  }

  /* 无坐标提示：统一走全局 toast（首页 bundle、运单详情、今日配送、数据中心
     都加载了 feedback.js）。组件缺失时退回 alert —— 宁可粗糙也不静默，
     静默会让人以为是「点了没反应」。 */
  function notifyMissingGeo() {
    var msg = "暂无精确定位，请录入";
    try {
      if (typeof window.zpToast === "function") { window.zpToast(msg, "error"); return; }
    } catch (e) {}
    try { window.alert(msg); } catch (e) {}
  }

  function openMenu(anchor, payload) {
    closeMenu();
    var data;
    try { data = JSON.parse(payload); } catch (e) { return false; }
    if (!data || (!data.name && !data.lat)) return false;

    var urls = providerUrls({
      name: data.name,
      lat: data.lat,
      lng: data.lng,
      navigation: data.link,
    });
    /* 无精确定位：不弹三家、不进任何地图页，只提示去数据中心录入。
       门店名仍是可点元素（模板里 href="#"），这里返回 true 表示「已处理」，
       委托层据此 preventDefault，避免 # 把页面滚回顶部。 */
    if (!urls._geo) {
      notifyMissingGeo();
      return true;
    }
    /* 数据中心等页面把门店名做成 target=_blank 的预览链接；继承它，
       避免管理员点一下就被 _self 带离维护页面。 */
    var blank = standalone() || anchor.getAttribute("target") === "_blank";
    lastAnchor = anchor;

    var bg = el("div", "zp-mn-bg");
    var box = el("div", "zp-mn-sheet");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "选择导航软件");

    /* 把手：视觉上说明「这是一张浮起的卡片」，不承担拖拽（拖拽会与
       页面滚动争手势，且本弹层点遮罩即可关闭）。 */
    box.appendChild(el("div", "zp-mn-grabber"));

    var head = el("div", "zp-mn-head");
    var hero = el("div", "zp-mn-hero");
    hero.appendChild(svgOf(HERO_ICON));
    head.appendChild(hero);

    var copy = el("div", "zp-mn-copy");
    copy.appendChild(el("div", "zp-mn-title", "导航到"));
    /* 门店名放副标题而不是标题：完整店名常有 15~25 字，做标题必然被省略号切掉；
       放副标题可折两行，司机能确认「导的是哪一家」。 */
    copy.appendChild(el("div", "zp-mn-sub", data.name));
    head.appendChild(copy);

    var x = el("button", "zp-mn-close");
    x.type = "button";
    x.setAttribute("aria-label", "关闭");
    x.appendChild(svgOf(CLOSE_ICON));
    x.addEventListener("click", closeMenu);
    head.appendChild(x);
    box.appendChild(head);

    var list = el("div", "zp-mn-list");
    PROVIDERS.forEach(function (p) {
      var row = el("button", "zp-mn-row" + (p.id === "amap" ? " is-primary" : ""));
      row.type = "button";
      row.setAttribute("data-provider", p.id);
      /* 读屏用：App 名 + 说明；视觉上的第三行小字（desc）只是同一信息的呈现 */
      row.setAttribute("aria-label", p.label + "：" + p.note);

      var icon = el("span", "zp-mn-icon");
      icon.appendChild(svgOf(MAP_ICONS[p.id]));
      row.appendChild(icon);

      var rowCopy = el("span", "zp-mn-row-copy");
      rowCopy.appendChild(el("span", "zp-mn-row-label", p.label));
      rowCopy.appendChild(el("span", "zp-mn-row-desc", p.desc));
      row.appendChild(rowCopy);

      var chev = el("span", "zp-mn-chev");
      chev.appendChild(svgOf(CHEV_ICON));
      row.appendChild(chev);

      row.addEventListener("click", function () {
        var u = urls[p.id];
        closeMenu();
        go(u, blank);
      });
      list.appendChild(row);
    });
    box.appendChild(list);

    var cancel = el("button", "zp-mn-cancel", "取消");
    cancel.type = "button";
    cancel.addEventListener("click", closeMenu);
    box.appendChild(cancel);

    bg.appendChild(box);
    bg.addEventListener("click", function (e) {
      if (e.target === bg) closeMenu();
    });

    document.body.appendChild(bg);
    document.body.classList.add("zp-mn-open");
    sheet = bg;
    /* 聚焦弹层本身，不聚焦第一个选项：脚本聚焦会让「高德地图」带上
       focus-visible 描边，看起来像默认选中了它，触摸场景是误导。
       聚焦 dialog 后读屏仍先读标题，键盘 Tab 依旧能进入选项。 */
    box.setAttribute("tabindex", "-1");
    try { box.focus({ preventScroll: true }); } catch (e) {}
    return true;
  }

  /* 冒泡阶段委托：手势 / 业务已 preventDefault 的点击不接管。
     数据中心左滑后浏览器补发的那次 click 会被 suppressNavUntil 吃掉，这里跳过；
     e2e 用例在捕获阶段 preventDefault 记录 href，也不会弹菜单。 */
  if (typeof document !== "undefined") {
    document.addEventListener("click", function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target && e.target.closest ? e.target.closest("[data-zp-nav-payload]") : null;
      if (!a) return;
      var payload = a.getAttribute("data-zp-nav-payload");
      if (!payload) return;
      if (!openMenu(a, payload)) return;
      e.preventDefault();
    }, false);

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && sheet && !e.defaultPrevented) {
        e.preventDefault();
        closeMenu();
      }
    });
  }

  /* 系统返回键先关菜单：沿用项目统一的返回层级钩子。
     back.js 可能晚于本文件加载，用自初始化 push 写法（与其约定一致）。
     rank 8 低于业务弹层（10+），保证菜单是最先响应返回的那一层。 */
  (window.zpBackHooks = window.zpBackHooks || []).push({
    rank: 8,
    probe: function () { return sheet; },
    close: function () { if (!sheet) return false; closeMenu(); return true; },
  });

  window.zpMapNav = {
    resolve: resolve,
    linkAttrs: linkAttrs,
    markerUrl: markerUrl,
    baiduMarkerUrl: baiduMarkerUrl,
    qqMarkerUrl: qqMarkerUrl,
    providerUrls: providerUrls,
    navPayload: navPayload,
    isMapHost: isMapHost,
    isMobile: isMobile,
    PROVIDERS: PROVIDERS,
  };
})();
