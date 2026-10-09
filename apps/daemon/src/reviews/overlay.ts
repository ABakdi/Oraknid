// The review overlay (ADR-064 §2–3): a small script Oraknid adds to each
// HTML page of a design or of the running app it serves for a review. It
// never changes the project; it runs in the frame and talks to the review
// page only through postMessage:
//
//   page → frame  {ns, op: "select", on}       select mode on or off
//                 {ns, op: "pins", pins}       the notes' pins to draw: [{id, n, selector, kind, active}]
//                 {ns, op: "highlight", id}    scroll a pin's element into view
//                 {ns, op: "clear"}            the selected outline goes
//   frame → page  {ns, op: "ready", page, title, snapshot}
//                 {ns, op: "page", page}       an app moved to another route (pushState)
//                 {ns, op: "selected", element, page, shot, console, requests}
//                 {ns, op: "pin", id}          a pin was clicked
//                 {ns, op: "problems", console, requests}   how many errors so far
//                 {ns, op: "navigate", href}   a link, in a frame inlined away from home
//                 {ns, op: "escape"}
//
// What it captures is the page's own (its text, its errors): nothing of
// Oraknid's reaches the frame. It accepts messages only from its parent.
// Plain ES5-ish JavaScript in a string: it is served as it is.

/** Where the overlay is served on a review's frame origin; never proxied to the app. */
export const OVERLAY_PATH = "/__oraknid/overlay.js";

/** The namespace every message carries. */
export const OVERLAY_NS = "oraknid-review";

