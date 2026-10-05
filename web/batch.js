/* Problem groups use the existing selection/source and approval/export boundary. */
(() => {
  const $ = (id) => document.getElementById(id),
    esc = (s) =>
      String(s ?? "").replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[c],
      );
  const names = {
    unresolved: "미해결",
    applied: "적용",
    kept: "유지",
    deferred: "보류",
    recheck: "재검수",
    not_detected: "이번 진단 미탐지",
  };
  let data,
    saved = { group: null, excluded: {}, preview: null, open: true, scroll: 0 },
    key,
    busy = false,
    timer,
    epoch = 0;
  const bridge = () => window.candocBatchBridge,
    group = () => data?.groups.find((g) => g.id === saved.group);
  function persist() {
    if (key)
      try {
        localStorage.setItem(key, JSON.stringify(saved));
      } catch {
        bridge().message(
          "브라우저에 묶음 선택·예외를 저장하지 못했습니다. 이 창을 유지하세요. DB 판단 기록은 보존됩니다.",
          true,
        );
      }
  }
  function open(value) {
    saved.open = value;
    $("diagnostic-panel").hidden = !value;
    $("items").hidden = value;
    document.body.classList.toggle("issues-open", value);
    document.querySelector(".converted h1").textContent = value
      ? "전체 문서 문제 묶음"
      : "변환 문서";
    persist();
  }
  function targets() {
    return (group()?.targets || []).filter(
      (t) =>
        !saved.excluded[group().id]?.includes(t.ref) &&
        !["applied", "kept", "not_detected"].includes(t.state),
    );
  }
  function updateActions() {
    const g = group(),
      t = targets();
    $("batch-selected").textContent = g
      ? `선택 ${t.length} / 영향 ${g.targets.length}항목 · 예외는 체크 해제`
      : "묶음을 선택하세요.";
    for (const id of ["batch-apply", "batch-keep", "batch-defer"])
      $(id).disabled = busy || !t.length;
    $("batch-apply").disabled ||= !t.every((t) => t.suggested && t.detected);
    $("batch-next").disabled = busy || !g;
    for (const b of $("diagnostic-panel").querySelectorAll(
      "[data-group],[data-inspect]",
    ))
      b.disabled = busy;
    if ($("batch-approve"))
      $("batch-approve").disabled = busy || !$("batch-confirm")?.checked;
  }
  async function guarded(fn) {
    if (busy) return;
    busy = true;
    updateActions();
    try {
      await fn();
    } catch (e) {
      bridge().message(e.message, true);
      const p = e.details?.proposal;
      if (p) {
        saved.preview = p.targets ? p.id : null;
        saved.pending = null;
        persist();
        $("batch-preview").innerHTML =
          `<p class="error">충돌 · 아무 항목도 적용하지 않았습니다.</p>${(p.conflicts || []).map((c) => `<p>${esc(c.ref)} · ${esc(c.reason)}</p><details><summary>진단 기준과 현재 비교</summary><pre>${esc(JSON.stringify({ before: c.before, current: c.current }, null, 2))}</pre></details>`).join("")}<button id="batch-recheck">재진단 후 다시 검토</button>`;
      } else if (saved.pending) {
        $("batch-preview").innerHTML =
          '<p>미리보기 등록 응답을 확인하지 못했습니다. 동일 요청 ID로 결과를 확인할 수 있습니다.</p><button id="batch-preview-retry">미리보기 결과 확인</button>';
      }
    } finally {
      busy = false;
      updateActions();
    }
  }
  async function load() {
    const e = ++epoch,
      result = await bridge().api("diagnostics");
    if (e !== epoch) return;
    data = result;
    render();
    clearTimeout(timer);
    if (data.job.status === "running")
      timer = setTimeout(
        () => load().catch((e) => bridge().message(e.message, true)),
        700,
      );
  }
  function render() {
    const job = data.job;
    $("diagnostic-status").textContent =
      `${{ idle: "아직 진단하지 않았습니다", running: "진단 중", completed: "진단 완료", failed: "진단 실패", cancelled: "진단 취소" }[job.status]} · ${job.done}/${job.total}페이지${job.error ? " · " + job.error : ""}${job.revision !== undefined && job.revision !== job.current_revision ? " · 진단 이후 수정 발생 (대상별 충돌 검사 적용)" : ""}`;
    $("diagnose").disabled = job.status === "running";
    $("diagnose").textContent =
      job.status === "idle" ? "전체 문서 진단" : "전체 문서 재진단";
    $("diagnose-cancel").hidden = job.status !== "running";
    $("diagnostic-progress").textContent =
      `${data.groups.length}개 묶음 · ` +
      Object.entries(data.counts)
        .map(([k, v]) => `${names[k]} ${v}`)
        .join(" · ");
    if (!group() && data.groups.length) saved.group = data.groups[0].id;
    $("diagnostic-groups").innerHTML = data.groups
      .map(
        (g) =>
          `<button class="diagnostic-group ${g.id === saved.group ? "active" : ""}" data-group="${g.id}"><b>우선 ${g.priority} · ${esc(g.title)}</b><small>${g.targets.length}항목 · ${Math.min(...g.targets.map((t) => t.page).filter(Boolean))}–${Math.max(...g.targets.map((t) => t.page).filter(Boolean))}페이지 · ${Object.entries(
            g.counts,
          )
            .filter(([, v]) => v)
            .map(([k, v]) => `${names[k]} ${v}`)
            .join(" / ")}</small></button>`,
      )
      .join("");
    const g = group();
    if (!g) {
      $("diagnostic-detail").innerHTML =
        "<p>전체 문서를 진단하면 근거가 있는 문제 묶음을 준비합니다. 원본 이미지의 자동 판독 결과가 아닙니다.</p>";
      updateActions();
      return;
    }
    const representative = [
      g.targets[0],
      g.targets[Math.floor(g.targets.length / 2)],
      g.targets.at(-1),
    ].filter((t, i, a) => a.findIndex((v) => v.ref === t.ref) === i);
    $("diagnostic-detail").innerHTML =
      `<h3>${esc(g.title)}</h3><p>${g.targets.length}항목 · ${Math.min(...g.targets.map((t) => t.page).filter(Boolean))}–${Math.max(...g.targets.map((t) => t.page).filter(Boolean))}페이지</p><p>${esc(g.reason)}</p>${g.kind === "margin" ? `<p class="diagnostic-change"><b>수정안:</b> 본문·장절 제목 분류 → 페이지 ${g.targets[0].suggested === "page_header" ? "헤더" : "푸터"}<br>내용 계층 → 페이지 주변 요소(furniture), 제목 단계 제거. 텍스트·원본 위치·참조는 보존합니다.</p>` : ""}<p><b>결정할 점:</b> ${g.kind === "margin" ? "상단/하단 반복 문구인지, 실제 장·절 제목/각주/표 제목인지 원본에서 확인하세요. 예외를 제외하고 label과 content_layer를 바꿀지 판단하세요." : "원본에서 구조·제목 체계를 확인하세요. 안전한 자동 수정안은 없습니다. 현재 내용 유지 또는 보류를 기록할 수 있습니다."}</p><p class="muted">최초 변환 텍스트는 검증된 원문이 아닙니다. 묶음 승인은 개별 원본 검수 완료로 기록하지 않습니다.</p><div class="diagnostic-representatives">${representative.map((t) => `<button data-inspect="${esc(t.ref)}">대표 ${t.page ?? "?"}쪽 원본<canvas data-representative="${esc(t.ref)}" aria-label="대표 원본 영역"></canvas></button>`).join("")}</div><details><summary>계산 근거와 한계</summary><pre>${esc(JSON.stringify(g.evidence, null, 2))}</pre></details><details id="diagnostic-targets" ${saved.expanded ? "open" : ""}><summary>모든 적용 대상 · ${g.targets.length}항목 (예외 제외·개별 원본)</summary>${g.targets.map((t) => `<article class="diagnostic-target ${saved.ref === t.ref ? "active" : ""}"><label><input type="checkbox" data-include="${esc(t.ref)}" ${!saved.excluded[g.id]?.includes(t.ref) && !["applied", "kept", "not_detected"].includes(t.state) ? "checked" : ""} ${["applied", "kept", "not_detected"].includes(t.state) ? "disabled" : ""}/> ${t.page ?? "?"}쪽 · ${names[t.state]} · ${esc(t.ref)}</label><p>${esc(t.before.text ?? "표 구조")}</p><p>${esc(t.current.label)} / ${esc(t.current.content_layer)}${t.current.level ? " / level " + t.current.level : ""} → ${t.suggested ? esc(t.suggested) + " / furniture (level 제거)" : "검수 요청만 · 수정 없음"}</p>${t.recheck_reason ? `<p class="error">${esc(t.recheck_reason)}</p>` : ""}<button data-inspect="${esc(t.ref)}">개별 원본 확인</button><details><summary>항목 근거</summary><pre>${esc(JSON.stringify(t.evidence, null, 2))}</pre></details></article>`).join("")}</details>`;
    $("diagnostic-targets").ontoggle = () => {
      saved.expanded = $("diagnostic-targets").open;
      persist();
    };
    for (const canvas of $("diagnostic-detail").querySelectorAll(
      "[data-representative]",
    )) {
      const t = g.targets.find((t) => t.ref === canvas.dataset.representative),
        loc = t.locations?.[0];
      if (!loc) continue;
      const img = new Image();
      img.onload = () => {
        if (!canvas.isConnected) return;
        const scaleX = img.naturalWidth / loc.size.width,
          scaleY = img.naturalHeight / loc.size.height;
        const x = Math.max(0, loc.rect.x - 10),
          y = Math.max(0, loc.rect.y - 10),
          w = Math.min(loc.size.width - x, loc.rect.width + 20),
          h = Math.min(loc.size.height - y, loc.rect.height + 20);
        canvas.width = Math.round(w * scaleX);
        canvas.height = Math.round(h * scaleY);
        canvas
          .getContext("2d")
          .drawImage(
            img,
            x * scaleX,
            y * scaleY,
            w * scaleX,
            h * scaleY,
            0,
            0,
            canvas.width,
            canvas.height,
          );
      };
      img.src = loc.image;
    }
    updateActions();
    persist();
  }
  async function inspect(ref) {
    const t = group()?.targets.find((t) => t.ref === ref);
    if (!t) return;
    saved.ref = ref;
    persist();
    await bridge().navigate(t.page || 1, t.ref, null);
    document
      .querySelectorAll(".diagnostic-target")
      .forEach((el) =>
        el.classList.toggle(
          "active",
          el.querySelector("[data-inspect]")?.dataset.inspect === ref,
        ),
      );
  }
  function renderPreview(p) {
    saved.preview = p.id;
    persist();
    const title =
      { apply: "재분류", keep: "현재 내용 유지", defer: "보류" }[p.action] ||
      "";
    $("batch-preview").innerHTML =
      `<h3>승인 직전 · ${title} ${p.targets?.length ?? 0}항목</h3><p>묶음 ID ${esc(p.id)} · ${esc(p.status)}. 아래 명시된 대상만 한 번에 처리합니다. 다른 대상을 선택하려면 취소하고 새 미리보기를 만드세요.</p><p>대표 확인을 나머지 항목의 개별 검수 완료로 기록하지 않습니다.</p>${(p.conflicts || []).map((c) => `<p class="error">${esc(c.ref)} · ${esc(c.reason)}</p><details><summary>승인 기준과 현재 비교</summary><pre>${esc(JSON.stringify({ before: c.before, current: c.current }, null, 2))}</pre></details>`).join("")}<div class="batch-exact">${(p.targets || []).map((t) => `<article><button data-inspect="${esc(t.ref)}">${t.page}쪽 ${esc(t.ref)} 원본</button><p>${esc(t.before.text ?? "표 구조")}</p><p>${esc(t.before.label)} / ${esc(t.before.content_layer)}${t.before.level ? " / level " + t.before.level : ""} → ${esc(t.after.label)} / ${esc(t.after.content_layer)}${t.after.level ? " / level " + t.after.level : ""}</p></article>`).join("")}</div>${p.status === "pending" ? '<label><input type="checkbox" id="batch-confirm"/>전체 대상·변경 내용을 확인했고, 이 묶음 판단을 승인합니다.</label><button id="batch-approve" class="primary" disabled>이 묶음 승인·적용</button>' : p.status === "stale" ? '<button id="batch-recheck">재진단 후 다시 검토</button>' : "<p>처리 결과를 확인했습니다. 재승인하지 않습니다.</p>"}<button id="batch-dismiss">미리보기 닫기</button>`;
    $("batch-confirm")?.addEventListener("change", () => {
      $("batch-approve").disabled = !$("batch-confirm").checked || busy;
    });
  }
  async function preview(action) {
    const refs = targets().map((t) => t.ref);
    const req = {
      group: group().id,
      refs,
      action,
      request_id: crypto.randomUUID(),
    };
    saved.pending = req;
    persist();
    const p = await bridge().api("batch-preview", req);
    saved.pending = null;
    renderPreview(p);
    $("batch-preview").scrollIntoView({ block: "start" });
  }
  async function start() {
    $("diagnostic-status").textContent = "진단 시작 중…";
    $("diagnose").disabled = true;
    saved.preview = null;
    saved.pending = null;
    $("batch-preview").innerHTML = "";
    persist();
    await bridge().api("diagnose", {});
    await load();
  }
  window.candocOpenDocument = () => open(false);
  for (const id of ["search-form", "suspects", "work-resume"])
    $(id).addEventListener(id === "search-form" ? "submit" : "click", () =>
      open(false),
    );
  $("issues").onclick = () => open(true);
  $("document-view").onclick = () => open(false);
  $("diagnose").onclick = () => guarded(start);
  $("diagnose-cancel").onclick = () =>
    guarded(async () => {
      await bridge().api("diagnose-cancel", {});
      await load();
    });
  for (const a of ["apply", "keep", "defer"])
    $("batch-" + a).onclick = () => guarded(() => preview(a));
  $("batch-next").onclick = () =>
    guarded(async () => {
      const index = data.groups.findIndex((g) => g.id === saved.group);
      saved.group = data.groups[(index + 1) % data.groups.length].id;
      saved.preview = null;
      saved.pending = null;
      saved.ref = null;
      $("batch-preview").innerHTML = "";
      saved.scroll = 0;
      render();
      $("diagnostic-scroll").scrollTop = 0;
      await inspect(group().targets[0].ref);
    });
  $("diagnostic-scroll").addEventListener("scroll", () => {
    saved.scroll = $("diagnostic-scroll").scrollTop;
    persist();
  });
  $("diagnostic-panel").addEventListener("change", (e) => {
    if (e.target.dataset.include) {
      const id = group().id;
      const excluded = new Set(saved.excluded[id] || []);
      e.target.checked
        ? excluded.delete(e.target.dataset.include)
        : excluded.add(e.target.dataset.include);
      saved.excluded[id] = [...excluded];
      saved.preview = null;
      saved.pending = null;
      $("batch-preview").innerHTML = "";
      persist();
      updateActions();
    }
  });
  $("diagnostic-panel").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.group && !busy) {
      saved.group = b.dataset.group;
      saved.preview = null;
      saved.pending = null;
      saved.ref = null;
      $("batch-preview").innerHTML = "";
      render();
      $("diagnostic-list").open = false;
      window.dispatchEvent(new Event("candoc-selection"));
      guarded(() => inspect(group().targets[0].ref));
    }
    if (b.dataset.inspect) guarded(() => inspect(b.dataset.inspect));
    if (b.id === "batch-dismiss" && !busy) {
      saved.preview = null;
      saved.pending = null;
      persist();
      $("batch-preview").innerHTML = "";
    }
    if (b.id === "batch-recheck") guarded(start);
    if (b.id === "batch-preview-retry")
      guarded(async () => {
        renderPreview(await bridge().api("batch-preview", saved.pending));
        saved.pending = null;
        persist();
      });
    if (b.id === "batch-approve")
      guarded(async () => {
        b.disabled = true;
        const id = saved.preview;
        try {
          const result = await bridge().api("batch-approve", { id });
          bridge().showExport(result.export);
          bridge().message(
            result.export.state === "pending"
              ? "DB에 묶음 전체 반영 완료 / JSON 내보내기 미완료. 재승인하지 말고 재내보내기하세요."
              : "묶음 전체 반영 완료. 제외한 항목은 변경하지 않았습니다.",
          );
          await bridge().refresh();
          await load();
          renderPreview(
            await bridge().api("batch?id=" + encodeURIComponent(id)),
          );
        } catch (e) {
          let recovered;
          try {
            recovered = await bridge().api(
              "batch?id=" + encodeURIComponent(id),
            );
            renderPreview(recovered);
            await bridge().refresh();
            await load();
          } catch {}
          if (recovered?.status === "applied") {
            bridge().message(
              "응답이 끊겼지만 묶음 전체가 DB에 반영된 것을 확인했습니다. 재승인하지 않습니다.",
            );
          } else throw e;
        }
      });
  });
  window.candocGroupContext = (ref) =>
    group()?.targets.some((t) => t.ref === ref)
      ? { group_id: group().id }
      : null;
  window.candocBatchInit = async (session) => {
    key = `candoc-batch-v1:${session.workspace_id}:${session.asset.asset_id}`;
    try {
      const v = JSON.parse(localStorage.getItem(key));
      if (v && typeof v === "object")
        saved = { ...saved, ...v, excluded: v.excluded || {} };
    } catch {}
    open(saved.open);
    try {
      await load();
      if (saved.pending) {
        renderPreview(await bridge().api("batch-preview", saved.pending));
        saved.pending = null;
        persist();
      } else if (saved.preview)
        renderPreview(
          await bridge().api("batch?id=" + encodeURIComponent(saved.preview)),
        );
      $("diagnostic-scroll").scrollTop = saved.scroll;
      if (data.job.status === "idle") await start();
      if (!bridge().context()?.ref && group())
        await inspect(group().targets[0].ref);
    } catch (e) {
      bridge().message("문제 묶음: " + e.message, true);
    }
  };
  window.addEventListener("candoc-refreshed", () => {
    if (key) load().catch((e) => bridge().message(e.message, true));
  });
})();
