import { expect, test } from "@playwright/test";

test("serves the production PWA and completes the canonical plugin handshake", async ({ page }) => {
  const response = await page.goto("/p/in-progress/project-map");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-security-policy"]).toContain("default-src 'self'");

  await expect(page).toHaveTitle(/Project map — in-progress/);
  await expect(page.getByRole("tab", { name: /Project map/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const plugin = page.frameLocator('iframe[title="Project map — in-progress"]');
  await expect(plugin.getByRole("heading", { name: "in-progress" })).toBeVisible();
  await expect(plugin.getByRole("region", { name: "Project summary" })).toBeVisible();
  await expect(page.locator('iframe[title="Project map — in-progress"]')).toHaveAttribute(
    "sandbox",
    "allow-scripts",
  );

  await expect
    .poll(() =>
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        return Boolean(registration.active);
      }),
    )
    .toBe(true);
});

test("reports a lost host connection and reconnects without reloading", async ({
  context,
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Host connected", { exact: true })).toBeVisible();

  await context.setOffline(true);
  await expect(
    page.getByText("Browser offline — durable processes continue on the host."),
  ).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByText("Host connected", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Browser offline — durable processes continue on the host."),
  ).toHaveCount(0);
});

test("keeps primary navigation reachable at a narrow phone viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const projects = page.getByRole("button", { name: "Open projects" });
  const notifications = page.getByRole("button", { name: /^Notifications/ });
  await expect(projects).toBeVisible();
  await expect(notifications).toBeVisible();
  for (const control of [projects, notifications]) {
    const box = await control.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }

  await projects.click();
  await expect(page.getByRole("dialog", { name: "Projects" })).toBeVisible();
  await page.getByRole("button", { name: "Close projects" }).click();
  await page.getByRole("tab", { name: /Project map/ }).click();
  await expect(
    page.frameLocator('iframe[title="Project map — in-progress"]').getByRole("heading", {
      name: "in-progress",
    }),
  ).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
