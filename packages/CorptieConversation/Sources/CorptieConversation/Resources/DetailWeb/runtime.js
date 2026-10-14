(() => {
  "use strict";
  const root = document.getElementById("detail-root");
  let current = null, sequence = 0, scheduled = false;
  const post = (type, payload = {}) => {
    if (!current) return;
    window.webkit.messageHandlers.corptieDetail.postMessage({ type, instanceToken: current.instanceToken,
      dataStamp: current.dataStamp, layoutVersion: current.layoutVersion, sequence: ++sequence, payload });
  };
  const reportSize = () => {
    if (scheduled || !current) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      post("size", { height: Math.ceil(root.getBoundingClientRect().height) });
    });
  };
  const observer = new ResizeObserver(reportSize);
  observer.observe(root);
  globalThis.corptieDetailApply = update => {
    if (!update || typeof update.instanceToken !== "string" || typeof update.dataStamp !== "string") return;
    current = update;
    const fragment = document.createDocumentFragment();
    for (const section of (update.sections || []).slice(0, 20)) {
      const details = document.createElement("details"), heading = document.createElement("summary");
      heading.textContent = section.title || "详情";
      details.append(heading);
      details.open = update.expanded?.[section.id] === true;
      const body = document.createElement("div"), preview = document.createElement("div");
      body.className = "body"; preview.className = "preview";
      preview.textContent = section.preview || "";
      const populate = () => {
        body.textContent = details.open ? section.body || "" : "";
        preview.hidden = details.open;
      };
      populate(); details.append(body, preview);
      details.addEventListener("toggle", () => {
        if (!details.isConnected) return;
        populate(); post("presentation", { sectionID: section.id, expanded: details.open }); reportSize();
      });
      fragment.append(details);
    }
    const actions = document.createElement("div"); actions.className = "actions";
    for (const action of (update.actions || []).slice(0, 32)) {
      const button = document.createElement("button"); button.type = "button";
      button.textContent = action.label; button.disabled = action.enabled !== true;
      button.addEventListener("click", () => post("actionIntent", { actionID: action.id }));
      actions.append(button);
    }
    fragment.append(actions); root.replaceChildren(fragment);
    document.documentElement.dataset.scheme = update.scheme;
    document.documentElement.style.setProperty("--accent", update.accent);
    document.body.style.fontSize = update.textSize + "px";
    post("applied"); reportSize();
  };
  window.webkit.messageHandlers.corptieDetail.postMessage({ type: "ready" });
})();
