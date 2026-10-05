const $ = (id) => document.getElementById(id);
const states = {
  unreviewed: "미확인",
  kept: "유지 승인",
  deferred: "보류 · 미확인",
  corrected_partial: "부분 교정 · 나머지 미확인",
};
let session,
  pageNo = 1,
  selected = null,
  selectedCell = null,
  locationIndex = 0,
  pageData = null,
  generation = 0;
let proposals = [],
  proposalStamp = "";
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
  if (!r.ok) throw Error(result.error || r.statusText);
  return result;
}
function run(fn) {
  return (...args) =>
    Promise.resolve(fn(...args)).catch((e) => message(e.message, true));
}
function openDialog(title, html) {
  $("dialog-title").textContent = title;
  $("dialog-content").innerHTML = html;
  if (!$("dialog").open) $("dialog").showModal();
}
function remember() {
  const q = new URLSearchParams({ page: String(pageNo) });
  if (selected) {
    q.set("ref", selected.item.self_ref);
    if (selectedCell !== null) q.set("cell", String(selectedCell));
  }
  history.replaceState(null, "", "#" + q);
}
async function bootstrap() {
  session = await api("bootstrap");
  $("asset").textContent =
    `${session.asset.asset_id} · 전체 ${session.pages.length}페이지 · revision ${session.revision}`;
  $("total").textContent = "/ " + session.pages.length;
  $("page").max = session.pages.length;
}
async function loadPage(number, ref = null, cell = null) {
  const request = ++generation;
  number = Number(number);
  if (!session.pages.includes(number))
    throw Error("유효한 페이지 번호를 입력하세요.");
  message("페이지를 여는 중…");
  const result = await api("page?page=" + number);
  if (request !== generation) return;
  pageNo = number;
  pageData = result;
  $("page").value = pageNo;
  selected = null;
  selectedCell = null;
  $("selection").hidden = true;
  $("selection-empty").hidden = false;
  $("boxes").innerHTML = "";
  $("crop").hidden = true;
  $("location-note").textContent = "변환 문서의 항목을 선택하세요.";
  $("items").innerHTML = result.items
    .map(
      (i) =>
        `<article class="item" tabindex="0" data-ref="${escapeHTML(i.ref)}"><div class="meta">${escapeHTML(i.ref)} · ${escapeHTML(i.label)}</div>${i.html}</article>`,
    )
    .join("");
  $("item-count").textContent = result.items.length + "개 항목";
  $("page-image").src = result.image;
  $("page-image").alt = `원본 ${pageNo}페이지`;
  if (ref) await selectItem(ref, cell);
  else remember();
  message(`${pageNo}페이지 · 원본은 보존되며 작업 사본을 표시합니다.`);
}
async function selectItem(ref, cell = null) {
  const query = new URLSearchParams({ ref });
  if (cell !== null) query.set("cell", cell);
  const info = await api("item?" + query);
  const item = info.item;
  if (info.locations.length && !info.locations.some((l) => l.page === pageNo)) {
    await loadPage(info.locations[0].page, ref, cell);
    return;
  }
  selected = info;
  selectedCell = cell;
  locationIndex = Math.max(
    0,
    info.locations.findIndex((l) => l.page === pageNo),
  );
  $("selection").hidden = false;
  $("selection-empty").hidden = true;
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
  const scope = ref + (cell === null ? "" : `/cells/${cell}`);
  const state = info.reviews[scope]?.state || "unreviewed";
  $("review-state").textContent = states[state];
  $("item-json").textContent = JSON.stringify(
    cell === null ? item : item.data.table_cells[cell],
    null,
    2,
  );
  $("request-text").value =
    `CanDoc 교정 요청\n서버: ${location.origin}\nAsset: ${info.asset_id}\nrevision: ${info.revision}\n항목: ${ref}${cell === null ? "" : `\n표 셀 index: ${cell}`}\n원본 페이지: ${info.locations.map((l) => l.page).join(", ") || "셀 위치 연결 확인 필요"}\n원본과 비교할 의심 이유와 수정안을 설명하고, 승인 전에는 적용하지 마세요.`;
  document.querySelectorAll(".item").forEach((el) => {
    el.classList.toggle("selected", el.dataset.ref === ref);
    el.querySelectorAll("[data-cell]").forEach((c) =>
      c.classList.toggle(
        "selected-cell",
        el.dataset.ref === ref && Number(c.dataset.cell) === cell,
      ),
    );
  });
  remember();
  drawLocation();
}
function drawLocation() {
  $("boxes").innerHTML = "";
  $("crop").hidden = true;
  if (!selected) return;
  const loc = selected.locations[locationIndex];
  if (!loc) {
    $("location-note").textContent =
      "셀 bbox 없음 또는 여러 페이지 표: 원본 위치를 추정하지 않습니다. 표 전체를 선택해 확인하세요.";
    return;
  }
  if (loc.page !== pageNo) return;
  const { rect: r, size: s } = loc;
  const img = $("page-image");
  $("boxes").innerHTML =
    `<div class="bbox selected-box" style="left:${(100 * r.x) / s.width}%;top:${(100 * r.y) / s.height}%;width:${(100 * r.width) / s.width}%;height:${(100 * r.height) / s.height}%"></div>`;
  $("location-note").textContent =
    `${loc.page}페이지 · ${loc.bbox.coord_origin} → TOPLEFT · (${r.x.toFixed(1)}, ${r.y.toFixed(1)}) ${r.width.toFixed(1)} × ${r.height.toFixed(1)}`;
  if (!img.complete || !img.naturalWidth) return;
  const scaleX = img.naturalWidth / s.width,
    scaleY = img.naturalHeight / s.height,
    pad = 8;
  const x = Math.max(0, (r.x - pad) * scaleX),
    y = Math.max(0, (r.y - pad) * scaleY),
    w = Math.min(img.naturalWidth - x, (r.width + 2 * pad) * scaleX),
    h = Math.min(img.naturalHeight - y, (r.height + 2 * pad) * scaleY);
  if (w <= 0 || h <= 0) return;
  const canvas = $("crop");
  canvas.width = Math.ceil(w);
  canvas.height = Math.ceil(h);
  canvas.getContext("2d").drawImage(img, x, y, w, h, 0, 0, w, h);
  canvas.hidden = false;
}
function diffValue(p, item) {
  const op = p.request.op;
  if (op === "text") return item.text;
  if (op === "cell") return item.data.table_cells[p.request.cell].text;
  if (op === "type")
    return JSON.stringify({ label: item.label, level: item.level }, null, 2);
  return JSON.stringify({ label: item.label, text: item.text }, null, 2);
}
async function showProposals() {
  proposals = await api("proposals");
  const pending = proposals.filter((p) => p.status === "pending");
  openDialog(
    "제안 검토 · 승인 전에는 문서가 바뀌지 않습니다",
    pending.length
      ? pending
          .map(
            (p) =>
              `<section class="proposal"><b>${escapeHTML(p.scope)}</b> <span class="status">${escapeHTML(p.request.op)} · 기준 revision ${p.request.revision}</span><p class="reason">${escapeHTML(p.request.reason)}</p><div class="diff"><div><strong>변경 전</strong><pre>${escapeHTML(diffValue(p, p.before))}</pre></div><div><strong>${p.request.op === "keep" ? "유지" : p.request.op === "defer" ? "보류" : "변경 후"}</strong><pre>${escapeHTML(diffValue(p, p.after))}</pre></div></div><p class="muted">이 대상과 제안만 승인합니다. 문서 전체 검수 완료로 처리하지 않습니다.</p><div class="actions"><button data-view="${escapeHTML(p.request.ref)}">원본 확인</button><button class="primary" data-approve="${p.id}">이 제안 승인·적용</button><button data-reject="${p.id}">거절</button></div></section>`,
          )
          .join("")
      : "<p>대기 중인 제안이 없습니다. 항목 요청을 복사해 현재 에이전트 채팅에 전달하세요.</p>",
  );
}
async function refresh() {
  const ref = selected?.item.self_ref,
    cell = selectedCell;
  await bootstrap();
  await loadPage(pageNo, ref, cell);
  await poll();
}
async function poll() {
  const list = await api("proposals");
  $("pending-count").textContent = list.filter(
    (p) => p.status === "pending",
  ).length;
  const stamp = JSON.stringify(list.map((p) => [p.id, p.status]));
  if (stamp !== proposalStamp && proposalStamp)
    message("교정 제안 목록이 갱신되었습니다. 제안 버튼에서 확인하세요.");
  proposalStamp = stamp;
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
$("items").addEventListener(
  "keydown",
  run(async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.target.click();
    }
  }),
);
$("page").onchange = run(() => loadPage($("page").value));
$("prev").onclick = run(() => loadPage(Math.max(session.pages[0], pageNo - 1)));
$("next").onclick = run(() =>
  loadPage(Math.min(session.pages.at(-1), pageNo + 1)),
);
$("refresh").onclick = run(refresh);
$("zoom").oninput = () => {
  $("page-stage").style.width = $("zoom").value + "%";
};
$("page-image").onload = drawLocation;
$("cell").onchange = run(() =>
  selectItem(
    selected.item.self_ref,
    $("cell").value === "" ? null : Number($("cell").value),
  ),
);
$("location").onchange = run(async () => {
  locationIndex = Number($("location").value);
  const l = selected.locations[locationIndex];
  if (l.page !== pageNo)
    await loadPage(l.page, selected.item.self_ref, selectedCell);
  else drawLocation();
});
$("copy").onclick = run(async () => {
  await navigator.clipboard.writeText($("request-text").value);
  message(
    "요청을 복사했습니다. 현재 에이전트 채팅에 붙여넣고 원하는 교정을 덧붙이세요.",
  );
});
$("close-dialog").onclick = () => $("dialog").close();
$("proposals").onclick = run(showProposals);
for (const op of ["keep", "defer"])
  $(op).onclick = run(async () => {
    if (!$("reason").value.trim())
      throw Error("유지 또는 보류 이유를 입력하세요.");
    await api("propose", {
      asset_id: session.asset.asset_id,
      revision: selected.revision,
      ref: selected.item.self_ref,
      cell: selectedCell,
      op,
      reason: $("reason").value,
    });
    await poll();
    await showProposals();
  });
