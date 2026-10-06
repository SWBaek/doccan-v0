async (page) => {
  const base = "http://127.0.0.1:52742",
    out = "verification/review-ux-20261006/";
  const check = (v, m) => {
    if (!v) throw Error(m);
  };
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(base);
  const boot = await (await page.request.get(base + "/api/bootstrap")).json();
  const headers = { "X-Candoc-Token": boot.token };
  const get = async (p) =>
    (await page.request.get(base + "/api/" + p, { headers })).json();
  const state = () => get("conversation/state"),
    baseline = await get("document");
  const wait = async (mode) =>
    page.waitForFunction(
      (m) => document.querySelector("#header-progress").textContent === m,
      mode,
      { timeout: 60000 },
    );
  await wait("시작 전");
  for (const size of [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    check(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "start horizontal overflow",
    );
    await page.screenshot({ path: out + `after-start-${size.width}.png` });
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  check(
    !(await page.locator("#editor-dialog").isVisible()),
    "manual editor closed initially",
  );
  check(
    !(await page.locator("#conversation-configure").isVisible()),
    "no duplicate settings apply before start",
  );
  await page.locator("#conversation-models").click();
  await page.waitForFunction(
    () => document.querySelector("#conversation-model").options.length === 2,
  );
  await page.locator("#conversation-model").selectOption("mock-b");
  check(
    (
      await page.locator("#conversation-effort option").allTextContents()
    ).join() === "high",
    "model-specific effort options",
  );
  await page.locator("#conversation-start").click();
  await wait("판단 대기");
  await page.locator("#crop").waitFor({ state: "visible" });
  let s = await state(),
    first = s.current;
  check(
    s.settings.model === "mock-b" &&
      s.chat.runs.at(-1).target.execution.effort === "high",
    "actual model and effort request",
  );
  check(
    first.refs.length === 57 && s.job.status === "completed",
    "whole document diagnostic and first batch",
  );
  check(
    !(await page.locator("#review-settings").isVisible()),
    "settings collapsed after start",
  );
  check(
    (await page
      .locator("#conversation-transcript #conversation-offer")
      .count()) === 1,
    "single inline proposal",
  );
  check(
    (await page
      .locator("#conversation-offer")
      .evaluate((e) => getComputedStyle(e).overflow)) === "visible",
    "proposal has no independent scroll",
  );
  await page.screenshot({ path: out + "after-review-1366.png" });
  await page.locator("#evidence-next").click();
  await page.waitForFunction(
    (ref) => window.candocChatContext()?.ref === ref,
    first.refs[1],
  );
  check(
    (await state()).current.id === first.id,
    "next source case preserves current offer",
  );
  await page.locator("#source-explore > summary").click();
  const other = await page
    .locator("#evidence-item option")
    .evaluateAll(
      (list, refs) =>
        list.find((o) => o.value && !refs.includes(o.value)).value,
      first.refs,
    );
  await page.locator("#evidence-item").selectOption(other);
  await page.waitForFunction(
    (ref) => window.candocChatContext()?.ref === ref,
    other,
  );
  await page.waitForFunction(
    () => !document.querySelector("#evidence-return").hidden,
  );
  check(
    (await state()).current.id === first.id,
    "unrelated source selection preserves scope",
  );
  await page.locator("#source-page").click();
  await page.locator("#zoom").fill("200");
  check(
    (await page.locator("#page-stage").evaluate((e) => e.style.width)) ===
      "200%",
    "full-page zoom",
  );
  await page.locator("#zoom").fill("100");
  await page.locator("#source-region").click();
  await page.locator("#ask-selection").click();
  check(
    (await page.locator("#composer-label").textContent()) ===
      "선택한 항목으로 새 질문",
    "explicit new-question mode",
  );
  await page.locator("#question-reset").click();
  await page.locator("#manual-toggle").click();
  await page.locator("#reason").fill("격리 UI 시험 초안");
  await page.locator('[data-close="editor-dialog"]').click();
  check(
    (await state()).current.id === first.id,
    "manual editor close preserves conversation",
  );
  await page.locator("#manual-toggle").click();
  check(
    (await page.locator("#reason").inputValue()) === "격리 UI 시험 초안",
    "manual draft retained",
  );
  await page.keyboard.press("Escape");
  check(
    await page
      .locator("#manual-toggle")
      .evaluate((e) => e === document.activeElement),
    "dialog restores focus",
  );
  await page.locator("#evidence-return").click();
  await page.locator("#source-explore > summary").click();
  await page.locator("#offer-targets > summary").click();
  check(
    (await page.locator("[data-scope]").count()) === 57,
    "complete target list",
  );
  await page.locator("[data-scope]").last().uncheck();
  check(
    await page.locator("[data-decision]").first().isDisabled(),
    "dirty scope blocks approval",
  );
  check(
    await page.locator("#conversation-send").isDisabled(),
    "dirty scope blocks ambiguous natural approval",
  );
  await page.reload();
  await wait("판단 대기");
  check(
    !(await page.locator("[data-scope]").last().isChecked()),
    "unsent exception retained on reload",
  );
  check(
    await page
      .locator("#scope-count")
      .textContent()
      .then((t) => t.includes("56개")),
    "updated draft count",
  );
  await page.locator("#scope-submit").click();
  await page.waitForFunction(() =>
    document
      .querySelector(".conversation-current h2")
      ?.textContent.includes("56개"),
  );
  s = await state();
  check(
    s.current.refs.length === 56 && !s.current.refs.includes(first.refs.at(-1)),
    "new exact subset",
  );
  check(s.revision === boot.revision, "scope edit never applies document");
  await page.screenshot({ path: out + "after-exception.png" });
  const offer = s.current.id;
  await page.reload();
  await wait("판단 대기");
  check(
    (await state()).current.id === offer,
    "pending exact proposal restored",
  );
  const send = async (text) => {
    await page.locator("#conversation-input").fill(text);
    await page.locator("#conversation-send").click();
    await page.waitForFunction(
      () =>
        !document.querySelector("#conversation-send").disabled ||
        document.querySelector("#header-progress").textContent === "확인 필요",
      null,
      { timeout: 60000 },
    );
  };
  await send("왜 그렇게 생각해?");
  await wait("대화 중");
  check((await state()).revision === 0, "question does not approve");
  await send("응");
  await wait("판단 대기");
  check(
    (await state()).revision === 0,
    "ambiguous acknowledgement re-confirms only",
  );
  await send("응");
  await wait("판단 대기");
  s = await state();
  check(
    s.revision === 1 && s.current.refs.length === 42,
    "clear approval applied once and next issue",
  );
  const history = await get("history");
  check(
    history[0].refs.length === 56 &&
      history[0].conversation_approval.message === "응",
    "exact scope and real user receipt",
  );
  check(
    await page
      .locator(".receipt-result")
      .allTextContents()
      .then((a) => a.some((t) => t.includes("56개 항목 승인 반영 완료"))),
    "receipt visible in conversation",
  );
  await page.screenshot({ path: out + "after-result-next.png" });
  await page.locator('[data-decision="그대로 둬"]').click();
  await wait("판단 대기");
  await page.waitForFunction(() =>
    document
      .querySelector(".conversation-current h2")
      ?.textContent.startsWith("1개"),
  );
  check((await state()).revision === 2, "keep through displayed card");
  await page.locator('[data-decision="보류해"]').click();
  await wait("판단 대기");
  s = await state();
  check(s.revision === 3, "defer through displayed card");
  await page.locator("#conversation-pause").click();
  await wait("일시정지");
  check(
    await page.locator("#conversation-send").isDisabled(),
    "paused cannot approve",
  );
  const runs = (await state()).chat.runs.length;
  await page.screenshot({ path: out + "after-paused.png" });
  await page.locator("#conversation-resume").click();
  await wait("대화 중");
  check(
    (await state()).chat.runs.length === runs,
    "resume does not resend prior work",
  );
  await send("[error-once] 설명을 이어줘");
  await wait("확인 필요");
  await page.screenshot({ path: out + "after-error.png" });
  check(
    !(await page.locator("#conversation-pause").isVisible()) &&
      (await page.locator("#conversation-retry").isVisible()),
    "state appropriate retry only",
  );
  await page.locator("#conversation-retry").click();
  await wait("대화 중");
  check((await state()).revision === 3, "retry never reapplies approval");
  await page
    .locator("#conversation-input")
    .fill("[slow] 원본 불확실성을 설명해");
  await page.locator("#conversation-send").click();
  await wait("답변 준비 중");
  await page.screenshot({ path: out + "after-running.png" });
  await page.locator("#conversation-pause").click();
  await wait("일시정지");
  await page.locator("#conversation-resume").click();
  await wait("대화 중");
  for (const size of [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    check(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "review horizontal overflow",
    );
    check(
      (await page.locator("#conversation-send").boundingBox()).y +
        (await page.locator("#conversation-send").boundingBox()).height <=
        size.height,
      "composer accessible",
    );
    if (size.width === 390) {
      await page.locator("#view-evidence").click();
      check(
        (await page.locator(".source").isVisible()) &&
          !(await page.locator(".converted").isVisible()),
        "narrow evidence switch",
      );
      await page.screenshot({ path: out + "after-evidence-390.png" });
      await page.locator("#view-conversation").click();
    }
    await page.screenshot({ path: out + `after-flow-${size.width}.png` });
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.locator("#conversation-pause").click();
  await wait("일시정지");
  for (let i = 0; i < 3; i++) {
    await page.locator("#tools-toggle").click();
    await page.locator("#history").click();
    await page.locator("#undo").click();
    await page.waitForFunction(
      (n) => document.querySelector("#asset").title.endsWith("revision " + n),
      4 + i,
    );
  }
  check(
    JSON.stringify(await get("document")) === JSON.stringify(baseline),
    "all document changes exactly undone",
  );
  check(errors.length === 0, "browser exceptions: " + errors.join("; "));
  return {
    pass: true,
    model: "mock-b",
    effort: "high",
    first: 57,
    approved: 56,
    kept: 42,
    deferred: 1,
    revision: (await state()).revision,
    viewports: [1366, 1920, 390],
    errors,
  };
}
