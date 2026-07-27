/**
 * UI e2e smoke (11.10): wizard → policy edit → test prompt → ledger/audit evidence.
 */
import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test('login → wizard → policy edit → test prompt → audit row', async ({ page }) => {
  // ── login ──────────────────────────────────────────────────────────────────
  await page.goto('/');
  await page.fill('#email', 'admin@demo.firm');
  await page.fill('#password', 'vibe-router-demo-password');
  await page.click('button[type=submit]');
  await expect(page.locator('.topbar .lamp')).toBeVisible();

  // ── provider wizard (11.3) ─────────────────────────────────────────────────
  await page.click('a[href="#providers"]');
  await page.click('[data-testid=add-provider]');
  await page.selectOption('[data-testid=wizard-preset]', 'Ollama (local)');
  await page.click('text=Next');
  await page.fill('[data-testid=wizard-label]', 'E2E Local Model Server');
  await page.fill('[data-testid=wizard-url]', 'http://127.0.0.1:8229/v1');
  await page.click('text=Next');
  await page.click('[data-testid=wizard-save]');
  await expect(page.locator('[data-testid=wizard-result]')).toContainText('✓', { timeout: 15_000 });
  await page.click('text=Close');
  await expect(page.locator('.card', { hasText: 'E2E Local Model Server' })).toBeVisible();

  // ── policy edit (11.5) ─────────────────────────────────────────────────────
  await page.click('a[href="#policies"]');
  await expect(page.locator('.tier.local_only').first()).toBeVisible(); // boundary badges present
  await page.click('[data-testid=edit-tb_classification]');
  // local_only: only local models offered
  const options = await page.locator('[data-testid=policy-default] option').allTextContents();
  expect(options.every((o) => o.startsWith('ollama/'))).toBe(true);
  await page.click('[data-testid=policy-save]');
  await expect(page.locator('[data-testid=policy-error]')).toHaveCount(0);

  // ── test prompt → live request (11.10 core) ────────────────────────────────
  await page.click('a[href="#dashboard"]');
  await page.selectOption('[data-testid=test-class]', { label: 'tb_classification' });
  await page.click('text=Send test prompt');
  await expect(page.locator('[data-testid=test-result]')).toContainText('✓', { timeout: 15_000 });
  await expect(page.locator('[data-testid=test-result]')).toContainText('ollama/qwen3:14b');

  // ── evidence: audit shows the request event ────────────────────────────────
  await page.click('a[href="#audit"]');
  await expect(page.locator('td .chip', { hasText: 'request' }).first()).toBeVisible({ timeout: 10_000 });
});
