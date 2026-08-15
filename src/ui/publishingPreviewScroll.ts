export interface PublishingPreviewViewport {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface PublishingPreviewScrollState {
  top: number;
  maxTop: number;
  atBottom: boolean;
  anchorOffset: number | null;
}

const PUBLISHING_PREVIEW_BOTTOM_THRESHOLD = 24;

function maxScrollTop(viewport: PublishingPreviewViewport): number {
  return Math.max(0, viewport.scrollHeight - viewport.clientHeight);
}

function clampScrollTop(value: number, maximum: number): number {
  return Math.min(Math.max(0, value), maximum);
}

export function capturePublishingPreviewScroll(
  viewport: PublishingPreviewViewport,
  anchorOffset: number | null = null,
): PublishingPreviewScrollState {
  const maxTop = maxScrollTop(viewport);
  const top = clampScrollTop(viewport.scrollTop, maxTop);
  return {
    top,
    maxTop,
    atBottom: maxTop - top <= PUBLISHING_PREVIEW_BOTTOM_THRESHOLD,
    anchorOffset,
  };
}

export function resolvePublishingPreviewScrollTop(
  state: PublishingPreviewScrollState,
  viewport: PublishingPreviewViewport,
  anchorContentTop: number | null = null,
): number {
  const nextMaxTop = maxScrollTop(viewport);
  if (anchorContentTop !== null && state.anchorOffset !== null) {
    return clampScrollTop(anchorContentTop - state.anchorOffset, nextMaxTop);
  }
  if (state.atBottom) return nextMaxTop;
  return clampScrollTop(state.top, nextMaxTop);
}
