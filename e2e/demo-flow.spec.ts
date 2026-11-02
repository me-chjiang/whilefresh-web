import { fileURLToPath } from "node:url";

import { expect, test, type Locator, type Page } from "@playwright/test";

const screenshotPath = fileURLToPath(
  new URL(
    "../test-data/synthetic/screenshots/cart-fresh-01.png",
    import.meta.url,
  ),
);

async function swipeLeft(page: Page, row: Locator): Promise<void> {
  await row.scrollIntoViewIfNeeded();
  const box = await row.boundingBox();
  if (!box) {
    throw new Error("无法定位要左滑的食材");
  }
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.84, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.35, y, { steps: 6 });
  await page.mouse.up();
}

test("演示模式完成入库到清空数据的完整流程", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    consoleErrors.push(error.message);
  });

  await page.route("**/api/web-recipes**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "103468406",
          name: "五花肉炒时蔬",
          imageUrl: "",
          sourceUrl: "https://www.xiachufang.com/recipe/103468406/",
        },
      ]),
    });
  });
  await page.route("**/api/web-recipes/*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "103468406",
        name: "五花肉炒时蔬",
        imageUrl: "",
        rating: 8.6,
        ingredients: [{ raw: "五花肉 300g" }, { raw: "时蔬 200g" }],
        steps: [
          { order: 1, text: "五花肉切片。", imageUrl: "" },
          { order: 2, text: "下锅炒熟。", imageUrl: "" },
        ],
        tips: [],
        partial: false,
        attribution: {
          source: "下厨房",
          url: "https://www.xiachufang.com/recipe/103468406/",
          author: "测试作者",
        },
      }),
    });
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /^冰箱 · 共 \d+ 件$/ }),
  ).toBeVisible();

  await page.getByRole("button", { name: "我的", exact: true }).click();
  await page.getByRole("switch", { name: "演示模式" }).click();
  await expect(
    page.getByText("演示模式 · 示例数据，识别为预设结果，不联网"),
  ).toBeVisible();

  await page.getByRole("button", { name: "＋ 入库" }).click();
  await page
    .getByRole("button", { name: "相册截图 · 可多选", exact: true })
    .click();

  const fileChooserPromise = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "同意并选择图片", exact: true })
    .click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(screenshotPath);

  await expect(
    page.getByRole("button", { name: "同意并识别", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "同意并识别", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "请检查并修改", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("heading", { name: "食材 · 3 项", exact: true }),
  ).toBeVisible();

  const eggCard = page
    .locator("article")
    .filter({ has: page.getByLabel("鸡蛋的名称", { exact: true }) });
  await eggCard
    .getByRole("button", { name: "移入调料", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "常备调料 · 1 项", exact: true }),
  ).toBeVisible();

  const tofuCard = page
    .locator("article")
    .filter({ has: page.getByLabel("豆腐的名称", { exact: true }) });
  await tofuCard
    .getByRole("button", { name: "移入已忽略", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "已忽略 · 1 项", exact: true }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "确认入库 · 1 项食材", exact: true })
    .click();
  await expect(page.getByText("已加入冰箱", { exact: true })).toBeVisible();
  const fridgeHeading = page.getByRole("heading", {
    name: /^冰箱 · 共 \d+ 件$/,
  });
  await expect(fridgeHeading).toBeVisible();
  await expect(page.locator(".freshness-stamp").first()).toBeVisible();
  const seasoningTape = page
    .locator(".tape")
    .filter({ hasText: "常备调料" });
  await expect(seasoningTape).toBeVisible();
  const importedCountText = await fridgeHeading.innerText();
  const importedCount = Number(/共 (\d+) 件/.exec(importedCountText)?.[1]);
  expect(importedCount).toBeGreaterThan(0);

  const discardedRow = seasoningTape
    .locator("xpath=../..")
    .getByRole("button", { name: /^鸡蛋，/ });
  await swipeLeft(page, discardedRow);
  const discardButton = page.getByRole("button", {
    name: "扔掉鸡蛋",
    exact: true,
  });
  await expect(discardButton).toBeEnabled();
  await discardButton.click();
  await expect(discardedRow).toHaveCount(0);
  await expect(
    page.getByRole("heading", {
      name: `冰箱 · 共 ${importedCount - 1} 件`,
      exact: true,
    }),
  ).toBeVisible();

  await page.getByRole("button", { name: /^蓝莓，/ }).click();
  await expect(
    page.getByRole("heading", { name: "编辑食材", exact: true }),
  ).toBeVisible();
  await page.getByPlaceholder("保质天数").fill("123");
  await page
    .getByRole("button", { name: "保存修改", exact: true })
    .click();
  await expect(
    page.getByText("以后同类食材都按这个存放位置和保质天数吗？", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "记住这个设置", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: /^冰箱 · 共 \d+ 件$/ }),
  ).toBeVisible();

  await page.getByRole("button", { name: "我的", exact: true }).click();
  await expect(page.getByLabel("蓝莓的保质天数")).toHaveValue("123");

  await page.getByRole("button", { name: /^清冰箱/ }).click();
  await expect(
    page.getByRole("heading", { name: "清冰箱", exact: true }),
  ).toBeVisible();
  const clearItems = page.locator("main button[aria-pressed]");
  const clearItemCount = await clearItems.count();
  for (let index = 0; index < clearItemCount; index += 1) {
    const item = clearItems.nth(index);
    if ((await item.getAttribute("aria-pressed")) === "true") {
      await item.click();
    }
  }
  const porkButton = page.getByRole("button", { name: /^五花肉(?:，|$)/ });
  if ((await porkButton.getAttribute("aria-pressed")) !== "true") {
    await porkButton.click();
  }
  await expect(page.getByText(/^已选 1 \/ \d+$/)).toBeVisible();
  await page
    .getByRole("button", { name: "搜下厨房", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "菜谱", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("搜索菜名")).toHaveValue("五花肉");
  await page
    .getByRole("button", { name: /^五花肉炒时蔬/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "菜谱卡", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "查看原菜谱", exact: true }),
  ).toHaveAttribute(
    "href",
    "https://www.xiachufang.com/recipe/103468406/",
  );

  await page.getByRole("button", { name: "待买", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "待买", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "暂时没有待买的食材",
      exact: true,
    }),
  ).toBeVisible();

  await page.getByRole("button", { name: "我的", exact: true }).click();
  await page.getByRole("button", { name: "服务", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "服务", exact: true }),
  ).toBeVisible();
  for (const label of [
    "DeepSeek 密钥",
    "Lexmount 密钥",
    "Lexmount 项目 ID",
  ]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  const sourceStatuses = page
    .locator("main")
    .getByText(/^(?:已配置|内置|未配置)$/);
  await expect(sourceStatuses).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
    await expect(sourceStatuses.nth(index)).toBeVisible();
  }

  const passwordInputs = page.locator('main input[type="password"]');
  await expect(passwordInputs).toHaveCount(3);
  const passwordValues = await passwordInputs.evaluateAll((inputs) =>
    inputs.map((input) =>
      input instanceof HTMLInputElement ? input.value : "",
    ),
  );
  const serviceText = await page.locator("main").innerText();
  const configuredSecrets = [
    process.env.WHILEFRESH_DEEPSEEK_API_KEY,
    process.env.WHILEFRESH_LEXMOUNT_API_KEY,
    process.env.WHILEFRESH_LEXMOUNT_PROJECT_ID,
  ].filter((value): value is string => Boolean(value?.trim()));
  expect(passwordValues.every((value) => value === "")).toBe(true);
  expect(
    configuredSecrets.some(
      (value) =>
        serviceText.includes(value) || passwordValues.includes(value),
    ),
  ).toBe(false);
  expect(/\bsk-[A-Za-z0-9_-]{20,}\b/.test(serviceText)).toBe(false);

  await page
    .getByRole("button", { name: "返回", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "我的", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "删除全部数据", exact: true })
    .click();
  const deleteDialog = page.getByRole("alertdialog", {
    name: "确认操作",
  });
  await expect(deleteDialog).toBeVisible();
  await deleteDialog
    .getByRole("button", { name: "删除全部", exact: true })
    .click();
  await expect(page.getByText("已清空数据", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "冰箱", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "冰箱 · 共 0 件", exact: true }),
  ).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
