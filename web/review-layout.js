/* Presentation only: source exploration never changes the conversation's offer. */
(() => {
  const $ = (id) => document.getElementById(id);
  const bridge = () => window.candocBatchBridge;
  let offer = null,
    reviewContext = null,
    sourceMode = "region",
    pageSignature,
    selectionSignature;
  const opt = (value, label) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    return o;
  };
  $("explore-navigation").append($("legacy-navigation"));
  $("explore-content").append($("diagnostic-panel"), $("worklist"), $("items"));
  $("editor-content").append(document.querySelector(".detail"));
  $("tools-actions").append(
    $("history"),
    $("conversation-previous"),
    $("conversation-next"),
  );
  $("conversation-next").textContent = "판단 없이 다음 문제";
  for (const id of ["conversation-previous", "conversation-next"])
    $(id).addEventListener("click", closeDialogs);
  $("technical-actions").append($("validate"));
  $("tools-dialog").append($("review-limit"));
  // Keep the old chat journal available as a read-only archive, with one composer.
  $("tools-dialog").insertAdjacentHTML(
    "beforeend",
    '<details id="legacy-chat-archive"><summary>이전 개별 대화 기록</summary><p>새 질문은 원본 근거의 “선택한 항목으로 새 질문”을 이용하세요.</p><div id="legacy-chat-records"></div></details>',
  );
  $("legacy-chat-records").append($("chat-transcript"));
  function closeDialogs() {
    for (const d of document.querySelectorAll("dialog[open]")) d.close();
  }
  function open(id) {
    closeDialogs();
    $(id).showModal();
  }
  function view(which) {
    document.body.dataset.mobileView = which;
    $("view-conversation").setAttribute(
      "aria-pressed",
      String(which === "conversation"),
    );
    $("view-evidence").setAttribute(
      "aria-pressed",
      String(which === "evidence"),
    );
  }
  function edit(expand = true) {
    if (!$("editor-dialog").open) open("editor-dialog");
    if (expand) $("editor").open = true;
  }
  function explore() {
    open("explore-dialog");
    $("issues").click();
  }
  $("explore-toggle").onclick = explore;
  $("tools-toggle").onclick = () => open("tools-dialog");
  $("manual-toggle").onclick = () => edit();
  $("history").addEventListener("click", closeDialogs);
  $("validate").addEventListener("click", closeDialogs);
  for (const b of document.querySelectorAll("[data-close]"))
    b.onclick = () => $(b.dataset.close).close();
  $("view-conversation").onclick = () => view("conversation");
  $("view-evidence").onclick = () => view("evidence");
  $("proposals").addEventListener("click", () => edit(false));
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-inspect]")) {
      closeDialogs();
      view("evidence");
    }
  });
  for (const id of ["items", "worklist-items"])
    $(id).addEventListener("click", (e) => {
      if (e.target.closest("[data-ref],[data-queue]")) {
        closeDialogs();
        view("evidence");
      }
    });
  function source(mode) {
    sourceMode = mode;
    document.querySelector(".source").dataset.view = mode;
    $("source-region").setAttribute("aria-pressed", String(mode === "region"));
    $("source-page").setAttribute("aria-pressed", String(mode === "page"));
  }
  $("source-region").onclick = () => source("region");
  $("source-page").onclick = () => source("page");
  $("zoom").addEventListener("input", () => {
    $("crop").style.width = $("zoom").value + "%";
    $("zoom-value").value = $("zoom").value + "%";
  });
  async function navigateTarget(index) {
    const targets =
      offer?.proposal.targets ||
      (offer
        ? [{ ref: offer.context.ref, page: offer.context.locations?.[0]?.page }]
        : []);
    const t = targets[index];
    if (!t) return;
    await bridge().navigate(
      t.page || 1,
      t.ref,
      offer.proposal.request?.cell ?? null,
    );
    source("region");
    sync();
  }
  function currentIndex() {
    return offer?.refs.indexOf(bridge().context()?.ref) ?? -1;
  }
  $("evidence-previous").onclick = () =>
    navigateTarget(currentIndex() - 1).catch(error);
  $("evidence-next").onclick = () =>
    navigateTarget(currentIndex() + 1).catch(error);
  $("evidence-return").onclick = () => navigateTarget(0).catch(error);
  function error(e) {
    $("evidence-context").textContent = e.message;
  }
  $("evidence-item").onchange = () =>
    bridge()
      .navigate(bridge().page().page, $("evidence-item").value, null)
      .then(sync)
      .catch(error);
  $("evidence-cell").onchange = () => {
    const c = $("evidence-cell").value;
    bridge()
      .navigate(
        bridge().page().page,
        bridge().context().ref,
        c === "" ? null : Number(c),
      )
      .then(sync)
      .catch(error);
  };
  $("ask-selection").onclick = () => {
    if (!bridge().context()?.ref) return;
    $("conversation-inspect").checked = true;
    $("conversation-inspect").dispatchEvent(new Event("change"));
    view("conversation");
    $("conversation-input").focus();
  };
  function sync() {
    const selected = bridge().selection(),
      p = bridge().page(),
      c = bridge().context();
    const index = currentIndex(),
      count = offer?.refs.length || 0;
    const sameCell =
      offer?.proposal.request?.cell == null ||
      offer.proposal.request.cell === (c?.cell ?? null);
    const matches = index >= 0 && sameCell;
    const cell =
      selected?.cell == null
        ? null
        : selected.info.item.data.table_cells[selected.cell];
    $("evidence-title").textContent = selected
      ? `${selected.page}쪽 · ${!cell ? "원본 영역" : `표 ${cell.start_row_offset_idx + 1}행 ${cell.start_col_offset_idx + 1}열`}`
      : "제안이 도착하면 원본을 함께 보여드립니다";
    $("evidence-case").textContent = offer
      ? matches
        ? `전체 ${count}개 중 ${index + 1}번째 사례`
        : `승인 범위 ${count}개 · 다른 항목 탐색 중`
      : "선택한 원본";
    $("evidence-context").textContent = offer
      ? !selected
        ? "제안에 연결된 원본을 불러오는 중입니다."
        : matches
          ? cell && offer.proposal.request?.cell == null
            ? "표 전체에 대한 제안 중 진단에 관련된 셀을 보고 있습니다. 승인 범위는 왼쪽 카드에서 확인하세요."
            : "왼쪽 수정안에 포함된 원본입니다. 대표 확인이 전체 개별 검수를 뜻하지 않습니다."
          : "다른 항목을 보고 있습니다. 왼쪽 수정안과 승인 범위는 그대로입니다."
      : reviewContext?.ref
        ? reviewContext.ref === c?.ref
          ? "현재 대화에서 확인 중인 원본입니다. 아직 승인할 수정안은 없습니다."
          : "다른 원본을 탐색 중입니다. 대화의 대상은 바뀌지 않습니다."
        : "검수를 시작하거나 문서 탐색에서 항목을 선택하세요.";
    $("evidence-context").classList.toggle("exploring", !!offer && !matches);
    $("evidence-return").hidden = !offer || matches;
    $("evidence-previous").disabled = !offer || index <= 0;
    $("evidence-next").disabled = !offer || index < 0 || index >= count - 1;
    $("ask-selection").disabled = !c?.ref;
    $("evidence-selection").textContent = c?.ref
      ? "새 질문으로 전환할 때만 대화 대상이 바뀝니다."
      : "";
    const pageKey = p ? `${p.page}:${p.revision}` : "";
    if (p && pageKey !== pageSignature) {
      $("evidence-item").replaceChildren(
        opt("", "항목 선택"),
        ...p.items.map((i, n) =>
          opt(
            i.ref,
            `${n + 1}. ${i.text?.slice(0, 65) || { table: "표", picture: "그림" }[i.label] || "문서 항목"}`,
          ),
        ),
      );
      pageSignature = pageKey;
    }
    if (c?.ref) $("evidence-item").value = c.ref;
    const selectionKey = c ? `${c.ref}:${c.revision}` : "";
    if (selectionKey !== selectionSignature) {
      const cells = selected?.info.item.data?.table_cells;
      $("evidence-cell-label").hidden = !cells;
      $("evidence-cell").replaceChildren(
        opt("", "표 전체"),
        ...(cells || []).map((cell, i) =>
          opt(
            String(i),
            `행 ${cell.start_row_offset_idx + 1}, 열 ${cell.start_col_offset_idx + 1} · ${cell.text.slice(0, 45)}`,
          ),
        ),
      );
      selectionSignature = selectionKey;
    }
    $("evidence-cell").value = c?.cell == null ? "" : String(c.cell);
  }
  window.candocWorkspace = {
    edit,
    explore,
    close: closeDialogs,
    view,
    source,
    sync,
    evidence(value, context) {
      offer = value;
      reviewContext = context;
      sync();
    },
  };
  window.addEventListener("candoc-selection", sync);
  window.addEventListener("candoc-refreshed", sync);
  $("page-image").addEventListener("load", sync);
  source("region");
  view("conversation");
})();
