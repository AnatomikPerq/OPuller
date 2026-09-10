import { test } from '@playwright/test';
import { openApp, expect, getState, withStore, runCommand, drawRect } from './helpers';

async function projects(page: any): Promise<any[]> {
  return page.evaluate(async () => (window as any).__opuller.projects.listProjects());
}

test.describe('home screen and project library', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    // start with an empty library
    await page.evaluate(async () => {
      const mod = (window as any).__opuller.projects;
      for (const p of await mod.listProjects()) await mod.deleteProject(p.id);
    });
  });

  test('opens from the logo, creates a document from a preset and lists it as a project', async ({ page }) => {
    await page.getByTestId('home-button').click();
    await expect(page.getByTestId('home-screen')).toBeVisible();
    await expect(page.getByTestId('home-close')).toBeVisible();
    await page.getByTestId('home-preset-insta').click();
    await expect(page.getByTestId('home-screen')).toHaveCount(0);
    let s = await getState(page);
    expect(s.doc.artboards[0].width).toBe(1080);
    expect(s.doc.artboards[0].height).toBe(1080);
    // drawing commits → the document is persisted to the library (debounced)
    await drawRect(page, 100, 100, 200, 100);
    await expect.poll(async () => (await projects(page)).length, { timeout: 10_000 }).toBe(1);
    const list = await projects(page);
    expect(list[0].id).toBe(s.doc.id);
    expect(list[0].objects).toBe(1);
    expect(list[0].thumbnail).toMatch(/^data:image\/jpeg/);
    // the card shows up with the "open now" state and a Back button
    await runCommand(page, 'file.home');
    await expect(page.getByTestId(`home-project-${s.doc.id}`)).toBeVisible();
    await expect(page.getByTestId('home-back')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('home-screen')).toHaveCount(0);
    s = await getState(page);
    expect(Object.values(s.doc.nodes).filter((n: any) => n.type === 'path').length).toBe(1);
  });

  test('rename, duplicate, open and delete projects', async ({ page }) => {
    const id = await drawRect(page, 50, 50, 100, 100);
    void id;
    const docId = (await getState(page)).doc.id;
    await runCommand(page, 'file.saveToLibrary');
    await expect.poll(async () => (await projects(page)).length).toBe(1);
    await runCommand(page, 'file.projects');
    await expect(page.getByTestId('home-nav-projects')).toHaveClass(/active/);
    // rename via the card menu
    await page.getByTestId(`home-project-menu-${docId}`).click();
    await page.getByTestId('home-project-rename').click();
    await page.locator('.home-card-rename').fill('Logo draft');
    await page.locator('.home-card-rename').press('Enter');
    await expect.poll(async () => (await projects(page))[0].name).toBe('Logo draft');
    // duplicate
    await page.getByTestId(`home-project-menu-${docId}`).click();
    await page.getByTestId('home-project-duplicate').click();
    await expect.poll(async () => (await projects(page)).length).toBe(2);
    const copy = (await projects(page)).find((p) => p.id !== docId)!;
    expect(copy.name).toBe('Logo draft copy');
    // open the copy: same content, different id
    await page.getByTestId(`home-project-${copy.id}`).locator('.home-card-thumb').click();
    await expect(page.getByTestId('home-screen')).toHaveCount(0);
    let s = await getState(page);
    expect(s.doc.id).toBe(copy.id);
    expect(s.doc.name).toBe('Logo draft copy');
    expect(Object.values(s.doc.nodes).filter((n: any) => n.type === 'path').length).toBe(1);
    // delete the original
    await runCommand(page, 'file.projects');
    await page.getByTestId(`home-project-menu-${docId}`).click();
    await page.getByTestId('home-project-delete').click();
    // in-app confirmation instead of the browser's confirm()
    await expect(page.getByTestId('confirm-ok')).toBeVisible();
    await expect(page.getByTestId('confirm-message')).toContainText('Delete');
    await page.getByTestId('confirm-cancel').click();
    await expect.poll(async () => (await projects(page)).length).toBe(2);
    await page.getByTestId(`home-project-menu-${docId}`).click();
    await page.getByTestId('home-project-delete').click();
    await page.getByTestId('confirm-ok').click();
    await expect.poll(async () => (await projects(page)).length).toBe(1);
    // search filters
    await page.getByTestId('home-search').fill('nothing-matches');
    await expect(page.locator('.home-empty')).toBeVisible();
    await page.getByTestId('home-back').click();
    s = await getState(page);
    expect(s.doc.id).toBe(copy.id);
    await withStore(page, (st) => st.clearSelection());
  });

  test('samples and learn sections; blank documents are not stored', async ({ page }) => {
    await runCommand(page, 'help.tour');
    await expect(page.getByTestId('home-nav-learn')).toHaveClass(/active/);
    await expect(page.locator('.home-tips .tip').first()).toBeVisible();
    await page.getByTestId('home-nav-samples').click();
    await expect(page.getByTestId('home-sample-bird')).toBeVisible();
    await page.getByTestId('home-sample-bird').locator('.home-card-thumb').click();
    await expect.poll(async () => (await getState(page)).doc.name).toBe('Bird from circles');
    // the sample itself is persisted only after an edit; a blank new document never is
    await runCommand(page, 'file.home');
    await page.getByTestId('home-preset-a4').click();
    await page.waitForTimeout(2000);
    const list = await projects(page);
    expect(list.every((p) => p.name !== 'Untitled' || p.objects > 0)).toBe(true);
  });
});
