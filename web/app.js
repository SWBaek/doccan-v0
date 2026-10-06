const $ = (id) => document.getElementById(id);
const states = {
  unreviewed: "미확인",
  kept: "유지 승인",
  deferred: "보류 · 남은 확인 필요",
  corrected_partial: "부분 교정 · 나머지 미확인",
};
let session,
  pageNo = 1,
  selected = null,
  selectedCell = null,
  locationIndex = 0,
  pageData = null;
let generation = 0,
  loading = true,
  intent = { page: 1, ref: null, cell: null },
  proposals = [],
  activeProposal = null;
let decisionBusy = false,
  proposalBusy = false,
  pollGeneration = 0,
  queueGeneration = 0;
let storageKey,
  saved = { drafts: {}, worklist: null },
  worklist = null,
  draft = null;
const scopeOf = (ref, cell = null) =>
  ref + (cell === null ? "" : `/cells/${cell}`);
const targetValue = (info, cell) =>
  cell === null
    ? (info.item.text ??
      (info.item.data?.table_cells
        ? info.item.data.table_cells
            .map((c, i) => `셀 ${i}: ${c.text}`)
            .join("\n")
        : info.item.label))
    : info.item.data.table_cells[cell].text;
const targetName = (item, cell = null) =>
  cell === null
    ? item.data?.table_cells
      ? "표 전체"
      : item.label
    : `표 셀 ${cell} · 행 ${item.data.table_cells[cell].start_row_offset_idx + 1}, 열 ${item.data.table_cells[cell].start_col_offset_idx + 1}`;
const sameTarget = (ref, cell) =>
  !loading &&
  selected?.item.self_ref === ref &&
  selectedCell === (cell ?? null);
const escapeHTML = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function message(text, error = false) {
  $("message").textContent = text;
  $("message").className = error ? "error" : "";
}
async function api(path, body) {
  const r = await fetch(
    "/api/" + path,
    body
      ? {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Candoc-Token": session.token,
          },
          body: JSON.stringify(body),
        }
      : {},
  );
  const result = await r.json();
  if (!r.ok) {
    const error = Error(result.error || r.statusText);
    error.details = result;
    throw error;
  }
  return result;
}
function run(fn) {
  return (...args) =>
    Promise.resolve(fn(...args)).catch((e) => message(e.message, true));
}
function showExport(status) {
  // An already-running old backend must be restarted by its owner, not silently
  // treated as having the new save-state protocol.
  $("export-warning").hidden = status?.state === "synced";
  $("reexport").hidden = !status;
  $("export-detail").textContent = status
    ? '승인한 변경은 저장되어 있습니다. 문서 파일 내보내기를 다시 시도하세요. 재승인할 필요는 없습니다.'
    : '저장 상태를 확인하려면 업데이트된 서버를 재시작해야 합니다.';
  $("export-technical").textContent = status
    ? `DB revision ${status.db_revision} 반영 완료 · JSON 내보내기 미완료. ` +
      Object.entries(status.files)
        .map(
          ([name, revision]) =>
            `${name}: ${revision === null ? "미확인" : `revision ${revision}`}`,
        )
        .join(" / ") +
      ` · ${Object.values(status.errors).join(" / ")}`
    : "저장 상태 확인을 위해 업데이트된 서버를 재시작해야 합니다.";
}
function decisionMessage(result, success) {
  message(
    result.export?.state === "pending"
      ? `revision ${result.seq} DB 반영은 완료됐습니다. JSON 내보내기는 미완료입니다. 재승인하지 말고 재내보내기를 사용하세요.`
      : success,
  );
}
function persist() {
  if (!storageKey) return;
  saved.worklist = worklist;
  try {
    localStorage.setItem(storageKey, JSON.stringify(saved));
  } catch {
    message(
      "브라우저 저장 공간에 초안을 보관하지 못했습니다. 이 창을 닫기 전에 작성 내용을 복사하세요.",
      true,
    );
  }
}
function remember() {
  const q = new URLSearchParams({ page: String(pageNo) });
  if (selected) {
    q.set("ref", selected.item.self_ref);
    if (selectedCell !== null) q.set("cell", selectedCell);
    q.set("loc", locationIndex);
  }
  saved.location = Object.fromEntries(q);
  history.replaceState(null, "", "#" + q);
  persist();
  window.dispatchEvent(new Event("candoc-selection"));
}
window.candocChatContext = () =>
  !loading && session
    ? {
        asset_id: session.asset.asset_id,
        revision: selected?.revision ?? session.revision,
        ref: selected?.item.self_ref ?? null,
        cell: selectedCell,
        ...(window.candocGroupContext?.(selected?.item.self_ref) || {}),
      }
    : null;
