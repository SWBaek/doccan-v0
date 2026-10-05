async (page) => {
  const base = "http://127.0.0.1:52742";
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const check = (ok, message) => {
    if (!ok) throw Error(message);
  };
  const get = async (path) =>
    (await page.request.get(base + "/api/" + path)).json();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(base);
  await page.locator('[data-ref="#/texts/0"]').waitFor();
  await page.locator('[data-ref="#/texts/0"]').click();
  await page.locator("#crop:not([hidden])").waitFor();
  check(
    await page
      .locator("#location-note")
      .textContent()
      .then((t) => t.includes("(48.0, 57.0)")),
    "BOTTOMLEFT text region",
  );
  check(
    await page.locator("#cell-label").isHidden(),
    "Text must not show table controls",
  );
  await page.screenshot({ path: "verification/text-region.png" });
  await page.locator('[data-ref="#/pictures/0"]').click();
  await page.waitForFunction(
    () => document.getElementById("ref").textContent === "#/pictures/0",
  );
  check(
    await page
      .locator("#location-note")
      .textContent()
      .then((t) => t.includes("(511.0, 56.0)")),
    "Picture bbox",
  );
  check(
    await page
      .locator('[data-ref="#/pictures/0"] img')
      .evaluate((el) => el.complete && el.naturalWidth > 0),
    "Preserved picture asset",
  );
  await page.screenshot({ path: "verification/picture-region.png" });
  await page.locator("#page").fill("7");
  await page.locator("#page").press("Enter");
  await page.locator("#page").blur();
  await page.locator('[data-ref="#/tables/0"]').waitFor();
  await page.locator('[data-ref="#/texts/69"]').click();
  await page.waitForFunction(
    () => document.getElementById("ref").textContent === "#/texts/69",
  );
  await page.screenshot({ path: "verification/paragraph-region.png" });
  await page.locator('[data-ref="#/tables/0"] .meta').click();
  await page.waitForFunction(
    () =>
      document.getElementById("ref").textContent === "#/tables/0" &&
      document.getElementById("cell").value === "",
  );
  await page.screenshot({ path: "verification/table-region.png" });
  await page.locator('[data-ref="#/tables/0"] [data-cell="0"]').click();
  await page.waitForFunction(
    () => document.getElementById("cell").value === "0",
  );
  check(
    await page
      .locator("#location-note")
      .textContent()
      .then((t) => t.includes("TOPLEFT") && t.includes("345.6")),
    "TOPLEFT table cell",
  );
  await page.screenshot({ path: "verification/table-cell-region.png" });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.locator("#copy").click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check(
    clip.includes("#/tables/0") && clip.includes("index: 0"),
    "Agent clipboard identity",
  );
  const baseline = await get("document");
  const operations = [
    { op: "text", ref: "#/texts/0", value: "TEST browser-approved text" },
    { op: "type", ref: "#/texts/0", value: "section_header", level: 2 },
    {
      op: "cell",
      ref: "#/tables/0",
      cell: 0,
      value: "TEST browser-approved cell",
    },
  ];
  for (const operation of operations) {
    const session = await get("bootstrap");
    const before = await get("document");
    const response = await page.request.post(base + "/api/propose", {
      headers: { "X-Candoc-Token": session.token },
      data: {
        asset_id: session.asset.asset_id,
        revision: session.revision,
        reason:
          "Isolated browser test only; original document is not being corrected",
        ...operation,
      },
    });
    check(response.ok(), "Proposal creation");
    const proposal = await response.json();
    check(
      JSON.stringify(await get("document")) === JSON.stringify(before),
      "Proposal must not mutate document",
    );
    await page.locator("#proposals").click();
    await page.locator(`[data-approve="${proposal.id}"]`).click();
    await page.waitForFunction(() =>
      document
        .getElementById("dialog-content")
        .textContent.includes("대기 중인 제안이 없습니다"),
    );
    await page.locator("#close-dialog").click();
    await page.reload();
    await page.locator("#items .item").first().waitFor();
    const after = await get("document");
    if (operation.op === "text")
      check(
        after.texts[0].text === operation.value,
        "Text persisted after reload",
      );
    if (operation.op === "type")
      check(
        after.texts[0].label === operation.value && after.texts[0].level === 2,
        "Type persisted after reload",
      );
    if (operation.op === "cell")
      check(
        after.tables[0].data.table_cells[0].text === operation.value,
        "Cell persisted after reload",
      );
  }
  for (let i = 0; i < 3; i++) {
    await page.locator("#history").click();
    await page.locator("#undo").click();
    await page.waitForFunction(() => !document.getElementById("dialog").open);
    await page.waitForFunction(() =>
      document.getElementById("message").textContent.includes("되돌렸습니다"),
    );
  }
  check(
    JSON.stringify(await get("document")) === JSON.stringify(baseline),
    "All edits undone to baseline",
  );
  const s = await get("bootstrap");
  const forbidden = await page.request.post(base + "/api/propose", {
    data: {},
  });
  check(forbidden.status() === 403, "Missing token must be rejected");
  const foreign = await page.request.post(base + "/api/propose", {
    headers: { "X-Candoc-Token": s.token, Origin: "https://example.com" },
    data: {},
  });
  check(foreign.status() === 403, "Cross-origin mutation must be rejected");
  await page.locator("#page").fill("138");
  await page.locator("#page").blur();
  await page.waitForFunction(() =>
    document.getElementById("message").textContent.startsWith("138페이지"),
  );
  check(
    (await page.locator("#items .item").count()) === 22,
    "Whole document final page",
  );
  await page.waitForFunction(
    () =>
      document.getElementById("page-image").complete &&
      document.getElementById("page-image").naturalWidth > 0,
  );
  check(
    await page
      .locator("#page-image")
      .evaluate((el) => el.complete && el.naturalWidth === 1224),
    "Final page image",
  );
  await page.locator("#suspects").click();
  await page.locator('[data-result="#/tables/56"]').waitFor();
  check(
    (await page.locator('[data-result="#/tables/56"]').count()) === 1,
    "Overlapping table suspicion",
  );
  await page.locator("#close-dialog").click();
  const validation = await get("validate");
  check(validation.unchanged_source_files === 168, "Source fingerprints");
  check(errors.length === 0, "Browser errors: " + errors.join("; "));
  return {
    result: "PASS",
    operations: operations.map((o) => o.op),
    undo_count: 3,
    source_files_unchanged: validation.unchanged_source_files,
    final_page: 138,
    console_errors: errors,
    revision: (await get("bootstrap")).revision,
  };
}
