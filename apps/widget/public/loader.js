(function () {
  "use strict";

  // The <script> tag that loaded this file — read its data-* attributes.
  var thisScript = document.currentScript;
  var publicToken = thisScript.getAttribute("data-agent");
  var widgetOrigin = thisScript.getAttribute("data-widget-origin") || "http://localhost:5173";

  if (!publicToken) {
    console.error("[envoy] embed snippet is missing data-agent");
    return;
  }

  var LAUNCHER_SIZE = 56;
  var PANEL_WIDTH = 360;
  var PANEL_HEIGHT = 520;
  var MARGIN = 20;

  var launcher = document.createElement("button");
  launcher.setAttribute("aria-label", "Open chat");
  launcher.style.cssText = [
    "position:fixed",
    "bottom:" + MARGIN + "px",
    "right:" + MARGIN + "px",
    "width:" + LAUNCHER_SIZE + "px",
    "height:" + LAUNCHER_SIZE + "px",
    "border-radius:50%",
    "border:none",
    "background:#235a97",
    "color:#fff",
    "font-size:24px",
    "cursor:pointer",
    "box-shadow:0 4px 16px rgba(0,0,0,0.2)",
    "z-index:2147483000",
  ].join(";");
  launcher.textContent = "💬";

  // iframe isolation is deliberate: the widget's CSS/JS never touches the
  // host page's DOM, and the host page's CSS never leaks into the widget.
  var iframe = document.createElement("iframe");
  iframe.src = widgetOrigin + "/?token=" + encodeURIComponent(publicToken);
  iframe.title = "Chat widget";
  // Permissions-Policy's default microphone allowlist is "self" — it does NOT
  // propagate into a nested iframe without this explicit delegation, even
  // same-origin, or getUserMedia() throws NotAllowedError inside the widget.
  iframe.setAttribute("allow", "microphone");
  iframe.style.cssText = [
    "position:fixed",
    "bottom:" + (MARGIN + LAUNCHER_SIZE + 12) + "px",
    "right:" + MARGIN + "px",
    "width:" + PANEL_WIDTH + "px",
    "height:" + PANEL_HEIGHT + "px",
    "max-height:calc(100vh - " + (MARGIN * 2 + LAUNCHER_SIZE + 12) + "px)",
    "border:none",
    "border-radius:12px",
    "box-shadow:0 8px 32px rgba(0,0,0,0.25)",
    "z-index:2147483000",
    "display:none",
    "background:#fff",
  ].join(";");

  var open = false;
  launcher.addEventListener("click", function () {
    open = !open;
    iframe.style.display = open ? "block" : "none";
    launcher.textContent = open ? "✕" : "💬";
  });

  document.body.appendChild(iframe);
  document.body.appendChild(launcher);
})();
