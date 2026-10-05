/* A narrow UI client, not a generic Codex RPC proxy. All text is rendered as text. */
(() => {
  const el = (id) => document.getElementById(id);
  const active = new Set(["queued", "running", "stopping"]);
  const names = {
    disabled: "설정 필요",
    disconnected: "연결 안 됨",
    connecting: "연결 중",
    connected: "연결됨",
    error: "연결 오류",
    queued: "전송 중",
    running: "답변 중",
    stopping: "중단 중",
    completed: "완료",
    failed: "오류",
    interrupted: "중단됨",
  };
  let state = { connection: "disconnected", runs: [], seq: 0 };
  let token,
    pending = null,
    busy = false,
    cursor = 0,
    listening = false,
    stopped = false;
  let pendingKey;
  const contextLabel = (c) =>
    c
      ? `${c.ref || "문서 개요"}${c.cell !== null ? ` / 셀 ${c.cell}` : ""} · revision ${c.revision}${c.group_id ? " · 선택한 문제 묶음 연결" : ""}`
      : "문서를 여는 중…";
  function target() {
    const context = window.candocChatContext?.();
    el("chat-target").textContent = context
      ? "다음 메시지 대상: " + contextLabel(context)
      : "선택 대상을 읽는 중 · 전송할 수 없습니다";
    el("chat-input").disabled = !context;
    el("chat-send").disabled =
      busy ||
      state.runs.some((r) => active.has(r.status)) ||
      !!pending ||
      state.connection !== "connected" ||
      !context ||
      !window.candocDraftReady?.();
  }
  async function request(path, body) {
    const response = await fetch("/api/chat/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "X-Candoc-Token": token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok)
      throw Error(result.error || "대화 서버에 연결할 수 없습니다.");
    return result;
  }
  function text(tag, value, className) {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
  }
  function render() {
    const running = state.runs.find((r) => active.has(r.status));
    el("chat-status").textContent = running
      ? names[running.status]
      : names[state.connection];
    el("chat-status").dataset.state = running?.status || state.connection;
    el("chat-connect").disabled =
      busy ||
      state.connection === "connected" ||
      state.connection === "disabled";
    el("chat-disconnect").disabled =
      busy || !["connected", "error"].includes(state.connection);
    el("chat-send").disabled =
      busy || !!running || !!pending || state.connection !== "connected";
    el("chat-interrupt").disabled =
      busy || !running || running.status === "stopping";
    el("chat-retry").disabled = busy;
    el("chat-retry-area").hidden = !pending;
    el("chat-session").textContent = state.thread_id
      ? `대화 ${state.thread_id.slice(-12)} · ${state.model || "Codex"}`
      : "이 PC의 Codex 로그인 환경을 사용합니다.";
    el("chat-session").title = state.thread_id || "";
    el("chat-error").textContent =
      state.error ||
      (state.connection === "disabled"
        ? "서버 실행 시 --chat-config 설정 파일을 지정하세요."
        : "");
    const transcript = el("chat-transcript");
    const follow =
      transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <
      70;
    const scrollTop = transcript.scrollTop;
    const fragment = document.createDocumentFragment();
    for (const run of state.runs) {
      const card = document.createElement("article");
      card.className = "chat-turn";
      card.dataset.requestId = run.id;
      card.dataset.status = run.status;
      card.append(
        text("small", contextLabel(run.target), "chat-frozen-target"),
      );
      card.append(text("p", run.message, "chat-user"));
      card.append(
        text(
          "pre",
          run.output ||
            (active.has(run.status) ? "응답을 기다리는 중…" : "응답 내용 없음"),
          "chat-answer",
        ),
      );
      card.append(
        text("small", names[run.status] || run.status, "chat-run-status"),
      );
      if (run.error) card.append(text("p", run.error, "error"));
      fragment.append(card);
    }
    if (!state.runs.length)
      fragment.append(
        text(
          "p",
          "문서에서 항목을 선택하고 검수할 내용을 보내세요. 이전 대화가 있으면 연결할 때 재개합니다.",
          "muted",
        ),
      );
    transcript.replaceChildren(fragment);
    transcript.scrollTop = follow ? transcript.scrollHeight : scrollTop;
    target();
  }
  function savePending(value) {
    pending = value;
    if (pendingKey) {
      if (value) sessionStorage.setItem(pendingKey, JSON.stringify(value));
      else sessionStorage.removeItem(pendingKey);
    }
  }
  async function refresh() {
    const latest = await request("state");
    if (latest.seq < cursor) return;
    state = latest;
    cursor = Math.max(cursor, state.seq);
    if (pending && state.runs.some((r) => r.id === pending.id)) {
      window.candocClearSentDraft?.(pending.context, pending.message);
      savePending(null);
    }
    render();
  }
  async function action(fn) {
    if (busy) return;
    busy = true;
    render();
    try {
      await fn();
    } catch (error) {
      try {
        await refresh();
      } catch {
        /* preserve the operation error */
      }
      el("chat-error").textContent = error.message;
    } finally {
      busy = false;
      // Preserve the action error while updating button availability.
      const error = el("chat-error").textContent;
      render();
      if (error) el("chat-error").textContent = error;
    }
  }
  async function sendPending() {
    const sent = pending;
    await request("message", sent);
    await refresh();
    savePending(null);
    window.candocClearSentDraft?.(sent.context, sent.message);
    render();
  }
  async function stream() {
    if (listening) return;
    listening = true;
    while (!stopped) {
      try {
        const response = await fetch(`/api/chat/events?after=${cursor}`, {
          headers: { "X-Candoc-Token": token },
        });
        if (!response.ok) throw Error("대화 이벤트 연결이 끊겼습니다.");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let split;
          while ((split = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            if (!frame.startsWith("data: ")) continue;
            const event = JSON.parse(frame.slice(6));
            if (event.seq <= cursor) continue;
            cursor = event.seq;
            const run = state.runs.find((r) => r.id === event.request_id);
            if (event.type === "delta" && run) {
              run.output += event.text;
              render();
            } else {
              await refresh();
            }
            if (event.type === "proposal")
              window.dispatchEvent(new Event("candoc-proposal"));
          }
        }
      } catch {
        el("chat-error").textContent =
          "대화 상태 연결을 다시 확인하는 중입니다. 메시지를 자동 재전송하지 않습니다.";
        await new Promise((resolve) => setTimeout(resolve, 1500));
        try {
          const bootstrap = await (await fetch("/api/bootstrap")).json();
          token = bootstrap.token;
          await refresh();
        } catch {
          /* next reconnect will retry reads only */
        }
      }
      if (state.connection === "disabled") break;
    }
    listening = false;
  }
  function show(open) {
    el("chat-panel").hidden = !open;
    document.body.classList.toggle("chat-open", open);
    el("chat-toggle").setAttribute("aria-expanded", String(open));
    if (open) {
      target();
      el("chat-input").focus();
    }
    window.candocRevealSelection?.();
  }
  document.querySelector(".converted").append(el("chat-panel"));
  el("chat-input").addEventListener("input", () =>
    window.candocSetChatDraft?.(el("chat-input").value),
  );
  el("chat-toggle").onclick = () => show(el("chat-panel").hidden);
  el("chat-hide").onclick = () => show(false);
  el("chat-connect").onclick = () =>
    action(async () => {
      await request("connect", {});
      await refresh();
    });
  el("chat-disconnect").onclick = () =>
    action(async () => {
      await request("disconnect", {});
      await refresh();
    });
  el("chat-interrupt").onclick = () =>
    action(async () => {
      await request("interrupt", {});
      await refresh();
    });
  el("chat-proposals").onclick = () => el("proposals").click();
  el("chat-form").onsubmit = (event) => {
    event.preventDefault();
    if (el("chat-send").disabled || !el("chat-input").value.trim()) return;
    const context = window.candocChatContext?.();
    if (!context) return;
    savePending({
      id: crypto.randomUUID(),
      message: el("chat-input").value,
      context: { ...context },
    });
    action(sendPending);
  };
  el("chat-retry").onclick = () => action(sendPending);
  el("chat-discard").onclick = () => {
    savePending(null);
    render();
  };
  window.addEventListener("candoc-selection", target);
  window.addEventListener("pagehide", () => {
    stopped = true;
  });
  (async () => {
    try {
      const bootstrap = await (await fetch("/api/bootstrap")).json();
      token = bootstrap.token;
      pendingKey = `candoc-chat-pending:${location.origin}:${bootstrap.asset.asset_id}`;
      try {
        pending = JSON.parse(sessionStorage.getItem(pendingKey));
      } catch {
        pending = null;
      }
      await refresh();
      stream();
    } catch (error) {
      el("chat-error").textContent = error.message;
    }
  })();
})();
