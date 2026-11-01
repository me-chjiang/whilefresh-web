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
    page.getByRole("heading", { name: "调料 · 1 项", exact: true }),
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
  await expect(
    page.getByRole("heading", { name: "冰箱 · 共 9 件", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".freshness-stamp").first()).toBeVisible();

  const usedRow = page.getByRole("button", { name: /^茭白，/ });
  await swipeLeft(page, usedRow);
  const useButton = page.getByRole("button", {
    name: "用掉茭白",
    exact: true,
  });
  await expect(useButton).toBeEnabled();
  await useButton.click();
  await expect(usedRow).toHaveCount(0);

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
  const porkButton = page.getByRole("button", { name: /^五花肉(?:，|$)/ });
  if ((await porkButton.getAttribute("aria-pressed")) !== "true") {
    await porkButton.click();
  }
  await expect(page.getByText(/已选 [1-9]\d* \/ \d+/)).toBeVisible();
  await page
    .getByRole("button", { name: "查找菜谱", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "清冰箱结果", exact: true }),
  ).toBeVisible();

  const recipeCards = page.locator(
    'main button[aria-label*="，有 "][aria-label*="，缺 "]',
  );
  let recipeWithMissing: Locator | null = null;
  for (let index = 0; index < (await recipeCards.count()); index += 1) {
    const candidate = recipeCards.nth(index);
    const label = (await candidate.getAttribute("aria-label")) ?? "";
    const missing = /，缺 (\d+)，难度 /.exec(label);
    if (missing && Number(missing[1]) > 0) {
      recipeWithMissing = candidate;
      break;
    }
  }
  expect(recipeWithMissing).not.toBeNull();
  await recipeWithMissing!.click();
  await expect(
    page.getByRole("heading", { name: "菜谱卡", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "缺料加入待买", exact: true })
    .click();

  await expect(
    page.getByRole("heading", { name: "待买", exact: true }),
  ).toBeVisible();
  await expect(page.locator("main li.item").first()).toBeVisible();
  await page
    .getByRole("button", { name: "复制清单", exact: true })
    .click();
  await expect(
    page.getByText("已复制待买清单", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("待买清单");

  await page.getByRole("button", { name: "我的", exact: true }).click();
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
