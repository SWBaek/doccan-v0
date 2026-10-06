/* One conversation and one visible offer. Only real user actions reach the app gate. */
(() => {
  const $ = (id) => document.getElementById(id),
    bridge = () => window.candocBatchBridge;
  const node = (tag, value = "", cls) => {
    const e = document.createElement(tag);
    e.textContent = value;
    if (cls) e.className = cls;
    return e;
  };
  const button = (label, fn, cls) => {
    const b = node("button", label, cls);
    b.type = "button";
    b.onclick = fn;
    return b;
  };
  const compact = (c) =>
    c
      ? {
          asset_id: c.asset_id,
          revision: c.revision,
          ref: c.ref,
          cell: c.cell,
          ...(c.group_id ? { group_id: c.group_id } : {}),
        }
      : null;
  const modes = {
    idle: "시작 전",
    diagnosing: "전체 문서 진단 중",
    thinking: "답변 준비 중",
    awaiting: "판단 대기",
    discussing: "대화 중",
    advancing: "다음 문제 준비",
    paused: "일시정지",
    error: "확인 필요",
  };
  const labels = {
    section_header: "절 제목",
    page_header: "페이지 머리말",
    page_footer: "페이지 꼬리말",
    text: "텍스트",
    paragraph: "문단",
    body: "본문",
    furniture: "머리말·꼬리말",
    table: "표",
    picture: "그림",
    title: "제목",
    list_item: "목록 항목",
    caption: "캡션",
    footnote: "각주",
    formula: "수식",
  };
  let state,
    catalog = [],
    busy = false,
    token,
    key,
    pending,
    pendingScope,
    revision,
    stopped = false;
  let signature,
    sourceOffer,
    lastRun,
    settingsOpen = false,
    scopeDraft,
    scopeOpen = false,
    offerId;
  let readSequence = 0,
    appliedRead = 0;
  let inspectContext = null,
    inspectLabel = "";
  const running = () =>
    ["thinking", "diagnosing", "advancing"].includes(state?.mode);
  function show() {
    document.body.classList.add("conversation-open");
    $("conversation-panel").hidden = false;
    localStorage.setItem("candoc-conversation-open", "true");
  }
  window.candocConversationShow = show;
  $("conversation-toggle").onclick = show;
  async function api(path, body) {
    const r = await fetch("/api/conversation/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "X-Candoc-Token": token, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const v = await r.json();
    if (!r.ok) {
      if (r.status === 403)
        token = (await (await fetch("/api/bootstrap")).json()).token;
      throw Error(v.error || "요청을 처리하지 못했습니다.");
    }
    return v;
  }
  async function guarded(fn) {
    if (busy) return;
    busy = true;
    controls();
    $("conversation-error").textContent = "";
    try {
      await fn();
      await refresh();
    } catch (e) {
      $("conversation-error").textContent = e.message;
    } finally {
      busy = false;
      controls();
    }
  }
  function setSettings(open) {
    settingsOpen = open;
    controls();
  }
  $("settings-toggle").onclick = () => setSettings(!settingsOpen);
  function efforts(preferred) {
    const m = catalog.find((m) => m.model === $("conversation-model").value);
    $("conversation-effort").replaceChildren(
      ...(m?.supportedReasoningEfforts || []).map((e) => {
        const o = node("option", e.reasoningEffort);
        o.value = e.reasoningEffort;
        o.title = e.description;
        return o;
      }),
    );
    if (m)
      $("conversation-effort").value = m.supportedReasoningEfforts.some(
        (e) => e.reasoningEffort === preferred,
      )
        ? preferred
        : m.defaultReasoningEffort;
    controls();
  }
  $("conversation-model").onchange = () => efforts();
  $("conversation-effort").onchange = controls;
  function controls() {
    if (!state) return;
    const run = running(),
      idle = state.mode === "idle",
      ready = !!state.settings;
    const controlsHost = idle
      ? $("review-settings")
      : document.querySelector(".conversation-heading");
    const controlsElement = document.querySelector(".conversation-controls");
    if (controlsElement.parentElement !== controlsHost)
      controlsHost.append(controlsElement);
    const dirtyScope =
      !!scopeDraft &&
      state.current &&
      JSON.stringify(scopeDraft) !== JSON.stringify(state.current.refs);
    const blocked = busy || !!pending || !!pendingScope || dirtyScope;
    $("review-settings").hidden = !idle && !settingsOpen;
    $("settings-toggle").setAttribute(
      "aria-expanded",
      String(!$("review-settings").hidden),
    );
    $("settings-toggle").textContent = ready
      ? `${state.settings.model} · ${state.settings.effort}`
      : "모델 설정";
    $("conversation-models").disabled = busy || run || !token;
    for (const id of ["conversation-model", "conversation-effort"])
      $(id).disabled = busy || run || !catalog.length;
    $("conversation-configure").hidden = idle || !settingsOpen;
    $("conversation-configure").disabled =
      busy || run || !catalog.length || !$("conversation-effort").value;
    $("conversation-start").hidden = !idle;
    $("conversation-start").disabled =
      busy ||
      run ||
      (!ready && (!catalog.length || !$("conversation-effort").value));
    $("conversation-pause").hidden =
      idle || ["paused", "error"].includes(state.mode);
    $("conversation-pause").disabled = busy;
    $("conversation-pause").textContent = run ? "작업 중단" : "일시정지";
    $("conversation-resume").hidden = state.mode !== "paused";
    $("conversation-resume").disabled = busy || !ready;
    $("conversation-retry").hidden = state.mode !== "error";
    $("conversation-retry").disabled = busy || !ready;
    for (const a of ["previous", "next"]) {
      $("conversation-" + a).hidden = idle;
      $("conversation-" + a).disabled =
        busy || run || !ready || state.mode === "paused";
    }
    $("conversation-send").disabled =
      blocked || !["awaiting", "discussing"].includes(state.mode);
    $("conversation-input").disabled = idle;
    $("conversation-check").hidden = !pending && !pendingScope;
    $("conversation-check").disabled = busy;
    for (const b of document.querySelectorAll("[data-decision]"))
      b.disabled =
        blocked ||
        !state.can_approve ||
        state.current?.proposal.status !== "pending";
    for (const b of document.querySelectorAll("[data-present]"))
      b.disabled = blocked || run || ["paused", "error"].includes(state.mode);
    for (const b of document.querySelectorAll("[data-scope]"))
      b.disabled =
        busy ||
        running() ||
        !!pending ||
        !!pendingScope ||
        !["awaiting", "discussing"].includes(state.mode);
    if ($("scope-submit"))
      $("scope-submit").disabled =
        busy || !!pendingScope || !dirtyScope || !scopeDraft.length || run;
    if ($("scope-count") && state.current)
      $("scope-count").textContent = dirtyScope
        ? `조정 중: ${scopeDraft.length}개 적용 예정 · 새 수정안을 확인해야 승인할 수 있습니다.`
        : `최종 승인 범위 ${state.current.refs.length}개`;
    if ($("scope-banner")) {
      $("scope-banner").hidden = !dirtyScope;
      $("scope-banner").textContent =
        `범위 조정 중 · ${scopeDraft?.length}개 선택. 갱신된 수정안을 확인하기 전에는 승인할 수 없습니다.`;
    }
    target();
  }
  function target() {
    const inspect = $("conversation-inspect").checked;
    const c = inspect
      ? inspectContext
      : state?.current?.context || state?.context;
    $("composer-label").textContent = inspect
      ? "선택한 항목으로 새 질문"
      : state?.current
        ? "현재 제안에 질문하거나 판단하기"
        : "검수 대화 이어가기";
    $("question-reset").hidden = !inspect;
    $("conversation-target").textContent = inspect
      ? c
        ? `${inspectLabel} · 기존 제안의 승인으로 처리하지 않습니다.`
        : "원본에서 질문할 항목을 먼저 선택하세요."
      : state?.current
        ? `승인 범위: 현재 제안 ${state.current.refs.length}개 · 원본 탐색으로 바뀌지 않습니다.`
        : "진행 상태와 원본 근거를 확인하며 이어가세요.";
  }
  function questionSelection() {
    if ($("conversation-inspect").checked && !pending) {
      inspectContext = compact(bridge().context());
      const selected = bridge().selection();
      inspectLabel = selected
        ? `${selected.page}쪽 · ${selected.cell == null ? "문서 항목" : "표 셀 " + (selected.cell + 1)}: ${value(selected.info.item, selected.cell).slice(0, 45)}`
        : "";
    } else if (!$("conversation-inspect").checked) inspectContext = null;
    target();
  }
  $("conversation-inspect").onchange = questionSelection;
  window.addEventListener("candoc-selection", questionSelection);
  $("question-reset").onclick = () => {
    $("conversation-inspect").checked = false;
    inspectContext = null;
    target();
    $("conversation-input").focus();
  };
  async function inspect(c, ref = c.ref, cell = c.cell, page) {
    await bridge().navigate(
      page || c.locations?.[0]?.page || 1,
      ref,
      cell ?? null,
    );
    window.candocWorkspace?.close();
    window.candocWorkspace?.source("region");
    window.candocWorkspace?.view("evidence");
    show();
  }
  function sourceButton(c, text, ref, cell, page) {
    return button(
      text || "관련 원본 보기",
      () =>
        guarded(() =>
          inspect(c, ref ?? c.ref, cell === undefined ? c.cell : cell, page),
        ),
      "text-button",
    );
  }
  function value(item, cell) {
    return cell != null
      ? item.data.table_cells[cell].text
      : item.text || "표·구조 검토";
  }
  function change(item, cell, action) {
    if (action === "keep") return "현재 내용을 유지하고 판단을 기록";
    if (action === "defer") return "내용 변경 없이 보류로 기록";
    if (cell != null) return value(item, cell);
    return `${labels[item.label] || item.label} · ${labels[item.content_layer] || item.content_layer || ""}${item.level ? " · 제목 단계 " + item.level : ""}`;
  }
  function diff(before, after, cell, action) {
    const wrap = node("div", "", "offer-diff");
    const classification =
      action === "apply" || (before.text === after.text && cell == null);
    for (const [caption, item] of [
      ["현재", before],
      ["변경 후", after],
    ]) {
      const col = node("div");
      col.append(
        node("small", caption),
        node(
          "p",
          classification
            ? change(item, cell, caption === "변경 후" ? action : null)
            : value(item, cell),
        ),
      );
      wrap.append(col);
    }
    return wrap;
  }
  function offerCard(o) {
    const p = o.proposal,
      card = node("article", "", "conversation-current");
    card.dataset.offer = o.id;
    const targets = p.targets || [
      {
        ref: p.request.ref,
        before: p.before,
        after: p.after,
        page: o.context.locations?.[0]?.page,
      },
    ];
    const all = o.scope_targets || targets,
      t = targets[0],
      cell = p.request?.cell;
    const action = p.action || p.request?.op,
      current = state.can_approve && p.status === "pending";
    card.append(
      node(
        "small",
        current
          ? "이 범위를 변경할까요?"
          : p.status === "stale"
            ? "새 검수가 필요합니다"
            : "수정안 확인",
      ),
    );
    const noun =
      t.before.label === "table" && cell == null ? "표 전체" : "항목";
    card.append(
      node(
        "h2",
        `${targets.length}개 ${noun} ${action === "keep" ? "유지" : action === "defer" ? "보류" : "변경"} 제안`,
      ),
    );
    const banner = node("p", "", "scope-count");
    banner.id = "scope-banner";
    banner.hidden = true;
    card.append(banner);
    card.append(node("p", p.title || "선택한 항목 교정", "offer-title"));
    card.append(
      node(
        "p",
        p.reason || p.request?.reason || "원본과 변경 전후를 확인하세요.",
        "offer-reason",
      ),
    );
    card.append(diff(t.before, t.after, cell, action));
    card.append(
      node(
        "p",
        action === "apply"
          ? "문구는 보존합니다. 본문 제목에서 반복 머리말·꼬리말로 분류하고 제목 단계를 제거합니다."
          : action === "keep" || action === "defer"
            ? "문서 내용은 바뀌지 않습니다."
            : "표시된 내용만 교정합니다.",
        "muted",
      ),
    );
    card.append(node("p", value(t.before, cell), "offer-excerpt"));
    card.append(
      sourceButton(
        o.context,
        `${t.page || "?"}쪽 원본 확인 · 전체 ${targets.length}개 중 첫 사례`,
        t.ref,
        cell,
        t.page,
      ),
    );
    const details = node("details");
    details.id = "offer-targets";
    details.open = scopeOpen;
    details.append(
      node(
        "summary",
        `전체 ${all.length}개 대상·예외 확인${all.length !== targets.length ? " · " + (all.length - targets.length) + "개 제외" : ""}`,
      ),
    );
    details.ontoggle = () => {
      scopeOpen = details.open;
      saveScopeDraft();
    };
    if (p.targets && p.status === "pending")
      details.append(
        node(
          "p",
          "체크를 해제해 예외를 지정하세요. 범위를 갱신한 뒤 새 제안에 다시 답해야 합니다.",
          "muted",
        ),
      );
    let scopeControls;
    if (p.targets && p.status === "pending") {
      scopeControls = node("div", "", "scope-controls");
      details.append(scopeControls);
    }
    for (const [index, row] of all.entries()) {
      const entry = node("article", "", "offer-target");
      entry.dataset.ref = row.ref;
      if (p.targets && p.status === "pending") {
        const label = node("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = (scopeDraft || o.refs).includes(row.ref);
        input.dataset.scope = row.ref;
        input.setAttribute(
          "aria-label",
          `${row.page}쪽 ${index + 1}번째 항목 적용 범위에 포함`,
        );
        input.onchange = () => {
          scopeDraft = all
            .filter((t) =>
              t.ref === row.ref ? input.checked : scopeDraft.includes(t.ref),
            )
            .map((t) => t.ref);
          saveScopeDraft();
          controls();
        };
        label.append(input, node("span", `${row.page}쪽 · 사례 ${index + 1}`));
        entry.append(label);
      }
      entry.append(
        sourceButton(o.context, "원본 보기", row.ref, cell, row.page),
      );
      entry.append(node("p", value(row.before, cell)));
      const exact = node("details");
      exact.append(
        node("summary", "이 항목의 변경 전후"),
        diff(row.before, row.after, cell, action),
      );
      entry.append(exact);
      details.append(entry);
    }
    if (p.targets && p.status === "pending") {
      const count = node("p", "", "scope-count");
      count.id = "scope-count";
      const apply = button("선택한 범위로 수정안 갱신", () =>
        guarded(async () => {
          pendingScope = {
            action: "scope",
            offer: o.id,
            generation: state.generation,
            refs: scopeDraft,
            request_id: crypto.randomUUID(),
          };
          sessionStorage.setItem(
            key + ":scope-request",
            JSON.stringify(pendingScope),
          );
          await api("control", pendingScope);
          clearScopeRequest();
        }),
      );
      apply.id = "scope-submit";
      scopeControls.append(count, apply);
    }
    card.append(details);
    const technical = node("details", "", "technical");
    technical.append(
      node("summary", "제안·문서 버전 상세"),
      node(
        "pre",
        `제안 ${o.proposal_id}\n버전 ${o.version}\n문서 revision ${o.context.revision}\n적용 대상\n${o.refs.join("\n")}`,
      ),
    );
    card.append(technical);
    if (current) {
      const actions = node("div", "", "offer-actions");
      for (const [text, message, primary] of [
        [
          `${targets.length}개 ${action === "defer" ? "보류 확정" : action === "keep" ? "유지 확정" : "승인·적용"}`,
          "승인해",
          true,
        ],
        ["그대로 유지", "그대로 둬"],
        ["보류", "보류해"],
      ]) {
        const b = button(
          text,
          () => {
            $("conversation-inspect").checked = false;
            inspectContext = null;
            return submit(message);
          },
          primary ? "primary" : "",
        );
        b.dataset.decision = message;
        actions.append(b);
      }
      actions.append(
        button(
          "질문하기",
          () => {
            $("conversation-inspect").checked = false;
            inspectContext = null;
            target();
            $("conversation-input").focus();
          },
          "text-button",
        ),
      );
      card.append(actions);
    } else if (p.status === "pending") {
      const b = button(
        "이 수정안 다시 확인",
        () => control("present", { offer: o.id }),
        "primary",
      );
      b.dataset.present = o.id;
      card.append(
        node(
          "p",
          "설명 확인과 변경 승인을 구분하기 위해, 이 수정안을 다시 제시한 뒤 답변을 받습니다.",
          "muted",
        ),
        b,
      );
    }
    if (p.status === "stale")
      card.append(
        node(
          "p",
          "대상의 내용이나 검수 이력이 달라졌습니다. 기존 승인은 사용할 수 없습니다.",
          "error",
        ),
        button("재진단하고 새 제안 받기", () => control("start"), "primary"),
      );
    return card;
  }
  function saveScopeDraft() {
    if (key && state?.current)
      localStorage.setItem(
        key + ":scope-draft",
        JSON.stringify({
          offer: state.current.id,
          refs: scopeDraft,
          open: scopeOpen,
        }),
      );
  }
  function clearScopeRequest() {
    pendingScope = null;
    sessionStorage.removeItem(key + ":scope-request");
    localStorage.removeItem(key + ":scope-draft");
  }
  function messageCard(m) {
    const card = node("article", "", "conversation-receipt");
    card.dataset.message = m.id;
    card.append(node("small", "나"), node("p", m.message));
    if (m.result) {
      const decision =
        { keep: "유지", defer: "보류", approve: "승인 반영" }[
          m.result.decision
        ] || "판단";
      card.append(
        node(
          "p",
          m.result.undone
            ? "이 판단은 이후 되돌렸습니다."
            : `${m.result.count ?? ""}개 항목 ${decision} 완료 · 문서 이력에서 확인했습니다.`,
          "receipt-result",
        ),
      );
      const detail = node("details", "", "technical");
      detail.append(
        node("summary", "처리 상세"),
        node(
          "small",
          `문서 revision ${m.result.revision} · 중복 적용하지 않습니다.`,
        ),
      );
      card.append(detail);
    }
    return card;
  }
  function renderTimeline() {
    const sig = JSON.stringify([
      state.chat.runs.map((r) => [r.id, r.output, r.status, r.error]),
      state.messages,
      state.current,
      state.offers.map((o) => o.id),
      state.mode,
      state.generation,
    ]);
    if (sig === signature) return;
    const transcript = $("conversation-transcript"),
      bottom =
        transcript.scrollHeight -
          transcript.scrollTop -
          transcript.clientHeight <
        100,
      scroll = transcript.scrollTop;
    const openIds = [...transcript.querySelectorAll("details[open][id]")].map(
        (d) => d.id,
      ),
      focus = document.activeElement?.id;
    const changedOffer = state.current?.id !== offerId;
    if (changedOffer) {
      offerId = state.current?.id;
      scopeDraft = state.current ? [...state.current.refs] : null;
      try {
        const saved = JSON.parse(localStorage.getItem(key + ":scope-draft"));
        if (saved?.offer === offerId) {
          scopeDraft = saved.refs;
          scopeOpen = saved.open;
        } else scopeOpen = false;
      } catch {
        scopeOpen = false;
      }
    }
    const fragment = document.createDocumentFragment(),
      rendered = new Set(),
      runs = state.chat.runs,
      messages = state.messages;
    const appendMessage = (m) => {
      if (!rendered.has(m.id)) {
        fragment.append(messageCard(m));
        rendered.add(m.id);
      }
    };
    for (const run of runs) {
      const mid =
        run.message_id ||
        messages.find((m) => m.message === run.message && !rendered.has(m.id))
          ?.id;
      const position = messages.findIndex((m) => m.id === mid);
      if (position >= 0)
        for (const m of messages.slice(0, position + 1)) appendMessage(m);
      else
        for (const m of messages)
          if (m.result && m.result.revision <= run.target.revision)
            appendMessage(m);
      const card = node("article", "", "conversation-turn");
      card.dataset.run = run.id;
      card.append(node("small", "검수 에이전트"));
      if (
        !mid &&
        run.review_kind !== "lead" &&
        !run.message.startsWith("이 문제를 원본 확인")
      )
        card.append(node("p", run.message, "conversation-user"));
      card.append(
        node("pre", run.output || "원본 위치와 진단 근거를 확인하고 있습니다."),
      );
      if (run.error)
        card.append(
          node(
            "p",
            "응답을 마치지 못했습니다. 아래에서 다시 시도할 수 있습니다.",
            "error",
          ),
        );
      const meta = node("details", "", "technical");
      meta.append(
        node("summary", "대상·실행 상세"),
        node(
          "pre",
          `${run.target.ref || "문서"}${run.target.cell == null ? "" : " · 셀 " + run.target.cell}\nrevision ${run.target.revision} · ${run.target.execution?.model || "?"} / ${run.target.execution?.effort || "?"} · ${run.status}${run.error ? "\n" + run.error : ""}`,
        ),
        sourceButton(run.target),
      );
      card.append(meta);
      fragment.append(card);
    }
    for (const m of messages) appendMessage(m);
    const offers = state.offers.length
      ? state.offers
      : state.current
        ? [state.current]
        : [];
    if (offers.length > 1) {
      const choose = node("div", "", "offer-choice");
      choose.append(
        node("p", "수정안이 여러 개입니다. 검토할 하나를 선택하세요."),
      );
      for (const [i, o] of offers.entries())
        choose.append(
          button(`${i + 1}. ${o.refs.length}개 항목 제안 확인`, () =>
            control("present", { offer: o.id }),
          ),
        );
      fragment.append(choose);
    }
    if (state.current) {
      const host = node("section");
      host.id = "conversation-offer";
      host.setAttribute("aria-label", "현재 제시한 수정안");
      host.append(offerCard(state.current));
      fragment.append(host);
    }
    if (!runs.length && !state.current) {
      const empty = node("div", "", "conversation-empty");
      empty.append(
        node("span", "01 / 검수 준비", "eyebrow"),
        node("h2", "한 번에 하나의 판단에 집중하세요."),
        node(
          "p",
          "에이전트가 문서의 의심 항목과 변경안을 가져옵니다. 오른쪽 원본을 확인하고 질문하거나 판단하면 다음 문제로 이어집니다.",
        ),
        node(
          "p",
          "반복되는 문제는 묶어서 제안합니다. 적용 범위와 예외를 먼저 확인할 수 있습니다.",
          "muted",
        ),
      );
      fragment.append(empty);
    }
    if (state.mode === "error") {
      const error = node("article", "", "conversation-error-state");
      error.append(
        node("h2", "작업을 마치지 못했습니다"),
        node(
          "p",
          "적용 여부는 문서 이력으로 확인합니다. 다시 시도는 실패한 진단·답변을 요청하며 승인을 재실행하지 않습니다.",
        ),
      );
      const detail = node("details");
      detail.append(node("summary", "오류 상세"), node("pre", state.note));
      error.append(detail);
      fragment.append(error);
    }
    if (state.mode === "paused")
      fragment.append(
        node(
          "p",
          "일시정지했습니다. 재개해도 이전 메시지나 승인을 자동으로 다시 보내지 않습니다.",
          "conversation-paused",
        ),
      );
    transcript.replaceChildren(fragment);
    for (const id of openIds)
      if ($(id) && !(changedOffer && id === "offer-targets")) $(id).open = true;
    if (focus && $(focus) && !$(focus).disabled)
      $(focus).focus({ preventScroll: true });
    if (changedOffer && state.current) {
      const receipt = messages
          .filter((m) => m.result && !m.result.undone)
          .at(-1),
        last = runs.at(-1);
      const recentResult =
        receipt &&
        last?.review_kind === "lead" &&
        last.target.revision === receipt.result.revision;
      const anchor =
        (recentResult &&
          transcript.querySelector(`[data-message="${receipt.id}"]`)) ||
        $("conversation-offer");
      transcript.scrollTop = anchor
        ? anchor.offsetTop - transcript.offsetTop
        : 0;
    } else transcript.scrollTop = bottom ? transcript.scrollHeight : scroll;
    signature = sig;
  }
  function render() {
    const count = state.current?.refs.length;
    const stale = state.current?.proposal.status === "stale";
    const modeLabel = stale ? "재검수 필요" : modes[state.mode];
    const note =
      state.mode === "paused" &&
      state.export.state === "synced" &&
      state.note.includes("내보내기 미완료")
        ? "문서 파일 저장을 복구했습니다. 대화를 재개할 수 있습니다."
        : state.note;
    document.body.dataset.reviewMode = stale ? "error" : state.mode;
    $("conversation-setting").textContent = state.settings
      ? `선택한 설정: ${state.settings.model} / ${state.settings.effort}${running() ? " · 작업을 중단한 뒤 변경할 수 있습니다." : " · 변경은 다음 턴부터 적용됩니다."}`
      : "설치·로그인된 Codex에서 사용 가능한 값을 조회합니다.";
    $("header-progress").textContent = modeLabel;
    $("conversation-progress").textContent = count
      ? `${count}개 항목 ${stale ? "재검수 필요" : "판단 대기"}`
      : state.visited.length
        ? `${state.visited.length}번째 문제`
        : "";
    $("conversation-status").textContent =
      `${modeLabel} · ` +
      (stale
        ? "대상의 내용이나 이력이 달라졌습니다. 새 제안이 필요합니다."
        : state.mode === "awaiting" && !state.note.startsWith("어느 수정안")
          ? `현재 제안 ${count}개의 변경 전후를 확인하세요.`
          : state.mode === "diagnosing"
            ? `${state.job.done}/${state.job.total}쪽 진단 중`
            : state.mode === "error"
              ? "실행 상세를 확인하고 다시 시도하세요."
              : note);
    $("review-technical").textContent = JSON.stringify(
      {
        document_revision: state.revision,
        connection: state.chat.connection,
        settings: state.settings,
        export: state.export,
        note: state.note,
      },
      null,
      2,
    );
    renderTimeline();
    controls();
    window.candocWorkspace?.evidence(
      state.current,
      state.chat.runs.at(-1)?.target || state.context,
    );
  }
  async function refresh() {
    const read = ++readSequence,
      next = await api("state");
    if (read < appliedRead) return;
    appliedRead = read;
    state = next;
    render();
    if (revision !== undefined && revision !== state.revision) {
      await bridge().refresh();
      bridge().showExport(state.export);
    }
    revision = state.revision;
    if (state.current && sourceOffer !== state.current.id) {
      sourceOffer = state.current.id;
      const p = state.current.proposal,
        t = p.targets?.[0],
        c = bridge().context();
      const cell =
        p.request?.cell ??
        state.current.context.diagnostic_group?.selected_evidence
          ?.overlapping_cells?.[0]?.[0] ??
        null;
      if (
        !state.current.refs.includes(c?.ref) ||
        (cell !== null && cell !== (c?.cell ?? null))
      )
        await bridge().navigate(
          t?.page || state.current.context.locations?.[0]?.page || 1,
          t?.ref || state.current.context.ref,
          cell,
        );
      window.candocWorkspace?.sync();
    } else if (!state.current) {
      const run = state.chat.runs.at(-1);
      if (run && run.id !== lastRun && run.target.ref) {
        lastRun = run.id;
        await bridge().navigate(
          run.target.locations?.[0]?.page || 1,
          run.target.ref,
          run.target.cell ??
            run.target.diagnostic_group?.selected_evidence
              ?.overlapping_cells?.[0]?.[0] ??
            null,
        );
      }
    }
  }
  function control(action, extra = {}) {
    return guarded(async () => {
      if (action === "start" && catalog.length)
        await api("settings", {
          model: $("conversation-model").value,
          effort: $("conversation-effort").value,
        });
      await api("control", { action, ...extra });
      settingsOpen = false;
    });
  }
  for (const a of ["start", "pause", "resume", "retry", "previous", "next"])
    $("conversation-" + a).onclick = () => control(a);
  $("conversation-models").onclick = () =>
    guarded(async () => {
      catalog = [];
      $("conversation-model").replaceChildren();
      $("conversation-effort").replaceChildren();
      const r = await api("models", {});
      catalog = r.models;
      $("conversation-model").replaceChildren(
        ...catalog.map((m) => {
          const o = node("option", m.displayName || m.model);
          o.value = m.model;
          return o;
        }),
      );
      const preferred =
        r.selected?.model || catalog.find((m) => m.isDefault)?.model;
      if (catalog.some((m) => m.model === preferred))
        $("conversation-model").value = preferred;
      efforts(r.selected?.effort);
      if (!catalog.length)
        throw Error("사용 가능한 모델을 확인하지 못했습니다.");
    });
  $("conversation-configure").onclick = () =>
    guarded(async () => {
      await api("settings", {
        model: $("conversation-model").value,
        effort: $("conversation-effort").value,
      });
      settingsOpen = false;
    });
  function savePending(v) {
    pending = v;
    if (v) sessionStorage.setItem(key, JSON.stringify(v));
    else sessionStorage.removeItem(key);
  }
  async function send() {
    await api("message", pending);
    savePending(null);
    $("conversation-input").value = "";
    localStorage.removeItem(key + ":draft");
    $("conversation-inspect").checked = false;
    inspectContext = null;
  }
  function submit(text) {
    if ($("conversation-send").disabled || !text.trim()) return;
    const inspect = $("conversation-inspect").checked,
      context = inspect
        ? inspectContext
        : compact(state.current?.context) || state.context;
    if (!context) {
      $("conversation-error").textContent =
        "질문할 항목을 원본에서 선택하세요.";
      return;
    }
    savePending({
      id: crypto.randomUUID(),
      message: text,
      presentation: state.current?.id || null,
      generation: state.generation,
      context,
      inspect,
      selection: compact(bridge().context()),
    });
    return guarded(send);
  }
  $("conversation-form").onsubmit = (e) => {
    e.preventDefault();
    submit($("conversation-input").value);
  };
  $("conversation-check").onclick = () =>
    guarded(async () => {
      await refresh();
      if (pendingScope) {
        await api("control", pendingScope);
        clearScopeRequest();
        return;
      }
      if (state.messages.some((m) => m.id === pending.id)) {
        savePending(null);
        return;
      }
      await send();
    });
  $("conversation-input").oninput = () => {
    if (key)
      localStorage.setItem(key + ":draft", $("conversation-input").value);
  };
  window.addEventListener("pagehide", () => (stopped = true));
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-conversation-group]");
    if (b) {
      window.candocWorkspace?.close();
      show();
      control("group", { group: b.dataset.conversationGroup });
    }
  });
  (async () => {
    const boot = await (await fetch("/api/bootstrap")).json();
    token = boot.token;
    key = `candoc-conversation:${boot.workspace_id}:${boot.asset.asset_id}`;
    try {
      pending = JSON.parse(sessionStorage.getItem(key));
      pendingScope = JSON.parse(sessionStorage.getItem(key + ":scope-request"));
    } catch {}
    $("conversation-input").value = localStorage.getItem(key + ":draft") || "";
    show();
    while (!stopped) {
      try {
        await refresh();
      } catch (e) {
        $("conversation-error").textContent = "상태 확인 실패: " + e.message;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  })().catch((e) => ($("conversation-error").textContent = e.message));
})();