window.candocDraftReady = () => !loading && (!draft || !draftStale());
window.candocSetChatDraft = (value) => {
  if (!loading) {
    if (draft) draft.chat = value;
    else saved.documentChat = value;
    persist();
  }
};
window.candocClearSentDraft = (context, value) => {
  if (context.ref === null) {
    if (saved.documentChat === value) {
      saved.documentChat = "";
      persist();
      if (!selected) $("chat-input").value = "";
    }
    return;
  }
  const d = saved.drafts[scopeOf(context.ref, context.cell)];
  if (d?.chat === value) {
    d.chat = "";
    persist();
    if (d === draft) $("chat-input").value = "";
  }
};
function basis(info) {
  return {
    item: info.item,
    reviews: info.reviews,
    version: info.target_version,
    revision: info.revision,
  };
}
function hasDraft(d) {
  return d && (d.edited || d.reason || d.chat || d.pending);
}
function draftStale() {
  return (
    hasDraft(draft) &&
    (JSON.stringify(draft.base.item) !== JSON.stringify(selected?.item) ||
      draft.base.version !== selected?.target_version ||
      JSON.stringify(draft.base.reviews) !== JSON.stringify(selected?.reviews))
  );
}
function bindDraft() {
  const key = scopeOf(selected.item.self_ref, selectedCell);
  draft = saved.drafts[key];
  if (!draft || !hasDraft(draft))
    draft = saved.drafts[key] = {
      ref: selected.item.self_ref,
      cell: selectedCell,
      base: basis(selected),
      value: targetValue(selected, selectedCell),
      reason: "",
      chat: "",
      edited: false,
    };
  $("edit-value").value = draft.value;
  $("reason").value = draft.reason;
  $("chat-input").value = draft.chat;
  updateDraftUI();
}
function updateDraftUI() {
  const stale = selected && draftStale();
  $("draft-warning").hidden = !stale;
  if (stale)
    $("draft-base").textContent = JSON.stringify(
      {
        target: scopeOf(draft.ref, draft.cell),
        revision: draft.base.revision,
        content: targetValue({ item: draft.base.item }, draft.cell),
        reviews: draft.base.reviews,
      },
      null,
      2,
    );
  $("draft-status").textContent = draft?.pending
    ? "등록 응답을 확인하지 못했습니다. 같은 요청 ID로 결과를 확인하세요."
    : draft?.submitted
      ? "제안으로 등록했습니다. 제안 검토에서 별도로 승인하세요."
      : "초안은 이 브라우저에 대상·기준 내용과 함께 저장합니다.";
  $("manual-propose").textContent = draft?.pending
    ? "등록 결과 확인·재시도"
    : "수정 제안 등록";
  updateActions();
  window.dispatchEvent(new Event("candoc-selection"));
}
function updateActions() {
  updateProposalTargetNote();
  const blocked = loading || !selected || decisionBusy || proposalBusy;
  const stale = selected && draftStale();
  for (const id of ["keep", "defer", "manual-propose"])
    $(id).disabled =
      blocked || !!stale || (!!draft?.pending && id !== "manual-propose");
  if (!draft?.pending)
    $("manual-propose").disabled ||=
      !selected?.capability?.op ||
      draft?.value === (selected ? targetValue(selected, selectedCell) : null);
  for (const id of ["edit-value", "reason"])
    $(id).disabled = blocked || !!draft?.pending;
  document.querySelectorAll("#proposal-content [data-approve]").forEach((b) => {
    const p = proposals.find((p) => p.id === b.dataset.approve);
    b.disabled =
      decisionBusy ||
      !p ||
      p.status !== "pending" ||
      !sameTarget(p.request.ref, p.request.cell);
  });
  document
    .querySelectorAll(
      "#proposal-content [data-reject], #proposal-content [data-repropose], #dialog-content button, #reexport",
    )
    .forEach((b) => (b.disabled = decisionBusy));
}
function setDecisionBusy(value) {
  decisionBusy = value;
  updateActions();
}
function openDialog(title, html) {
  $("dialog-title").textContent = title;
  $("dialog-content").innerHTML = html;
  updateActions();
  if (!$("dialog").open) $("dialog").showModal();
}
async function bootstrap() {
  session = await api("bootstrap");
  if (!session.workspace_id)
    throw Error(
      "연속 검수 UI를 사용하려면 실행 중인 서버를 종료한 뒤 start.ps1로 다시 시작하세요.",
    );
  $("asset").textContent =
    `${session.pages.length}페이지 · 원본 대조 검수`;
  $("document-name").textContent = session.document_name || session.asset.archive_name;
  $("asset").title = `${session.asset.asset_id} · revision ${session.revision}`;
  $("total").textContent = "/ " + session.pages.length;
  $("page").max = session.pages.at(-1);
  showExport(session.export);
}
function clearSelection() {
  selected = null;
  selectedCell = null;
  draft = null;
  loading = true;
  $("selection").hidden = true;
  $("selection-empty").hidden = false;
  $("selection-empty").textContent = "선택 대상을 읽는 중…";
  $("boxes").replaceChildren();
  $("crop").hidden = true;
  $("location-note").textContent =
    "대상을 읽는 중입니다. 이전 원본 영역을 사용하지 않습니다.";
  document
    .querySelectorAll(".selected,.selected-cell")
    .forEach((el) => el.classList.remove("selected", "selected-cell"));
  $("chat-input").value = "";
  updateActions();
  window.dispatchEvent(new Event("candoc-selection"));
}
async function navigate(
  number,
  ref = null,
  cell = null,
  wantedLocation = null,
  force = false,
) {
  number = Number(number);
  if (!session.pages.includes(number))
    throw Error("유효한 페이지 번호를 입력하세요.");
  const request = ++generation;
  intent = { page: number, ref, cell, loc: wantedLocation };
  clearSelection();
  try {
    let info = null;
    if (ref) {
      const q = new URLSearchParams({ ref });
      if (cell !== null) q.set("cell", cell);
      info = await api("item?" + q);
      if (request !== generation) return;
      const displayLocations = info.locations.length
        ? info.locations
        : info.item.prov?.map((p) => ({ page: p.page_no })) || [];
      if (wantedLocation !== null && info.locations[wantedLocation])
        number = info.locations[wantedLocation].page;
      else if (
        displayLocations.length &&
        !displayLocations.some((l) => l.page === number)
      )
        number = displayLocations[0].page;
    }
    if (
      force ||
      !pageData ||
      pageNo !== number ||
      (info && pageData.revision !== info.revision)
    ) {
      const result = await api("page?page=" + number);
      if (request !== generation) return;
      // If a concurrent approval changed the page between reads, obtain a coherent
      // target and page again. It is still guarded by the same user-intent epoch.
      if (info && result.revision !== info.revision) {
        return navigate(number, ref, cell, wantedLocation, true);
      }
      pageData = result;
      pageNo = number;
      $("items").innerHTML = result.items
        .map(
          (i) =>
            `<article class="item" tabindex="0" data-ref="${escapeHTML(i.ref)}"><div class="meta">${escapeHTML(i.label)}</div>${i.html}</article>`,
        )
        .join("");
      $("item-count").textContent = result.items.length + "개 항목";
      $("page-image").hidden = true;
      $("page-image").src = result.image;
      $("page-image").alt = `원본 ${pageNo}페이지`;
      document.querySelectorAll("#items [data-cell]").forEach((c) => {
        c.tabIndex = 0;
        c.setAttribute("aria-label", `셀 ${c.dataset.cell}: ${c.textContent}`);
      });
    }
    pageNo = number;
    $("page").value = number;
    loading = false;
    selected = info;
    selectedCell = cell;
    intent = { page: number, ref, cell, loc: wantedLocation };
    if (info) renderSelection(wantedLocation);
    else {
      $("selection-empty").textContent =
        "문단·표·그림 또는 작업 목록의 대상을 선택하세요.";
      $("chat-input").value = saved.documentChat || "";
    }
    remember();
    drawLocation();
    renderWorklist();
    $("worklist-items")
      .querySelector(".active")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    updateActions();
    message(`${pageNo}페이지 · 항목 이동은 검수 판단으로 기록하지 않습니다.`);
  } catch (error) {
    if (request !== generation) return;
    $("selection-empty").textContent =
      "선택을 읽지 못했습니다. 항목을 다시 선택하거나 새로고침하세요.";
    message(error.message, true);
    throw error;
  }
}
const loadPage = (n, ref = null, cell = null) => navigate(n, ref, cell);
const selectItem = (ref, cell = null) => navigate(pageNo, ref, cell);
function renderSelection(wantedLocation) {
  const info = selected,
    item = info.item,
    cell = selectedCell,
    ref = item.self_ref;
  locationIndex =
    wantedLocation !== null && info.locations[wantedLocation]
      ? wantedLocation
      : Math.max(
          0,
          info.locations.findIndex((l) => l.page === pageNo),
        );
  $("selection").hidden = false;
  $("selection-empty").hidden = true;
  $("target-title").textContent = targetName(item, cell);
  $("ref").textContent = ref;
  $("selected-meta").textContent = `${item.label} · revision ${info.revision}`;
  $("cell-label").hidden = !item.data?.table_cells;
  if (item.data?.table_cells) {
    $("cell").innerHTML =
      '<option value="">표 전체</option>' +
      item.data.table_cells
        .map(
          (c, i) =>
            `<option value="${i}">셀 ${i} · 행 ${c.start_row_offset_idx + 1}, 열 ${c.start_col_offset_idx + 1} · ${escapeHTML(c.text.slice(0, 45))}</option>`,
        )
        .join("");
    $("cell").value = cell === null ? "" : String(cell);
  }
  $("location-label").hidden = info.locations.length < 2;
  $("location").innerHTML = info.locations
    .map(
      (l, i) => `<option value="${i}">영역 ${i + 1} · ${l.page}페이지</option>`,
    )
    .join("");
  $("location").value = locationIndex;
  $("review-state").textContent = "검수 상태: " + states[info.review_state];
  $("current-value").textContent = targetValue(info, cell);
  $("edit-limitation").textContent =
    info.capability.reason ||
    "원본을 대조해 수정안을 작성하세요. 등록만으로 문서는 바뀌지 않습니다.";
  $("edit-label").hidden = !info.capability.op;
  $("item-json").textContent = JSON.stringify(
    cell === null ? item : item.data.table_cells[cell],
    null,
    2,
  );
  $("request-text").value =
    `CanDoc 교정 요청\n서버: ${location.origin}\nAsset: ${info.asset_id}\nrevision: ${info.revision}\n항목: ${ref}${cell === null ? "" : `\n표 셀 index: ${cell}`}\n원본과 비교할 의심 이유와 수정안을 설명하고, 승인 전에는 적용하지 마세요.`;
  let card;
  document.querySelectorAll("#items .item").forEach((el) => {
    const yes = el.dataset.ref === ref;
    el.classList.toggle("selected", yes);
    if (yes) card = el;
    el.querySelectorAll("[data-cell]").forEach((c) =>
      c.classList.toggle(
        "selected-cell",
        yes && Number(c.dataset.cell) === cell,
      ),
    );
  });
  (card?.querySelector(".selected-cell") || card)?.scrollIntoView({
    block: "nearest",
    inline: "nearest",
  });
  if (cell !== null && !card?.querySelector(".selected-cell"))
    $("edit-limitation").textContent +=
      " · 격자에 표시되지 않는 셀입니다. 셀 목록과 위 현재 내용으로 확인하세요.";
  bindDraft();
}
async function refresh() {
  const epoch = generation,
    target = { ...intent };
  await bootstrap();
  if (epoch === generation)
    await navigate(target.page, target.ref, target.cell, target.loc, true);
  renderWorklist();
  await poll();
  window.dispatchEvent(new Event("candoc-refreshed"));
}
function drawLocation() {
  $("boxes").innerHTML = "";
  $("crop").hidden = true;
  if (!selected) return;
  const loc = selected.locations[locationIndex];
  if (!loc) {
    $("location-note").textContent =
      selectedCell === null
        ? "원본 위치 연결이 없는 항목입니다. 최초 데이터 확인 후 보류할 수 있습니다."
        : "셀 bbox 없음 또는 여러 페이지 표: 원본 위치를 추정하지 않습니다. 표 전체를 선택해 확인하세요.";
    return;
  }
  if (loc.page !== pageNo) return;
  const { rect: r, size: s } = loc;
  const img = $("page-image");
  if (!img.complete || !img.naturalWidth) {
    $("location-note").textContent = "원본 페이지 이미지를 불러오는 중…";
    return;
  }
  $("boxes").innerHTML =
    `<div class="bbox selected-box" style="left:${(100 * r.x) / s.width}%;top:${(100 * r.y) / s.height}%;width:${(100 * r.width) / s.width}%;height:${(100 * r.height) / s.height}%"></div>`;
  $("location-note").textContent = `${loc.page}페이지 · 선택한 원본 영역`;
  $("location-note").title =
    `${loc.bbox.coord_origin} → TOPLEFT · (${r.x.toFixed(1)}, ${r.y.toFixed(1)}) ${r.width.toFixed(1)} × ${r.height.toFixed(1)}`;
  $("boxes").firstElementChild?.scrollIntoView({
    block: "nearest",
    inline: "nearest",
  });
  if (!img.complete || !img.naturalWidth) return;
  const scaleX = img.naturalWidth / s.width,
    scaleY = img.naturalHeight / s.height,
    padX = 90, padY = 28;
  const x = Math.max(0, (r.x - padX) * scaleX),
    y = Math.max(0, (r.y - padY) * scaleY),
    w = Math.min(img.naturalWidth - x, (r.width + 2 * padX) * scaleX),
    h = Math.min(img.naturalHeight - y, (r.height + 2 * padY) * scaleY);
  if (w <= 0 || h <= 0) return;
  const canvas = $("crop");
  canvas.width = Math.ceil(w);
  canvas.height = Math.ceil(h);
  canvas.getContext("2d").drawImage(img, x, y, w, h, 0, 0, w, h);
  const context = canvas.getContext("2d");
  context.strokeStyle = '#bf6216';
  context.lineWidth = 2;
  context.strokeRect(r.x * scaleX - x, r.y * scaleY - y, r.width * scaleX, r.height * scaleY);
  canvas.hidden = false;
  requestAnimationFrame(() =>
    $("boxes").firstElementChild?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    }),
  );
}
function diffValue(p, item) {
  if (p.request.cell != null) return item.data.table_cells[p.request.cell].text;
  if (p.request.op === "type")
    return JSON.stringify({ label: item.label, level: item.level }, null, 2);
  return targetValue({ item }, null);
}
function diffMarkup(before, after) {
  before = String(before);
  after = String(after);
  // Common for long paragraphs: additions/removals around an unchanged body.
  // Preserve that body without allocating a quadratic comparison matrix.
  const inserted = before ? after.indexOf(before) : -1;
  if (inserted >= 0)
    return [
      escapeHTML(before),
      "<ins>" +
        escapeHTML(after.slice(0, inserted)) +
        "</ins>" +
        escapeHTML(before) +
        "<ins>" +
        escapeHTML(after.slice(inserted + before.length)) +
        "</ins>",
    ];
  const removed = after ? before.indexOf(after) : -1;
  if (removed >= 0)
    return [
      "<del>" +
        escapeHTML(before.slice(0, removed)) +
        "</del>" +
        escapeHTML(after) +
        "<del>" +
        escapeHTML(before.slice(removed + after.length)) +
        "</del>",
      escapeHTML(after),
    ];
  const tokenize = (value) =>
    String(value).match(/\s+|[\p{L}\p{N}\p{M}_]+|[^\s]/gu) || [];
  const left = tokenize(before),
    right = tokenize(after);
  let prefix = 0,
    suffix = 0;
  while (
    prefix < left.length &&
    prefix < right.length &&
    left[prefix] === right[prefix]
  )
    prefix++;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  )
    suffix++;
  const a = left.slice(prefix, left.length - suffix),
    b = right.slice(prefix, right.length - suffix);
  const head = escapeHTML(left.slice(0, prefix).join("")),
    tail = escapeHTML(suffix ? left.slice(-suffix).join("") : "");
  // Bound work for very large cells. Exact full text is retained even when the
  // highlighted region must be coarser than a word-level LCS.
  if (a.length * b.length > 250000)
    return [
      head + "<del>" + escapeHTML(a.join("")) + "</del>" + tail,
      head + "<ins>" + escapeHTML(b.join("")) + "</ins>" + tail,
    ];
  const matrix = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      matrix[i][j] =
        a[i] === b[j]
          ? matrix[i + 1][j + 1] + 1
          : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
  let i = 0,
    j = 0,
    old = head,
    changed = head;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      old += escapeHTML(a[i]);
      changed += escapeHTML(b[j]);
      i++;
      j++;
    } else if (
      j === b.length ||
      (i < a.length && matrix[i + 1][j] >= matrix[i][j + 1])
    )
      old += "<del>" + escapeHTML(a[i++]) + "</del>";
    else changed += "<ins>" + escapeHTML(b[j++]) + "</ins>";
  }
  return [old + tail, changed + tail];
}
function proposalLabel(p) {
  return `${p.status === "stale" ? "재검토 필요" : p.status === "pending" ? "승인 대기" : p.status === "applied" ? (p.undone_revision ? "승인 후 되돌림" : "승인 완료") : p.status === "rejected" ? "거절" : "새 제안으로 대체"} · ${targetName(p.before, p.request.cell ?? null)} · ${diffValue(p, p.after).slice(0, 48)}`;
}
function updateProposalChoice() {
  const choice = $("proposal-choice"),
    keep = activeProposal;
  const list = proposals.filter(
    (p) => ["pending", "stale"].includes(p.status) || p.id === keep,
  );
  choice.innerHTML = list
    .map(
      (p) => `<option value="${p.id}">${escapeHTML(proposalLabel(p))}</option>`,
    )
    .join("");
  choice.value = keep || "";
}
function renderProposal() {
  const p = proposals.find((p) => p.id === activeProposal);
  const container = $("proposal-content");
  if (!p) {
    container.innerHTML =
      "<p>대기 중인 제안이 없습니다. 아래에서 직접 수정안을 작성할 수 있습니다.</p>";
    return;
  }
  // An unrelated revision or a newly arrived proposal never replaces this DOM.
  const meaningful = JSON.stringify([
    p.id,
    p.status,
    p.current_before,
    p.undone_revision,
  ]);
  if (container.dataset.signature === meaningful) {
    const retry = container.querySelector("[data-repropose]");
    if (retry) retry.dataset.revision = p.current_revision;
    updateActions();
    return;
  }
  const scroller = $("proposal-review").parentElement,
    scroll = scroller.scrollTop;
  const focused = document.activeElement?.dataset;
  const focusKey = focused?.approve
    ? "approve"
    : focused?.repropose
      ? "repropose"
      : focused?.reject
        ? "reject"
        : null;
  const [before, after] = diffMarkup(
    diffValue(p, p.before),
    diffValue(p, p.after),
  );
  container.dataset.signature = meaningful;
  container.innerHTML = `<section class="proposal" data-proposal="${p.id}" data-status="${p.status}">
    <p class="status">${escapeHTML(targetName(p.before, p.request.cell ?? null))} · ${escapeHTML(proposalLabel(p).split(" · ")[0])}</p>
    <p class="reason"><strong>이유</strong> ${escapeHTML(p.request.reason)}</p>
    <div class="diff"><div><strong>제안 당시 내용</strong><pre>${before}</pre></div><div><strong>${p.request.op === "keep" ? "유지 판단" : p.request.op === "defer" ? "보류 판단" : "제안된 변경"}</strong><pre>${after}</pre></div></div>
    ${p.status === "stale" ? `<p class="stale-note">${escapeHTML(p.stale_reason)}</p><strong>최신 내용</strong><pre class="latest-value">${escapeHTML(diffValue(p, p.current_before))}</pre>` : ""}
    <p class="muted">${p.undone_revision ? "이 승인은 되돌렸습니다. 표시된 변경 후 내용은 당시 제안이며 현재 확정 내용이 아닙니다." : "원본은 옆 패널에서 대조하세요. 이 제안만 확정하며 전체 검수 완료로 처리하지 않습니다."}</p>
    <div class="actions proposal-actions"><button data-view="${escapeHTML(p.request.ref)}" data-view-cell="${p.request.cell ?? ""}">이 제안의 원본 확인</button>
    ${p.status === "pending" ? `<button class="primary" data-approve="${p.id}">이 제안 승인·적용</button>` : p.status === "stale" ? `<button data-repropose="${p.id}" data-revision="${p.current_revision}">최신 내용으로 새 제안 만들기</button>` : ""}
    ${["pending", "stale"].includes(p.status) ? `<button data-reject="${p.id}">거절</button>` : ""}</div>
    <p id="proposal-target-note" class="muted"></p>
    <details><summary>제안 식별자·기준 데이터</summary><p>${escapeHTML(p.scope)} · 제안 ${p.id} · 기준 revision ${p.request.revision}</p><pre>${escapeHTML(JSON.stringify(p.before, null, 2))}</pre></details></section>`;
  scroller.scrollTop = scroll;
  if (focusKey)
    container
      .querySelector(`[data-${focusKey}]`)
      ?.focus({ preventScroll: true });
  updateActions();
}
let proposalRead = 0,
  proposalApplied = 0,
  proposalView = 0;
