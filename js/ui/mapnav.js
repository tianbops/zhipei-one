/* ui/mapnav.js —— 门店名 → 地图导航目标
   ------------------------------------------------------------
   门店数据里只有 name 和 navigation（「导航地址」，真实数据多为高德短链
   https://surl.amap.com/xxx），没有 address / 经纬度。所以这里只做一件事：
   把一个门店对象解析成「可点击的目标 URL」，交给渲染层拼 <a href>。

   两条路径：
   1) navigation 是地图域名下的 http(s) 链接 → 原样透传（链接自带精确 POI）；
   2) 其余（空 / 纯文本 / 非地图 URL）→ 用门店名走高德关键词搜索。

   为什么用 https 智能链接而不是 androidamap:// / iosamap://：
   高德 uri.amap.com 的 callnative=1 会「已装拉起 App、未装留在网页版」，
   两态由高德自己判定；自建 scheme 在 iOS 未安装时会弹系统错误框，
   WebView / 微信普遍拦截，靠 visibilitychange + 超时探测还会出现双跳。
   起点不传：地图 App 默认用本机 GPS，比浏览器 geolocation 更准且无需授权。

   为什么严格校验、且 new URL 不带 base：
   旧实现 new URL(v, location.origin) 会把 "A栋B1" 解析成站内路径
   https://站点/A%E6栋... 并跳过去（404，且 back.js 的 replace 让返回键也救不回）。
   服务端对 navigation 无格式校验，历史数据里确实有这种纯文本。 */
(function () {
  "use strict";
  if (typeof window === "undefined" || window.zpMapNav) return;

  var MAP_HOSTS = ["amap.com", "map.baidu.com", "map.qq.com", "ditu.qq.com"];
  var SRC = "zhipei";

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

  function keywordUrl(name) {
    var url = "https://uri.amap.com/search?keyword=" + encodeURIComponent(name) + "&src=" + SRC;
    /* callnative 仅移动端有意义：桌面端加了也只是个无效参数，去掉更干净 */
    return isMobile() ? url + "&callnative=1" : url;
  }

  function pickName(store) {
    return text(store && store.name) || text(store && store.rawName) || text(store && store.originalName);
  }

  /* 返回 {url, kind:"link"|"keyword"}；门店无任何可用信息时返回 null */
  function resolve(store) {
    var raw = text(store && store.navigation) || text(store && store.nav);
    if (raw) {
      try {
        var u = new URL(raw);
        if (
          !u.username &&
          !u.password &&
          /^https?:$/.test(u.protocol) &&
          isMapHost(u.hostname)
        ) {
          return { url: u.href, kind: "link" };
        }
      } catch (e) {
        /* 纯文本、相对路径、非法 scheme 都落这里 → 走关键词 */
      }
    }
    var name = pickName(store);
    return name ? { url: keywordUrl(name), kind: "keyword" } : null;
  }

  /* 加到主屏的 iOS PWA 没有地址栏，_self 跳走会困在高德页；
     其它场景（浏览器、App 壳）用 _self，返回键/手势能直接回列表。 */
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

  function linkAttrs(store) {
    var t = resolve(store);
    if (!t) return null;
    var blank = standalone();
    return {
      url: t.url,
      kind: t.kind,
      target: blank ? "_blank" : "_self",
      rel: blank ? "noopener" : "",
    };
  }

  window.zpMapNav = {
    resolve: resolve,
    linkAttrs: linkAttrs,
    keywordUrl: keywordUrl,
    isMapHost: isMapHost,
    isMobile: isMobile,
  };
})();
