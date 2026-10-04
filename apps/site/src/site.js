// The site's few behaviours. A pairing link from before the loader moved to
// /app/ still works. A device already paired stays on the site (it used to be
// sent on to /app/, so with my computer off the site never showed): its
// header button says it opens my own Oraknid.
(() => {
  let paired = false;
  try {
    if (location.pathname === "/" && location.hash.startsWith("#oraknid=")) {
      location.replace(`/app/${location.hash}`);
      return;
    }
    paired = !!localStorage.getItem("oraknid.away");
  } catch {}

  document.addEventListener("DOMContentLoaded", () => {
    if (paired)
      for (const label of document.querySelectorAll(".nav-open .wide"))
        label.textContent = " your Oraknid";
    // Copy the install commands, without the comments.
    for (const block of document.querySelectorAll("[data-copy]")) {
      const button = block.querySelector(".copy");
      const code = block.querySelector("code");
      button?.addEventListener("click", async () => {
        const text = [...code.childNodes]
          .filter((n) => !(n.nodeType === 1 && n.classList.contains("c")))
          .map((n) => n.textContent)
          .join("")
          .split("\n")
          .filter((l) => l.trim())
          .join("\n");
        try {
          await navigator.clipboard.writeText(text);
          button.querySelector("span").textContent = "Copied";
          setTimeout(() => (button.querySelector("span").textContent = "Copy"), 1600);
        } catch {}
      });
    }
    // Whether registering on this Nest needs an invite.
    const state = document.querySelector("[data-nest-state]");
    if (state)
      fetch("/info")
        .then((r) => (r.ok ? r.json() : null))
        .then((i) => {
          if (i?.mode === "public")
            state.textContent = i.inviteRequired
              ? "registering needs an invite"
              : "open to register";
        })
        .catch(() => {});
    // What the page shows arrives once, as it comes into view.
    const io =
      "IntersectionObserver" in window
        ? new IntersectionObserver(
            (entries) => {
              for (const e of entries)
                if (e.isIntersecting) {
                  e.target.classList.add("in");
                  io.unobserve(e.target);
                }
            },
            { threshold: 0, rootMargin: "0px 0px -8% 0px" },
          )
        : null;
    for (const el of document.querySelectorAll(".reveal"))
      io ? io.observe(el) : el.classList.add("in");
  });
})();