async function readProposals() {
  const request = ++proposalRead;
  const list = await api("proposals");
  if (request > proposalApplied) {
    proposals = list;
    proposalApplied = request;
  }
  return proposals;
}
async function showProposals(list = null, id = null, align = true) {
  window.candocOpenDocument?.();
  if (align) window.candocWorkspace?.edit(false);
  const epoch = generation,
    view = ++proposalView;
  if (list) proposals = list;
  else await readProposals();
  if (view !== proposalView) return;
  if (id) activeProposal = id;
  if (!activeProposal || !proposals.some((p) => p.id === activeProposal))
    activeProposal =
      proposals.find((p) => ["pending", "stale"].includes(p.status))?.id ??
      null;
  saved.proposal = activeProposal;
  saved.proposalOpen = true;
  persist();
  $("proposal-review").hidden = false;
  $("proposal-updates").textContent = "";
  updateProposalChoice();
  renderProposal();
  const p = proposals.find((p) => p.id === activeProposal);
  if (
    epoch === generation &&
    align &&
    p &&
    !sameTarget(p.request.ref, p.request.cell)
  )
    await selectItem(p.request.ref, p.request.cell ?? null);
  if (
    view === proposalView &&
    (!align || sameTarget(p?.request.ref, p?.request.cell))
  )
    $("proposal-review").scrollIntoView({ block: "start" });
  updateActions();
}
async function poll() {
  const epoch = ++pollGeneration;
  const oldIds = new Set(proposals.map((p) => p.id));
  const list = await readProposals();
  if (epoch !== pollGeneration) return;
  const added = list.filter((p) => !oldIds.has(p.id)).length;
  proposals = list;
  $("pending-count").textContent =
    list.filter((p) => p.status === "pending").length +
    ` · 재검토 ${list.filter((p) => p.status === "stale").length}`;
  if (!$("proposal-review").hidden) {
    updateProposalChoice();
    renderProposal();
    if (added)
      $("proposal-updates").textContent =
        `새 제안 ${added}건이 있습니다. 현재 검토는 유지했습니다. 위 목록에서 선택하세요.`;
  }
  renderWorklist();
  if (session.export) showExport(await api("export-status"));
}
async function submitProposal(op) {
  if (loading || !selected || decisionBusy || proposalBusy || draftStale())
    return;
  const d = draft,
    context = { ref: selected.item.self_ref, cell: selectedCell },
    epoch = generation;
  if (!d.pending) {
    if (!d.reason.trim()) throw Error("수정·유지·보류 이유를 입력하세요.");
    const body = {
      asset_id: session.asset.asset_id,
      revision: selected.revision,
      ref: context.ref,
      op,
      reason: d.reason,
    };
    if (context.cell !== null) body.cell = context.cell;
    if (op === "cell" || op === "text") body.value = d.value;
    const fingerprint = JSON.stringify(body);
    if (d.submitted === fingerprint) {
      await showProposals(null, d.proposalId);
      return;
    }
    d.pending = { ...body, request_id: crypto.randomUUID() };
    persist();
  }
  proposalBusy = true;
  updateActions();
  try {
    const p = await api("propose", d.pending);
    const { request_id, ...body } = d.pending;
    d.submitted = JSON.stringify(body);
    d.proposalId = p.id;
    delete d.pending;
    persist();
    await poll();
    if (epoch === generation) {
      await showProposals(proposals, p.id, false);
      updateDraftUI();
    }
    message(
      "제안을 등록했습니다. 원본과 변경 전후를 확인하고 별도로 승인하세요.",
    );
  } catch (error) {
    if (error.details) {
      delete d.pending;
      persist();
    }
    if (epoch === generation) updateDraftUI();
    throw error;
  } finally {
    proposalBusy = false;
    updateActions();
  }
}
async function proposalAction(e) {
  const b = e.target.closest("button");
  if (!b || decisionBusy) return;
  if (b.dataset.view) {
    const cell = b.dataset.viewCell === "" ? null : Number(b.dataset.viewCell);
    if (sameTarget(b.dataset.view, cell)) drawLocation();
    else await selectItem(b.dataset.view, cell);
    return;
  }
  const id = b.dataset.approve || b.dataset.reject || b.dataset.repropose;
  if (!id || id !== activeProposal) return;
  const p = proposals.find((p) => p.id === id);
  if (
    b.dataset.approve &&
    (!p || p.status !== "pending" || !sameTarget(p.request.ref, p.request.cell))
  )
    return;
  setDecisionBusy(true);
  try {
    let result;
    if (b.dataset.repropose) {
      result = await api("repropose", {
        id,
        revision: Number(b.dataset.revision),
      });
      activeProposal = result.id;
    } else
      result = await api("decision", {
        id,
        action: b.dataset.approve ? "approve" : "reject",
      });
    await refresh();
    updateProposalChoice();
    renderProposal();
    decisionMessage(
      result,
      b.dataset.repropose
        ? "최신 내용으로 새 제안을 만들었습니다. 새 변경 전후를 확인하고 별도로 승인하세요."
        : "판단을 저장했습니다. 같은 작업 목록에서 다음 대상을 선택하세요.",
    );
  } catch (error) {
    try {
      await refresh();
    } catch {}
    throw error;
  } finally {
    setDecisionBusy(false);
  }
}
// Review status is derived from recorded judgments; proposal status is separate.
function reviewState(ref, cell = null) {
  const reviews = session.reviews,
    own = reviews[scopeOf(ref, cell)] || { state: "unreviewed", revision: -1 };
  if (cell !== null) return own.state;
  const later = Object.entries(reviews)
    .filter(
      ([k, v]) => k.startsWith(ref + "/cells/") && v.revision > own.revision,
    )
    .map(([, v]) => v);
  if (later.some((v) => v.state === "deferred")) return "deferred";
  if (later.some((v) => v.state === "corrected_partial"))
    return "corrected_partial";
  return own.state;
}
function queueItems() {
  if (!worklist) return [];
  return worklist.items.filter(
    (i) =>
      worklist.filter === "all" ||
      (worklist.filter === "kept") ===
        (reviewState(i.ref, i.cell ?? null) === "kept"),
  );
}
function renderWorklist() {
  $("work-resume").hidden = !worklist;
  if (!worklist) {
    $("worklist").hidden = true;
    return;
  }
  $("worklist").hidden = !!worklist.hidden;
  $("worklist-title").textContent =
    worklist.kind === "search"
      ? `검색: ${worklist.query}`
      : "의심 후보 · 자동 오류 판정 아님";
  $("worklist-filter").value = worklist.filter;
  const visible = queueItems(),
    scope = selected ? scopeOf(selected.item.self_ref, selectedCell) : null;
  const index = visible.findIndex(
    (i) => scopeOf(i.ref, i.cell ?? null) === scope,
  );
  const judged = worklist.items.filter(
    (i) => session.reviews[scopeOf(i.ref, i.cell ?? null)],
  ).length;
  const kept = worklist.items.filter(
    (i) => reviewState(i.ref, i.cell ?? null) === "kept",
  ).length;
  $("worklist-progress").textContent =
    `${index < 0 ? "목록 밖" : `${index + 1}/${visible.length}`} · 불러온 ${worklist.items.length}/${worklist.total} · 판단 기록 ${judged} · 유지 ${kept}`;
  $("worklist-note").textContent =
    "이 목록의 집계입니다. 문서 전체 검수 완료를 뜻하지 않습니다. 보류·부분 교정은 남은 작업입니다." +
    (worklist.revision !== session.revision
      ? " 검색/후보의 시작 목록을 유지 중입니다. 다시 찾기를 누르면 최신 내용으로 검색합니다."
      : "");
  const pane = $("worklist-items"),
    scroll = pane.scrollTop,
    x =
      pane.dataset.content === undefined
        ? worklist.scrollLeft || 0
        : pane.scrollLeft,
    focused = document.activeElement?.dataset.queue;
  const html = visible
    .map((i) => {
      const key = scopeOf(i.ref, i.cell ?? null),
        state = reviewState(i.ref, i.cell ?? null);
      const pending = proposals.filter(
        (p) => p.scope === key && ["pending", "stale"].includes(p.status),
      );
      return `<button class="work-result ${key === scope ? "active" : ""}" data-queue="${escapeHTML(key)}" ${key === scope ? 'aria-current="true"' : ""}><strong>${i.cell != null ? `셀 ${i.cell} · 행 ${i.row}, 열 ${i.column}` : escapeHTML(i.ref)}</strong><span>${i.page == null ? "페이지 확인 불가" : i.page + "페이지"} · 검수: ${states[state]}</span><span>${escapeHTML(i.text || i.reasons?.join(" / ") || "")}</span>${i.location_note ? `<small>${escapeHTML(i.location_note)}</small>` : ""}${pending.length ? `<small>제안: 승인 대기 ${pending.filter((p) => p.status === "pending").length} · 재검토 필요 ${pending.filter((p) => p.status === "stale").length}</small>` : ""}</button>`;
    })
    .join("");
  if (pane.dataset.content !== html) {
    pane.innerHTML = html || "<p>이 필터에 해당하는 대상이 없습니다.</p>";
    pane.dataset.content = html;
    pane.scrollTop = scroll;
    pane.scrollLeft = x;
    if (focused)
      [...pane.querySelectorAll("[data-queue]")]
        .find((b) => b.dataset.queue === focused)
        ?.focus({ preventScroll: true });
  }
  $("work-prev").disabled = index <= 0;
  $("work-next").disabled = !visible.length || index === visible.length - 1;
  $("work-more").hidden =
    worklist.kind !== "search" || worklist.items.length >= worklist.total;
}
async function startWorklist(kind, query = "") {
  const epoch = ++queueGeneration;
  const result = await api(
    kind === "search"
      ? "search?" + new URLSearchParams({ q: query, offset: 0, limit: 60 })
      : "suspects",
  );
  if (epoch !== queueGeneration) return;
  worklist = {
    kind,
    query,
    filter: "all",
    items: kind === "search" ? result.items : result,
    total: kind === "search" ? result.total : result.length,
    revision: kind === "search" ? result.revision : session.revision,
    hidden: false,
  };
  persist();
  renderWorklist();
  $("worklist-items").querySelector("button")?.focus();
}
async function moreResults() {
  const list = worklist,
    epoch = queueGeneration;
  const result = await api(
    "search?" +
      new URLSearchParams({
        q: list.query,
        offset: list.items.length,
        limit: 60,
      }),
  );
  if (epoch !== queueGeneration || list !== worklist) return;
  if (result.revision !== list.revision) {
    message(
      "검색 중 문서가 바뀌었습니다. 기존 작업 목록은 유지했습니다. 같은 검색을 다시 실행해 최신 결과를 불러오세요.",
      true,
    );
    return;
  }
  list.items.push(...result.items);
  list.total = result.total;
  persist();
  renderWorklist();
}
async function moveQueue(delta) {
  const list = queueItems(),
    isCurrent = (i) =>
      i.ref === intent.ref && (i.cell ?? null) === (intent.cell ?? null),
    index = list.findIndex(isCurrent);
  let item;
  if (index >= 0) item = list[index + delta];
  else {
    const all = worklist.items,
      at = all.findIndex(isCurrent);
    const candidates =
      delta > 0 ? all.slice(at + 1) : all.slice(0, at).reverse();
    item = candidates.find((i) => list.includes(i));
  }
  if (item) await selectItem(item.ref, item.cell ?? null);
}
$("items").addEventListener(
  "click",
  run(async (e) => {
    const card = e.target.closest("[data-ref]");
    if (card)
      await selectItem(
        card.dataset.ref,
        e.target.closest("[data-cell]")
          ? Number(e.target.closest("[data-cell]").dataset.cell)
          : null,
      );
  }),
);
$("items").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    e.target.click();
  }
});
$("page").onchange = run(() => loadPage($("page").value));
$("prev").onclick = run(() =>
  loadPage(Math.max(session.pages[0], intent.page - 1)),
);
$("next").onclick = run(() =>
  loadPage(Math.min(session.pages.at(-1), intent.page + 1)),
);
$("refresh").onclick = run(refresh);
$("zoom").oninput = () => {
  $("page-stage").style.width = $("zoom").value + "%";
};
$("page-image").onload = () => {
  $("page-image").hidden = false;
  drawLocation();
};
$("page-image").onerror = () => {
  $("location-note").textContent =
    "원본 이미지를 불러오지 못했습니다. 새로고침 후 확인하세요.";
  $("boxes").replaceChildren();
  $("crop").hidden = true;
};
$("cell").onchange = run(() =>
  selectItem(
    selected.item.self_ref,
    $("cell").value === "" ? null : Number($("cell").value),
  ),
);
$("location").onchange = run(() =>
  navigate(
    pageNo,
    selected.item.self_ref,
    selectedCell,
    Number($("location").value),
  ),
);
$("edit-value").oninput = () => {
  if (draft) {
    draft.value = $("edit-value").value;
    draft.edited = true;
    delete draft.submitted;
    persist();
    updateDraftUI();
  }
};
$("reason").oninput = () => {
  if (draft) {
    draft.reason = $("reason").value;
    delete draft.submitted;
    persist();
    updateDraftUI();
  }
};
$("draft-rebase").onclick = () => {
  if (selected && draft) {
    draft.base = basis(selected);
    delete draft.submitted;
    persist();
    updateDraftUI();
  }
};
$("manual-propose").onclick = run(() =>
  submitProposal(selected?.capability?.op),
);
for (const op of ["keep", "defer"])
  $(op).onclick = run(() => submitProposal(op));
