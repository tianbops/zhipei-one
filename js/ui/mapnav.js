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
   所以高德一律用 uri.amap.com/marker（有坐标 → 位置标注页，落 m.amap.com/
   share/index）或 /search（无坐标 → 门店名搜索页，落 m.amap.com/search/view），
   两者都是「看位置」页、零下载页特征，也不带 callnative；这正是正式版 407
   （POI 详情 / 搜索页）在真机上不跳下载页的原因。
   百度 URI API v2.0 免费免 ak、支持 coord_type=gcj02；腾讯不申请开发者 key，
   用 map.qq.com 网页版搜索占位。自建 baidumap:// / qqmap:// 在 iOS 未装会弹
   系统错误框、WebView 与微信普遍拦截，visibilitychange + 超时探测还会双跳，
   一律不做。起点不传：各家移动端默认用本机 GPS，比浏览器 geolocation 更准。

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
    { id: "amap", label: "高德地图", note: "查看门店位置，是否用 App 导航由您选" },
    { id: "baidu", label: "百度地图", note: "免 key，坐标由百度自动转换" },
    { id: "qq", label: "腾讯地图", note: "网页版搜索（无需开发者 key）" },
  ];

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

  function hostIs(link, re) {
    try {
      return re.test(new URL(link).hostname.toLowerCase().replace(/\.$/, ""));
    } catch (e) {
      return false;
    }
  }

  /* 全程不带 callnative：不主动拉起 App，也不显式置 0（正式版 407 的
     keywordUrl 带 callnative=1 却不跳下载页，说明决定因素是落地页类型，
     不是这个参数；多带一个参数只是多一个不确定变量）。
     「是否用 App」由落地页自带的「打开高德APP」按钮交给司机自己点。 */

  /* 门店名搜索页（302 落 m.amap.com/search/view）：无坐标时的「看位置」入口。 */
  function keywordUrl(name) {
    return "https://uri.amap.com/search?keyword=" + enc(name) + "&src=" + SRC;
  }

  /* 位置标注页（302 落 m.amap.com/share/index）：position 是「经度,纬度」，
     纬度在前会导到几百公里外。用门店自己的坐标标一个点，页面里自带
     「打开高德APP」按钮 —— 想导航就自己点，我们绝不主动进入导航流程。 */
  function markerUrl(geo, name) {
    var url = "https://uri.amap.com/marker?position=" +
      geo.lng.toFixed(6) + "," + geo.lat.toFixed(6);
    if (name) url += "&name=" + enc(name);
    return url + "&src=" + SRC;
  }

  /* ===== 三家适配器：一张表收口差异 =====
     返回 {amap, baidu, qq, _geo}，_geo 供菜单显示「已绑定精确坐标」。 */
  function providerUrls(store) {
    var geo = geoOf(store);
    var name = pickName(store);
    var link = linkOf(store);
    var n = enc(name);
    var out = {};

    /* 高德：一律送到「看位置」页 —— 有坐标走位置标注页（marker），没坐标按
       门店名搜索（search）。绝不用 uri.amap.com/navigation 驾车路线页（真机会
       引导下载），也绝不透传 navigation 里的 surl.amap.com 短链（那条经
       m.amap.com/callAPP，未装 App 时超时兜底整页跳「立即下载高德」）。
       页面里自带「打开高德APP」按钮，是否用 App 由司机自己点。
       link 只参与下面的百度分支判断，不参与高德 URL。 */
    out.amap = geo ? markerUrl(geo, name) : keywordUrl(name);

    /* 百度：destination 必须带 latlng: 前缀（纬度在前），|name: 后缀是可选标注。
       coord_type=gcj02 让百度自己把 GCJ-02 转成 BD-09；output=html 是网页版兜底。
       不传 origin，百度移动端默认用当前定位。 */
    if (geo) {
      out.baidu =
        "https://api.map.baidu.com/direction?destination=" +
        "latlng:" + geo.lat.toFixed(6) + "," + geo.lng.toFixed(6) +
        (name ? "|name:" + n : "") +
        "&mode=driving&coord_type=gcj02&output=html&src=" + SRC;
    } else if (link && hostIs(link, /(^|\.)map\.baidu\.com$/)) {
      out.baidu = link;
    } else {
      out.baidu = "https://map.baidu.com/search/" + n + "/";
    }

    /* 腾讯：不申请开发者 key（URI API 的 referer 必填且要开发者标识），
       用 map.qq.com 官方网页版搜索占位。有坐标时附带 center 让网页版尽量贴近
       精确位置；最终落点以腾讯页面行为为准，不做唤起 App 的承诺。 */
    out.qq =
      "https://map.qq.com/?what=" + n +
      (geo ? "&center=" + geo.lat.toFixed(6) + "," + geo.lng.toFixed(6) : "");

    out._geo = !!geo;
    return out;
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

  /* 返回 {url, kind:"geo"|"keyword"}；门店无任何可用信息时返回 null。
     url 仍是高德默认「看位置」链接 —— 菜单脚本没加载时点门店名也能用
     （渐进增强）。这里同样只用 marker/search，绝不透传短链、绝不用驾车
     路线页，否则渐进增强路径会绕过上面的约束。 */
  function resolve(store) {
    var geo = geoOf(store);
    var name = pickName(store);
    if (geo) return { url: markerUrl(geo, name), kind: "geo" };
    return name ? { url: keywordUrl(name), kind: "keyword" } : null;
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
    /* 数据中心等页面把门店名做成 target=_blank 的预览链接；继承它，
       避免管理员点一下就被 _self 带离维护页面。 */
    var blank = standalone() || anchor.getAttribute("target") === "_blank";
    lastAnchor = anchor;

    var bg = el("div", "zp-mn-bg");
    var box = el("div", "zp-mn-sheet");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "选择导航软件");

    var head = el("div", "zp-mn-head");
    head.appendChild(el("div", "zp-mn-title", "导航到 " + data.name));
    head.appendChild(el("div", "zp-mn-sub", urls._geo ? "已绑定精确坐标 · 打开门店位置，是否用 App 导航由您选" : "暂无坐标 · 将按门店名搜索门店位置"));
    var x = el("button", "zp-mn-close", "✕");
    x.type = "button";
    x.setAttribute("aria-label", "关闭");
    x.addEventListener("click", closeMenu);
    head.appendChild(x);
    box.appendChild(head);

    var list = el("div", "zp-mn-list");
    PROVIDERS.forEach(function (p) {
      var row = el("button", "zp-mn-row");
      row.type = "button";
      row.setAttribute("data-provider", p.id);
      var main = el("span", "zp-mn-row-main");
      main.appendChild(el("span", "zp-mn-row-label", p.label));
      main.appendChild(el("span", "zp-mn-row-hint", p.note));
      row.appendChild(main);
      row.appendChild(el("span", "zp-mn-arrow", "›"));
      row.addEventListener("click", function () {
        var u = urls[p.id];
        closeMenu();
        go(u, blank);
      });
      list.appendChild(row);
    });
    box.appendChild(list);
    bg.appendChild(box);
    bg.addEventListener("click", function (e) {
      if (e.target === bg) closeMenu();
    });

    document.body.appendChild(bg);
    document.body.classList.add("zp-mn-open");
    sheet = bg;
    var first = list.querySelector(".zp-mn-row");
    if (first && first.focus) { try { first.focus({ preventScroll: true }); } catch (e) {} }
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
    keywordUrl: keywordUrl,
    markerUrl: markerUrl,
    providerUrls: providerUrls,
    navPayload: navPayload,
    isMapHost: isMapHost,
    isMobile: isMobile,
    PROVIDERS: PROVIDERS,
  };
})();
