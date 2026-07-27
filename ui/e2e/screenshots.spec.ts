/**
 * Review-packet screenshot capture (15.1). Run manually:
 *   SCREENSHOTS=1 pnpm --filter @vibe-ai-router/ui exec playwright test screenshots
 * Writes docs/screenshots/*.png at 1280×800.
 */
import { test, expect } from '@playwright/test';

const enabled = process.env['SCREENSHOTS'] === '1';

test.skip(!enabled, 'screenshot capture is opt-in');
test.use({ viewport: { width: 1280, height: 800 } });

test('capture admin walkthrough', async ({ page }) => {
  const shot = (name: string): Promise<Buffer> =>
    page.screenshot({ path: `../docs/screenshots/${name}.png`, fullPage: false });

  await page.goto('/');
  await shot('01-login');
  await page.fill('#email', 'admin@demo.firm');
  await page.fill('#password', 'vibe-router-demo-password');
  await page.click('button[type=submit]');
  await expect(page.locator('.topbar .lamp')).toBeVisible();

  // seed a little traffic so the dashboard isn't empty
  await page.selectOption('[data-testid=test-class]', { label: 'tb_classification' });
  await page.click('text=Send test prompt');
  await expect(page.locator('[data-testid=test-result]')).toContainText('✓', { timeout: 15_000 });
  await page.reload();
  await expect(page.locator('.topbar .lamp')).toBeVisible();
  await shot('02-dashboard');

  await page.click('a[href="#providers"]');
  await page.waitForTimeout(400);
  await shot('03-providers');

  await page.click('a[href="#catalog"]');
  await page.waitForTimeout(400);
  await shot('04-catalog');

  await page.click('a[href="#policies"]');
  await expect(page.locator('.tier.local_only').first()).toBeVisible();
  await shot('05-policies');
  await page.click('[data-testid=edit-tb_classification]');
  await page.waitForTimeout(300);
  await shot('06-policy-editor');
  await page.click('text=Cancel');

  await page.click('a[href="#audit"]');
  await page.waitForTimeout(600);
  await shot('07-audit');

  await page.click('a[href="#settings"]');
  await page.waitForTimeout(400);
  await shot('08-settings');
});
