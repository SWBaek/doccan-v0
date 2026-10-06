async (page) => {
  const base = "http://127.0.0.1:52742",
    out = "verification/review-ux-20261006/",
    check = (v, m) => {
      if (!v) throw Error(m);
    };
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.unroute("**/api/conversation/state");
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(base);
  const boot = await (await page.request.get(base + "/api/bootstrap")).json(),
    headers = { "X-Candoc-Token": boot.token };
  const get = async (p) =>
      (await page.request.get(base + "/api/" + p, { headers })).json(),
    state = () => get("conversation/state");
  const baseline = await get("document");
  const wait = async (mode) =>
    page.waitForFunction(
      (m) => document.querySelector("#header-progress").textContent === m,
      mode,
      { timeout: 60000 },
    );
  const revision = async (n) =>
    page.waitForFunction(
      async (n) => {
        const b = await (await fetch("/api/bootstrap")).json();
        return b.revision === n;
      },
      n,
      { timeout: 60000 },
    );
  if ((await state()).mode === "idle") {
    await wait("시작 전");
    await page.locator("#conversation-models").click();
    await page.waitForFunction(
      () => document.querySelector("#conversation-model").options.length === 2,
    );
    await page.locator("#conversation-effort").selectOption("medium");
    await page.locator("#conversation-start").click();
  }
  await wait("판단 대기");
  let s = await state(),
    first = s.current;
  const oldApproval = {
    id: await page.evaluate(() => crypto.randomUUID()),
    message: "응",
    presentation: first.id,
    generation: s.generation,
    context: Object.fromEntries(
      Object.entries(first.context).filter(([k]) =>
        ["asset_id", "revision", "ref", "cell", "group_id"].includes(k),
      ),
    ),
    inspect: false,
  };
  // Hold one old state response while a newer scope response is displayed.
  let release,
    held = false,
    delivered = false,
    intercept = true;
  const gate = new Promise((r) => (release = r));
  await page.route("**/api/conversation/state", async (route) => {
    if (intercept) {
      intercept = false;
      const response = await route.fetch();
      held = true;
      await gate;
      await route.fulfill({ response });
      delivered = true;
    } else await route.continue();
  });
  for (let i = 0; i < 50 && !held; i++) await page.waitForTimeout(100);
  check(held, "old response captured");
  await page.locator("#offer-targets > summary").click();
  await page.locator("[data-scope]").first().uncheck();
  await page.locator("#scope-submit").click();
  await page.waitForFunction(() =>
    document
      .querySelector(".conversation-current h2")
      ?.textContent.startsWith("56개"),
  );
  release();
  for (let i = 0; i < 50 && !delivered; i++) await page.waitForTimeout(100);
  check(delivered, "old response delivered after new state");
  await page.unroute("**/api/conversation/state");
  await page.waitForFunction(
    () => document.querySelector("#scope-banner")?.hidden === true,
  );
  check(
    (await state()).current.refs.length === 56,
    "late old state cannot restore old offer",
  );
  // Lose the new exact-scope response after the app persisted it.
  let scopeRequest;
  await page.route("**/api/conversation/control", async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === "scope") {
      scopeRequest = body;
      await route.fetch();
      await route.abort("connectionfailed");
    } else await route.continue();
  });
  await page.locator("#offer-targets > summary").click();
  await page.locator("[data-scope]").nth(20).uncheck();
  await page.locator("#scope-submit").click();
  await page.locator("#conversation-check").waitFor({ state: "visible" });
  await page.unroute("**/api/conversation/control");
  await page.locator("#conversation-check").click();
  await page.waitForFunction(
    () => document.querySelector("#conversation-check").hidden,
  );
  s = await state();
  check(
    s.current.refs.length === 55 && s.revision === 0,
    "lost scope response recovered without apply",
  );
  check(
    !s.current.refs.includes(first.refs[0]) &&
      !s.current.refs.includes(first.refs[20]),
    "arbitrary exceptions preserved",
  );
  const freshId = s.current.id,
    generation = s.generation;
  const duplicateScope = await page.request.post(
    base + "/api/conversation/control",
    { headers, data: scopeRequest },
  );
  check(
    duplicateScope.ok() && (await state()).generation === generation,
    "scope retry is idempotent",
  );
  await page.request.post(base + "/api/conversation/message", {
    headers,
    data: oldApproval,
  });
  check((await state()).revision === 0, "old scope approval blocked");
  await page.screenshot({ path: out + "safety-updated-scope.png" });
  // A real button click pair; the app loses the committed response and reconciles by ID.
  let approvalRequest,
    approvalCalls = 0;
  await page.route("**/api/conversation/message", async (route) => {
    approvalCalls++;
    approvalRequest = route.request().postDataJSON();
    await route.fetch();
    await route.abort("connectionfailed");
  });
  await page.locator('[data-decision="승인해"]').evaluate((b) => {
    b.click();
    b.click();
  });
  await revision(1);
  await page.locator("#conversation-check").waitFor({ state: "visible" });
  await page.unroute("**/api/conversation/message");
  await page.waitForFunction(
    () => !document.querySelector("#conversation-check").disabled,
  );
  await page.locator("#conversation-check").click();
  await page.waitForFunction(
    () => document.querySelector("#conversation-check").hidden,
  );
  await wait("판단 대기");
  check(approvalCalls === 1, "double click sent one approval");
  check(
    (await get("history"))[0].refs.length === 55,
    "approved exact amended scope",
  );
  await page.request.post(base + "/api/conversation/message", {
    headers,
    data: approvalRequest,
  });
  check(
    (await state()).revision === 1,
    "reconnected approval ID cannot replay",
  );
  await page.screenshot({ path: out + "safety-recovered-result.png" });
  // Change one pending target via the existing manual editor and approval path.
  s = await state();
  const pending = s.current,
    staleApproval = {
      ...oldApproval,
      id: await page.evaluate(() => crypto.randomUUID()),
      presentation: pending.id,
      generation: s.generation,
      context: Object.fromEntries(
        Object.entries(pending.context).filter(([k]) =>
          ["asset_id", "revision", "ref", "cell", "group_id"].includes(k),
        ),
      ),
    };
  await page.locator("#manual-toggle").click();
  const original = await page.locator("#edit-value").inputValue();
  await page.locator("#edit-value").fill(original + " [isolated UI conflict]");
  await page
    .locator("#reason")
    .fill("격리 UI 시험: 대화 대기 중 같은 항목 변경");
  await page.locator("#manual-propose").click();
  await page.locator("#proposal-content [data-approve]").click();
  await revision(2);
  await page.locator('[data-close="editor-dialog"]').click();
  await page.reload();
  await wait("재검수 필요");
  check(
    !(await page.locator("#editor-dialog").isVisible()),
    "closed manual editor stays closed on reload",
  );
  await page.waitForFunction(() =>
    document
      .querySelector(".conversation-current")
      ?.textContent.includes("기존 승인은 사용할 수 없습니다"),
  );
  const conflict = await page.request.post(base + "/api/conversation/message", {
    headers,
    data: staleApproval,
  });
  check(conflict.status() === 409, "changed document rejects stale approval");
  check((await state()).revision === 2, "conflict does not apply");
  await page.screenshot({ path: out + "safety-stale.png" });
  await page.locator("#tools-toggle").click();
  await page.locator("#history").click();
  await page.locator("#undo").click();
  await revision(3);
  // Start a selected-cell question. Later source selection must not change its proposal.
  await page.locator("#explore-toggle").click();
  await page.locator("#document-view").click();
  await page.locator("#page").fill("86");
  await page.locator("#page").dispatchEvent("change");
  await page.locator('#items .item[data-ref="#/tables/56"] .meta').click();
  await page.locator("#source-explore > summary").click();
  await page.locator("#evidence-cell").selectOption("73");
  await page.waitForFunction(() => window.candocChatContext()?.cell === 73);
  await page.locator("#ask-selection").click();
  await page
    .locator("#conversation-input")
    .fill("[propose] 선택한 셀의 수정안을 준비해");
  // Stale approval failure leaves an error state; resume is explicit and never replays.
  if ((await state()).mode === "error") {
    await page.locator("#tools-toggle").click();
    await page.keyboard.press("Escape");
    const response = await page.request.post(
      base + "/api/conversation/control",
      { headers, data: { action: "resume" } },
    );
    check(response.ok(), "resume after conflict");
    await wait("대화 중");
  }
  await page.locator("#conversation-send").click();
  await page.waitForFunction(
    (id) =>
      document.querySelector(".conversation-current")?.dataset.offer !== id &&
      document
        .querySelector(".conversation-current h2")
        ?.textContent.startsWith("1개"),
    pending.id,
    { timeout: 60000 },
  );
  await wait("판단 대기");
  s = await state();
  check(
    s.current.proposal.request.cell === 73,
    "new question frozen to selected cell",
  );
  await page.locator("#evidence-cell").selectOption("72");
  await page.waitForFunction(() => window.candocChatContext()?.cell === 72);
  const selectedBefore = await get("item?ref=%23%2Ftables%2F56&cell=72");
  await page.locator("#conversation-input").fill("응");
  await page.locator("#conversation-send").click();
  await revision(4);
  const selectedAfter = await get("item?ref=%23%2Ftables%2F56&cell=72"),
    applied = await get("item?ref=%23%2Ftables%2F56&cell=73");
  check(
    selectedAfter.item.data.table_cells[72].text ===
      selectedBefore.item.data.table_cells[72].text,
    "different visible cell remains unchanged",
  );
  check(
    applied.item.data.table_cells[73].text === "Synthetic correction",
    "only proposed cell applied",
  );
  await page.locator("#conversation-pause").click();
  await wait("일시정지");
  for (let i = 0; i < 2; i++) {
    await page.locator("#tools-toggle").click();
    await page.locator("#history").click();
    await page.locator("#undo").click();
    await revision(5 + i);
  }
  check(
    JSON.stringify(await get("document")) === JSON.stringify(baseline),
    "all safety trial changes undone",
  );
  check(errors.length === 0, "page exceptions " + errors.join());
  return {
    pass: true,
    lateState: true,
    lostScope: true,
    oldApproval: true,
    doubleClickRequests: approvalCalls,
    lostApproval: true,
    staleStatus: conflict.status(),
    cell: 73,
    visibleOtherCell: 72,
    finalRevision: (await state()).revision,
    errors,
  };
}