$("copy").onclick = run(async () => {
  await navigator.clipboard.writeText($("request-text").value);
  message("요청을 복사했습니다. 현재 에이전트 채팅에 전달하세요.");
});
$("close-dialog").onclick = () => $("dialog").close();
$("proposals").onclick = run(() => showProposals());
$("proposal-hide").onclick = () => {
  proposalView++;
  $("proposal-review").hidden = true;
  saved.proposalOpen = false;
  persist();
};
$("proposal-choice").onchange = run(() => {
  activeProposal = $("proposal-choice").value;
  $("proposal-updates").textContent = "";
  return showProposals(proposals, activeProposal);
});
$("proposal-content").addEventListener("click", run(proposalAction));
$("suspects").onclick = run(() => startWorklist("suspects"));
$("search-form").onsubmit = run(async (e) => {
  e.preventDefault();
  const q = $("search").value.trim();
  if (q) await startWorklist("search", q);
});
$("worklist-items").onclick = run(async (e) => {
  const b = e.target.closest("[data-queue]");
  const i = worklist?.items.find(
    (i) => scopeOf(i.ref, i.cell ?? null) === b?.dataset.queue,
  );
  if (i) await selectItem(i.ref, i.cell ?? null);
});
$("worklist-filter").onchange = () => {
  worklist.filter = $("worklist-filter").value;
  persist();
  renderWorklist();
};
$("work-resume").onclick = () => {
  if (worklist) {
    worklist.hidden = !worklist.hidden;
    persist();
    renderWorklist();
  }
};
$("worklist-items").onscroll = () => {
  if (worklist) {
    worklist.scrollLeft = $("worklist-items").scrollLeft;
    persist();
  }
};
$("work-close").onclick = () => {
  worklist.hidden = true;
  persist();
  renderWorklist();
};
$("work-prev").onclick = run(() => moveQueue(-1));
$("work-next").onclick = run(() => moveQueue(1));
$("work-more").onclick = run(moreResults);
$("reexport").onclick = run(async () => {
  if (decisionBusy) return;
  setDecisionBusy(true);
  try {
    const result = await api("export", {});
    await refresh();
    message(
      result.state === "synced"
        ? "최신 DB 확정 데이터를 JSON으로 내보냈습니다. 교정·이력은 늘리지 않았습니다."
        : "DB 반영은 보존되어 있습니다. 내보내기 오류를 해결하고 재시도하세요.",
      result.state !== "synced",
    );
  } finally {
    setDecisionBusy(false);
  }
});
$("dialog-content").addEventListener(
  "click",
  run(async (e) => {
    if (e.target.closest("#undo") && !decisionBusy) {
      setDecisionBusy(true);
      try {
        const result = await api("undo", { revision: session.revision });
        $("dialog").close();
        await refresh();
        decisionMessage(
          result,
          "마지막 변경을 되돌렸습니다. 이력은 보존됩니다.",
        );
      } finally {
        setDecisionBusy(false);
      }
    }
  }),
);
window.addEventListener("candoc-proposal", run(poll));
window.candocRevealSelection = () =>
  requestAnimationFrame(() => {
    document
      .querySelector("#items .selected-cell")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    $("boxes").firstElementChild?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  });
