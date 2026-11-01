import { expect, test, type Page } from '@playwright/test';

/** Fails the test on any uncaught page error or console error. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

const PAGES: [string, RegExp][] = [
  ['/', /Dashboard/],
  ['/structures', /Structures/],
  ['/editor', /Input editor/],
  ['/run', /Workflow/],
  ['/jobs', /Jobs/],
  ['/analysis', /Analy/],
  ['/pseudos', /Pseudopotentials/],
  ['/connections', /Connections/],
  ['/settings', /Settings/],
];

for (const [path, heading] of PAGES) {
  test(`page ${path} renders without errors`, async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
  });
}

test('build a structure, generate an input and open it in the editor', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/structures');
  await page.getByRole('button', { name: 'Build' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole('button', { name: /^Build$/ })
    .last()
    .click();
  await expect(page.locator('canvas').first()).toBeVisible();
  await page.getByRole('button', { name: /Create QE input/ }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Open in input editor/ })
    .click();
  await page.waitForURL('**/editor');
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 30_000 });
  // navigating away must not crash the 3D viewer / editor unmount
  await page.getByRole('link', { name: 'Jobs' }).click();
  await expect(page.getByRole('heading', { name: /Jobs/ }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('AI master switch hides every AI control', async ({ page }) => {
  await page.goto('/settings');
  const toggle = page.getByRole('switch', { name: /Enable AI features/ });
  await expect(page.getByLabel('Open AI assistant')).toBeVisible();
  await toggle.click({ force: true });
  await expect(page.getByLabel('Open AI assistant')).toHaveCount(0);
  await toggle.click({ force: true });
  await expect(page.getByLabel('Open AI assistant')).toBeVisible();
});
