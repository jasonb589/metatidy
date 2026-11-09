/** Open the same compact controls a pointer or keyboard user would use. */
export async function revealLibraryTools(page) {
  if (!(await page.locator('#library-tools').evaluate(node => node.open))) await page.locator('#library-tools-toggle').click();
}

export async function revealSelectionActions(page) {
  if (!(await page.locator('#selection-clear').isVisible())) await page.locator('#selection-more-toggle').click();
}

export async function revealSavedFilters(page) {
  if (!(await page.locator('#library-saved-filters').evaluate(node => node.open))) await page.locator('#library-saved-filters-toggle').click();
}
