import DOMPurify from "dompurify";

// Mail is shown safely (ADR-032): cleaned with DOMPurify, then put in a
// sandboxed frame where nothing runs. Remote images (and anything else
// fetched from outside: trackers, fonts) are blocked until I allow them
// for the message or its sender; then the daemon fetches them and they
// come inline (data: URLs), so neither the UI nor the frame ever loads
// anything from outside (Audit 2).

const REMOTE = /^(https?:)?\/\//i;

export interface CleanMail {
  /** A whole document for the frame's srcdoc. */
  doc: string;
  /** How many remote images were held back. */
  blocked: number;
}

/** The frame's own policy: nothing runs, nothing loads from outside; images come inline. */
export function frameCsp(_allowImages = false): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "form-action 'none'",
  ].join("; ");
}

export function cleanMailHtml(
  html: string,
  o: {
    allowImages: boolean;
    /** Allowed images the daemon fetched: remote address → data: URL. */
    images?: Record<string, string>;
    dark?: boolean;
    window?: Window & typeof globalThis;
  },
): CleanMail {
  const purify = DOMPurify(o.window ?? window);
  let blocked = 0;
  purify.addHook("afterSanitizeAttributes", (node) => {
    const el = node as Element;
    if (el.tagName === "A") {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
    for (const attr of ["src", "srcset", "background", "poster"]) {
      const v = el.getAttribute(attr);
      if (!v) continue;
      const inline = o.allowImages ? o.images?.[v.trim()] : undefined;
      if (inline && attr !== "srcset") el.setAttribute(attr, inline);
      else if (REMOTE.test(v.trim()) || attr === "srcset") {
        el.removeAttribute(attr);
        el.setAttribute(`data-blocked-${attr}`, v);
        if (!o.allowImages) blocked++;
      }
    }
    const style = el.getAttribute("style");
    if (style && /url\(\s*['"]?\s*(https?:)?\/\//i.test(style)) {
      el.setAttribute(
        "style",
        style.replace(/url\(\s*["']?([^"')]*)["']?\s*\)/gi, (m, u: string) => {
          const inline = o.allowImages ? o.images?.[u.trim()] : undefined;
          return inline ? `url("${inline}")` : REMOTE.test(u.trim()) ? "none" : m;
        }),
      );
      if (!o.allowImages) blocked++;
    }
  });
  const body = purify.sanitize(html, {
    WHOLE_DOCUMENT: false,
    FORBID_TAGS: [
      "script",
      "iframe",
      "frame",
      "object",
      "embed",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "meta",
      "link",
      "base",
    ],
    FORBID_ATTR: ["action", "formaction"],
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ["target"],
  });
  purify.removeAllHooks();
  const colors = o.dark
    ? "html{color-scheme:dark}body{background:#16171c;color:#e6e6ea}a{color:#9aa7ff}"
    : "html{color-scheme:light}body{background:#fff;color:#1c1c22}";
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${frameCsp(o.allowImages)}"><base target="_blank"><style>body{margin:0;padding:4px;font:14px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}${colors}</style></head><body>${body}</body></html>`;
  return { doc, blocked };
}

/** Plain text as a frame document too: one way of showing mail. */
export function textMail(text: string): string {
  const esc = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const linked = esc.replace(
    /\bhttps?:\/\/[^\s<>"]+/g,
    (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`,
  );
  return `<div style="white-space:pre-wrap">${linked}</div>`;
}
