import {
  capturePublishingPreviewScroll,
  resolvePublishingPreviewScrollTop,
} from '../src/ui/publishingPreviewScroll';

const viewport = (scrollTop: number, scrollHeight = 2400, clientHeight = 600) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

describe('publishing preview scroll restoration', () => {
  test('keeps the same reading position after a preview rebuild', () => {
    const state = capturePublishingPreviewScroll(viewport(720));

    expect(resolvePublishingPreviewScrollTop(state, viewport(0, 2600))).toBe(720);
  });

  test('uses the visible content anchor when material above it changes height', () => {
    const state = capturePublishingPreviewScroll(viewport(720), 36);

    expect(resolvePublishingPreviewScrollTop(state, viewport(0, 2800), 1010)).toBe(974);
  });

  test('continues following the bottom when the user was already there', () => {
    const state = capturePublishingPreviewScroll(viewport(1790));

    expect(state.atBottom).toBe(true);
    expect(resolvePublishingPreviewScrollTop(state, viewport(0, 3000))).toBe(2400);
  });

  test('clamps a saved position when the refreshed article becomes shorter', () => {
    const state = capturePublishingPreviewScroll(viewport(1200));

    expect(resolvePublishingPreviewScrollTop(state, viewport(0, 900))).toBe(300);
  });

  test('does not move a preview that was at the top', () => {
    const state = capturePublishingPreviewScroll(viewport(0));

    expect(resolvePublishingPreviewScrollTop(state, viewport(0, 2800))).toBe(0);
  });
});
