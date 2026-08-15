import type { WorkspaceLeaf } from 'obsidian';

import ailuBrandMarkUrl from '../../assets/ailu-ribbon-icon.png';

const AILU_BRAND_MARK_CLASS = 'ailu-brand-mark';

interface WorkspaceLeafWithTabIcon extends WorkspaceLeaf {
  tabHeaderInnerIconEl?: HTMLElement;
}

function applyAiluBrandMark(element: HTMLElement): void {
  element.addClass(AILU_BRAND_MARK_CLASS);
  element.style.setProperty('--ailu-brand-mark-mask', `url("${ailuBrandMarkUrl}")`);
}

export function createAiluBrandMark(
  parent: HTMLElement,
  className: string,
): HTMLSpanElement {
  const mark = parent.createSpan({
    cls: [AILU_BRAND_MARK_CLASS, className],
    attr: { 'aria-hidden': 'true' },
  });
  applyAiluBrandMark(mark);
  return mark;
}

/**
 * Obsidian exposes the tab icon element at runtime but not in the public type
 * declarations. Branding that element keeps functional icons inside the Ailu
 * workspace intact while replacing only the top-level workspace identity.
 */
export function brandAiluWorkspaceTab(leaf: WorkspaceLeaf): void {
  const icon = (leaf as WorkspaceLeafWithTabIcon).tabHeaderInnerIconEl;
  if (!icon) return;
  icon.addClass('ailu-tab-brand-icon');
  applyAiluBrandMark(icon);
}

export function restoreWorkspaceTabIcon(leaf: WorkspaceLeaf): void {
  const icon = (leaf as WorkspaceLeafWithTabIcon).tabHeaderInnerIconEl;
  if (!icon) return;
  icon.removeClass('ailu-tab-brand-icon');
  icon.removeClass(AILU_BRAND_MARK_CLASS);
  icon.style.removeProperty('--ailu-brand-mark-mask');
}