export const OVERLAY_JS = String.raw`(function () {
  "use strict";
  if (window.__oraknidOverlay) return;
  window.__oraknidOverlay = true;
  var NS = "oraknid-review";
  var cfg = window.__oraknidReview || {};
  var snapshot = !!cfg.snapshot;
  var parentWin = window.parent;
  if (!parentWin || parentWin === window) return;
  var post = function (m) {
    m.ns = NS;
    try { parentWin.postMessage(m, "*"); } catch (e) { /* the page went */ }
  };
  var pagePath = function () {
    return snapshot ? String(cfg.path || "/") : location.pathname + location.search;
  };

  // ---- what the app says and fails at --------------------------------------
  var MAX = 50;
  var consoleLines = [];
  var failed = [];
  var keep = function (list, item) {
    list.push(item);
    if (list.length > MAX) list.shift();
    tellProblems();
  };
  var problemsTimer = 0;
  function tellProblems() {
    if (problemsTimer) return;
    problemsTimer = setTimeout(function () {
      problemsTimer = 0;
      post({ op: "problems", console: consoleLines.length, requests: failed.length });
    }, 300);
  }
  var text = function (v) {
    if (v instanceof Error) return String(v.stack || v.message || v);
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  };
  ["error", "warn"].forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      try {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) parts.push(text(arguments[i]));
        keep(consoleLines, { level: level, text: parts.join(" ").slice(0, 2000), at: Date.now() });
      } catch (e) { /* never in the app's way */ }
      return orig.apply(console, arguments);
    };
  });
  window.addEventListener("error", function (e) {
    var t = e.target;
    if (t && t !== window && t.tagName) {
      var src = t.src || t.href || "";
      keep(failed, { method: "GET", url: String(src).slice(0, 2000), status: null, error: "Could not load this " + t.tagName.toLowerCase(), at: Date.now() });
      return;
    }
    keep(consoleLines, { level: "error", text: String((e.error && e.error.stack) || e.message).slice(0, 2000), at: Date.now() });
  }, true);
  window.addEventListener("unhandledrejection", function (e) {
    keep(consoleLines, { level: "error", text: ("Unhandled rejection: " + text(e.reason)).slice(0, 2000), at: Date.now() });
  });
  if (window.fetch) {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var method = (init && init.method) || (input && input.method) || "GET";
      var url = typeof input === "string" ? input : (input && input.url) || String(input);
      return origFetch.apply(this, arguments).then(function (r) {
        if (r.status >= 400) keep(failed, { method: String(method).toUpperCase(), url: String(url).slice(0, 2000), status: r.status, error: null, at: Date.now() });
        return r;
      }, function (err) {
        keep(failed, { method: String(method).toUpperCase(), url: String(url).slice(0, 2000), status: null, error: String((err && err.message) || err).slice(0, 500), at: Date.now() });
        throw err;
      });
    };
  }
  if (window.XMLHttpRequest) {
    var xo = XMLHttpRequest.prototype.open;
    var xs = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) {
      this.__orq = { method: String(m || "GET").toUpperCase(), url: String(u) };
      return xo.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var x = this;
      x.addEventListener("loadend", function () {
        var q = x.__orq || { method: "GET", url: "" };
        if (x.status === 0) keep(failed, { method: q.method, url: q.url.slice(0, 2000), status: null, error: "No answer", at: Date.now() });
        else if (x.status >= 400) keep(failed, { method: q.method, url: q.url.slice(0, 2000), status: x.status, error: null, at: Date.now() });
      });
      return xs.apply(this, arguments);
    };
  }

  // ---- an app's own routes ---------------------------------------------------
  ["pushState", "replaceState"].forEach(function (k) {
    var orig = history[k];
    history[k] = function () {
      var r = orig.apply(this, arguments);
      post({ op: "page", page: pagePath() });
      return r;
    };
  });
  window.addEventListener("popstate", function () { post({ op: "page", page: pagePath() }); });

  // ---- the layer: outline and pins, above the page, out of its way --------
  var host, root, outline, pinsBox;
  function layer() {
    if (host) return;
    host = document.createElement("oraknid-review-layer");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block;";
    root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    var style = document.createElement("style");
    style.textContent =
      ".o{position:fixed;pointer-events:none;border:2px solid #2563eb;background:rgba(37,99,235,.08);border-radius:3px;display:none;box-sizing:border-box;transition:all .05s}" +
      ".o.s{border-style:solid;border-color:#f59e0b;background:rgba(245,158,11,.12)}" +
      ".p{position:fixed;pointer-events:auto;min-width:22px;height:22px;padding:0 6px;border-radius:11px;font:600 12px/22px system-ui,sans-serif;color:#fff;text-align:center;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.35);transform:translate(-50%,-50%);border:2px solid #fff;box-sizing:border-box}" +
      ".p.keep{background:#16a34a}.p.change{background:#2563eb}.p.problem{background:#dc2626}.p.general{background:#6b7280}" +
      ".p.a{outline:3px solid #f59e0b;outline-offset:1px;z-index:2}";
    root.appendChild(style);
    outline = document.createElement("div");
    outline.className = "o";
    root.appendChild(outline);
    pinsBox = document.createElement("div");
    root.appendChild(pinsBox);
    (document.body || document.documentElement).appendChild(host);
  }
  var isOurs = function (el) { return !!el && (el === host || (host && host.contains(el))); };
  function place(div, r) {
    div.style.display = "block";
    div.style.left = r.left + "px";
    div.style.top = r.top + "px";
    div.style.width = r.width + "px";
    div.style.height = r.height + "px";
  }

  // ---- a selector that finds the element again --------------------------------
  var esc = window.CSS && CSS.escape ? CSS.escape : function (s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&"); };
  var unique = function (s) { try { return document.querySelectorAll(s).length === 1; } catch (e) { return false; } };
  function selectorOf(el) {
    if (el.id && unique("#" + esc(el.id))) return "#" + esc(el.id);
    var parts = [];
    var n = el;
    while (n && n.nodeType === 1 && n !== document.documentElement) {
      var tid = n.getAttribute("data-testid");
      var part;
      if (tid) part = "[data-testid=\"" + String(tid).replace(/["\\]/g, "\\$&") + "\"]";
      else if (n !== el && n.id && unique("#" + esc(n.id))) part = "#" + esc(n.id);
      else {
        part = n.tagName.toLowerCase();
        var p = n.parentElement;
        if (p) {
          var same = [];
          for (var i = 0; i < p.children.length; i++) if (p.children[i].tagName === n.tagName) same.push(p.children[i]);
          if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(n) + 1) + ")";
        }
      }
      parts.unshift(part);
      var s = parts.join(" > ");
      if (unique(s)) return s;
      n = n.parentElement;
    }
    return parts.join(" > ") || el.tagName.toLowerCase();
  }
  function boxOf(el) {
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) };
  }
  function textOf(el) {
    var t = (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("placeholder") || "");
    return String(t).replace(/\s+/g, " ").trim().slice(0, 300);
  }

  // ---- a picture of the selected part, drawn in the page itself ------------
  var NODES_MAX = 1500;
  function cloneStyled(node, budget) {
    if (node.nodeType === 3) return node.cloneNode(false);
    if (node.nodeType !== 1 || isOurs(node)) return null;
    if (budget.n++ > NODES_MAX) return null;
    var tag = node.tagName.toLowerCase();
    if (tag === "script" || tag === "noscript" || tag === "template" || tag === "style" || tag === "link") return null;
    var c;
    if (tag === "canvas") {
      c = document.createElement("img");
      try { c.setAttribute("src", node.toDataURL()); } catch (e) { /* a tainted canvas stays blank */ }
    } else if (tag === "img") {
      c = document.createElement("img");
      try {
        if (node.complete && node.naturalWidth) {
          var cv = document.createElement("canvas");
          cv.width = node.naturalWidth;
          cv.height = node.naturalHeight;
          cv.getContext("2d").drawImage(node, 0, 0);
          c.setAttribute("src", cv.toDataURL());
        }
      } catch (e) { /* an image of another site stays blank */ }
    } else if (tag === "iframe" || tag === "video" || tag === "audio" || tag === "object" || tag === "embed") {
      c = document.createElement("div");
    } else {
      c = node.cloneNode(false);
      if (c.removeAttribute) { c.removeAttribute("id"); c.removeAttribute("class"); }
      if ((tag === "input" || tag === "textarea") && node.value != null) c.setAttribute("value", node.value);
    }
    var cs = getComputedStyle(node);
    var css = "";
    for (var i = 0; i < cs.length; i++) {
      var prop = cs[i];
      if (prop === "transition" || prop.indexOf("transition-") === 0 || prop.indexOf("animation") === 0) continue;
      css += prop + ":" + cs.getPropertyValue(prop) + ";";
    }
    c.setAttribute("style", css);
    if (tag !== "img" && tag !== "canvas") {
      for (var k = node.firstChild; k; k = k.nextSibling) {
        var kc = cloneStyled(k, budget);
        if (kc) c.appendChild(kc);
      }
    }
    return c;
  }
  function bgOf(el) {
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var b = getComputedStyle(n).backgroundColor;
      if (b && b !== "transparent" && !/rgba\(.*,\s*0\)$/.test(b)) return b;
    }
    return "#ffffff";
  }
  function shot(el) {
    return new Promise(function (resolve) {
      try {
        var r = el.getBoundingClientRect();
        var w = Math.max(1, Math.min(Math.ceil(r.width), 2000));
        var h = Math.max(1, Math.min(Math.ceil(r.height), 2000));
        if (r.width < 2 || r.height < 2) return resolve(null);
        var clone = cloneStyled(el, { n: 0 });
        if (!clone) return resolve(null);
        clone.style.margin = "0";
        clone.style.position = "static";
        clone.style.transform = "none";
        clone.style.width = r.width + "px";
        clone.style.height = r.height + "px";
        var wrap = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
        wrap.setAttribute("style", "width:" + w + "px;height:" + h + "px;overflow:hidden;background:" + bgOf(el));
        wrap.appendChild(clone);
        var xml = new XMLSerializer().serializeToString(wrap);
        var svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" + w + "\" height=\"" + h + "\"><foreignObject x=\"0\" y=\"0\" width=\"100%\" height=\"100%\">" + xml + "</foreignObject></svg>";
        var img = new Image();
        var done = false;
        var finish = function (v) { if (!done) { done = true; resolve(v); } };
        setTimeout(function () { finish(null); }, 4000);
        img.onload = function () {
          try {
            var scale = Math.min(2, window.devicePixelRatio || 1, 1600 / Math.max(w, h));
            var cv = document.createElement("canvas");
            cv.width = Math.max(1, Math.round(w * scale));
            cv.height = Math.max(1, Math.round(h * scale));
            var ctx = cv.getContext("2d");
            ctx.scale(scale, scale);
            ctx.drawImage(img, 0, 0, w, h);
            finish(cv.toDataURL("image/jpeg", 0.85));
          } catch (e) { finish(null); }
        };
        img.onerror = function () { finish(null); };
        img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
      } catch (e) { resolve(null); }
    });
  }

  // ---- select mode -----------------------------------------------------------
  var selecting = false;
  var hovered = null;
  var selected = null;
  function targetOf(e) {
    var t = e.target;
    if (!t || t.nodeType !== 1 || isOurs(t)) return null;
    if (t === document.documentElement) return null;
    return t;
  }
  function hover(e) {
    if (!selecting) return;
    var t = targetOf(e);
    if (!t || t === hovered) return;
    hovered = t;
    layer();
    outline.className = "o";
    place(outline, t.getBoundingClientRect());
  }
  function block(e) {
    if (!selecting) return;
    if (isOurs(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }
  function pick(e) {
    if (!selecting) return;
    var t = targetOf(e);
    block(e);
    if (!t) return;
    selected = t;
    layer();
    outline.className = "o s";
    place(outline, t.getBoundingClientRect());
    var element = { selector: selectorOf(t), text: textOf(t), tag: t.tagName.toLowerCase(), box: boxOf(t) };
    // The outline is out of the picture: it is drawn on the layer, not the element.
    shot(t).then(function (s) {
      post({ op: "selected", element: element, page: pagePath(), shot: s, console: consoleLines.slice(), requests: failed.slice() });
    });
  }
  ["pointerdown", "mousedown", "mouseup", "pointerup", "dblclick", "contextmenu", "submit", "auxclick"].forEach(function (k) {
    document.addEventListener(k, block, true);
  });
  document.addEventListener("pointermove", hover, true);
  document.addEventListener("pointerdown", function (e) { if (e.pointerType !== "mouse") hover(e); }, true);
  document.addEventListener("click", pick, true);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") post({ op: "escape" });
  }, true);

  // A link in a frame inlined away from home: the page loads the next one.
  document.addEventListener("click", function (e) {
    if (!snapshot || selecting || e.defaultPrevented) return;
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (!href || href.charAt(0) === "#" || /^[a-z]+:/i.test(href) || href.indexOf("//") === 0) return;
    e.preventDefault();
    var u = new URL(href, "http://frame" + (cfg.path || "/"));
    post({ op: "navigate", href: u.pathname + u.search });
  });

  // ---- pins ----------------------------------------------------------------
  var pins = [];
  var pinEls = {};
  var drawQueued = false;
  function drawPins() {
    drawQueued = false;
    if (selected && outline && outline.className === "o s") {
      if (selected.isConnected) place(outline, selected.getBoundingClientRect());
      else outline.style.display = "none";
    }
    if (!pins.length) return;
    layer();
    var seen = {};
    pins.forEach(function (p) {
      var el = null;
      try { el = document.querySelector(p.selector); } catch (e) { el = null; }
      var d = pinEls[p.id];
      if (!el) { if (d) d.style.display = "none"; return; }
      if (!d) {
        d = document.createElement("div");
        d.addEventListener("click", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          post({ op: "pin", id: p.id });
        });
        pinsBox.appendChild(d);
        pinEls[p.id] = d;
      }
      seen[p.id] = true;
      d.className = "p " + p.kind + (p.active ? " a" : "");
      d.textContent = String(p.n);
      d.title = p.text || "";
      var r = el.getBoundingClientRect();
      d.style.display = "block";
      d.style.left = Math.max(12, r.left) + "px";
      d.style.top = Math.max(12, r.top) + "px";
    });
    Object.keys(pinEls).forEach(function (id) {
      if (!seen[id]) { pinEls[id].remove(); delete pinEls[id]; }
    });
  }
  function queueDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(drawPins);
  }
  window.addEventListener("scroll", queueDraw, true);
  window.addEventListener("resize", queueDraw);
  // Layout moves without a scroll (an app loading its data): looked at again now and then.
  setInterval(function () { if (pins.length || selected) queueDraw(); }, 700);

  // ---- the review page's messages -------------------------------------------
  window.addEventListener("message", function (e) {
    if (e.source !== parentWin) return;
    var m = e.data;
    if (!m || m.ns !== NS) return;
    if (m.op === "select") {
      selecting = !!m.on;
      hovered = null;
      document.documentElement.style.cursor = selecting ? "crosshair" : "";
      if (!selecting && outline && outline.className === "o") outline.style.display = "none";
    } else if (m.op === "pins") {
      pins = Array.isArray(m.pins) ? m.pins.slice(0, 500) : [];
      queueDraw();
    } else if (m.op === "clear") {
      selected = null;
      if (outline) outline.style.display = "none";
    } else if (m.op === "highlight") {
      var p = pins.filter(function (x) { return x.id === m.id; })[0];
      var el = null;
      try { el = p ? document.querySelector(p.selector) : null; } catch (err) { el = null; }
      if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "smooth" });
      queueDraw();
    }
  });

  var ready = function () {
    post({ op: "ready", page: pagePath(), title: document.title || "", snapshot: snapshot });
    tellProblems();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
  else ready();
})();
`;