function updateProposalTargetNote() {
  const p = proposals.find((p) => p.id === activeProposal);
  if ($("proposal-target-note"))
    $("proposal-target-note").textContent =
      p && !sameTarget(p.request.ref, p.request.cell)
        ? "현재 선택과 다른 제안입니다. 이 제안의 원본 확인을 눌러 대상을 맞춰 비교하세요."
        : "";
}
window.addEventListener("candoc-selection", updateProposalTargetNote);
window.addEventListener(
  "hashchange",
  run(() => {
    const q = new URLSearchParams(location.hash.slice(1));
    return navigate(
      Number(q.get("page") || 1),
      q.get("ref"),
      q.has("cell") ? Number(q.get("cell")) : null,
      q.has("loc") ? Number(q.get("loc")) : null,
    );
  }),
);
$("history").onclick = run(async () => {
  await bootstrap();
  const list = await api("history");
  openDialog(
    "변경 이력",
    `<button id="undo">마지막 적용 되돌리기</button><p class="muted">적용의 역순으로 되돌립니다. 원본 위치와 이전 검수 상태도 복구합니다.</p>` +
      list
        .map(
          (e) =>
            `<section class="event"><b>revision ${e.seq} · ${escapeHTML(e.kind)} · ${escapeHTML(e.ref)}</b><details><summary>변경 전후 보기</summary><pre>${escapeHTML(JSON.stringify(e, null, 2))}</pre></details></section>`,
        )
        .join(""),
  );
});
$("validate").onclick = run(async () => {
  message("전체 이미지·참조·원본 해시를 검사하는 중…");
  const result = await api("validate");
  openDialog(
    "전체 Asset 검사",
    `<p>구조·파일 연결 검사입니다. 원본 PDF와의 변환 정확성을 검증한 결과가 아닙니다.</p><pre>${escapeHTML(JSON.stringify(result, null, 2))}</pre>`,
  );
  message("전체 검사를 마쳤습니다. 경고는 원본 데이터에서 보존한 항목입니다.");
});
run(async () => {
  await bootstrap();
  storageKey = `candoc-review-v1:${session.workspace_id}:${session.asset.asset_id}`;
  try {
    const value = JSON.parse(localStorage.getItem(storageKey));
    if (value?.drafts) saved = value;
  } catch {
    message(
      "저장된 작업 문맥을 읽을 수 없습니다. 브라우저 저장 내용을 확인하세요.",
      true,
    );
  }
  worklist = saved.worklist;
  if (worklist?.kind === "search") $("search").value = worklist.query;
  const q = new URLSearchParams(
    location.hash.slice(1) ||
      new URLSearchParams(saved.location || {}).toString(),
  );
  await navigate(
    Number(q.get("page") || 1),
    q.get("ref"),
    q.has("cell") ? Number(q.get("cell")) : null,
    q.has("loc") ? Number(q.get("loc")) : null,
  );
  await poll();
  if (saved.proposalOpen && proposals.some((p) => p.id === saved.proposal))
    await showProposals(proposals, saved.proposal, false);
  window.candocBatchInit?.(session);
  setInterval(run(poll), 4000);
})();

window.candocBatchBridge = {
  api,
  navigate,
  refresh,
  message,
  showExport,
  context: () => window.candocChatContext(),
  selection: () => selected ? { info: selected, cell: selectedCell, location: locationIndex, page: pageNo } : null,
  page: () => pageData,
};