$("dialog-content").addEventListener(
  "click",
  run(async (e) => {
    const b = e.target.closest("button");
    if (b?.dataset.approve || b?.dataset.reject) {
      b.disabled = true;
      try {
        await api("decision", {
          id: b.dataset.approve || b.dataset.reject,
          action: b.dataset.approve ? "approve" : "reject",
        });
        await refresh();
        await showProposals();
        message("판단이 저장되었습니다.");
      } finally {
        b.disabled = false;
      }
    } else if (b?.dataset.view) {
      $("dialog").close();
      await selectItem(b.dataset.view);
    } else if (b?.id === "undo") {
      b.disabled = true;
      try {
        message("변경을 되돌리는 중…");
        await api("undo", { revision: session.revision });
        $("dialog").close();
        await refresh();
        message("마지막 변경을 되돌렸습니다. 되돌림 이력은 남습니다.");
      } finally {
        b.disabled = false;
      }
    } else {
      const result = e.target.closest("[data-result]");
      if (result) {
        $("dialog").close();
        await selectItem(result.dataset.result);
      }
    }
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
$("suspects").onclick = run(async () => {
  const list = await api("suspects");
  openDialog(
    `의심 후보 ${list.length}건 · 자동 오류 판정 아님`,
    list
      .map(
        (i) =>
          `<div class="result" tabindex="0" data-result="${escapeHTML(i.ref)}"><code>${escapeHTML(i.ref)}</code> · ${i.page}페이지 · ${states[i.review.state]}<p>${escapeHTML(i.reasons.join(" / "))}</p></div>`,
      )
      .join(""),
  );
});
$("search-form").onsubmit = run(async (e) => {
  e.preventDefault();
  const q = $("search").value.trim();
  if (!q) return;
  const list = await api("search?q=" + encodeURIComponent(q));
  openDialog(
    `전체 문서 검색 · ${list.length}건 (최대 150건)`,
    list
      .map(
        (i) =>
          `<div class="result" data-result="${escapeHTML(i.ref)}"><code>${escapeHTML(i.ref)}</code> · ${i.page}페이지<p>${escapeHTML(i.text)}</p></div>`,
      )
      .join("") || "<p>검색 결과가 없습니다.</p>",
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
  const q = new URLSearchParams(location.hash.slice(1));
  await loadPage(
    Number(q.get("page") || 1),
    q.get("ref"),
    q.has("cell") ? Number(q.get("cell")) : null,
  );
  await poll();
  setInterval(run(poll), 4000);
})();
