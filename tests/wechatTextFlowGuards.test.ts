import {
  applyWeChatTextFlowGuards,
  WECHAT_TEXT_FLOW_BLOCK_SELECTOR,
  WECHAT_TEXT_FLOW_RESET_STYLE,
  WECHAT_TEXT_FLOW_WRAP_SELECTOR,
  WECHAT_TEXT_WRAP_GUARD_STYLE,
} from '../src/wechat/textFlowGuards';
import {
  buildExtractedDesignContainerStyle,
  buildExtractedDesignParagraphStyle,
  isExtractedDesignTemplateId,
} from '../src/wechat/extractedDesignThemes';
import { PAPER_INK_THEME } from '../src/wechat/paperInkTheme';
import {
  SOFT_PASTEL_CONTAINER_STYLE,
  SOFT_PASTEL_PARAGRAPH_STYLE,
} from '../src/wechat/softPastelTheme';
import { SELECTABLE_WECHAT_THEME_DEFINITIONS } from '../src/wechat/themes';

class TestStyle {
  private readonly values = new Map<string, { value: string; priority: string }>();

  setProperty(property: string, value: string, priority = ''): void {
    this.values.set(property, { value, priority });
  }

  getPropertyValue(property: string): string {
    return this.values.get(property)?.value ?? '';
  }

  getPropertyPriority(property: string): string {
    return this.values.get(property)?.priority ?? '';
  }
}

class TestElement {
  readonly style = new TestStyle();

  constructor(private readonly decorative = false) {}

  closest(): TestElement | null {
    return this.decorative ? this : null;
  }
}

class TestRoot extends TestElement {
  constructor(
    private readonly blockTargets: TestElement[],
    private readonly wrapTargets: TestElement[],
    private readonly flatContentTargets: TestElement[],
  ) {
    super(false);
  }

  querySelectorAll(selector: string): TestElement[] {
    if (selector === WECHAT_TEXT_FLOW_BLOCK_SELECTOR) return this.blockTargets;
    if (selector === WECHAT_TEXT_FLOW_WRAP_SELECTOR) return this.wrapTargets;
    return this.flatContentTargets;
  }
}

function expectForced(
  element: TestElement,
  property: string,
  value: string,
): void {
  expect(element.style.getPropertyValue(property)).toBe(value);
  expect(element.style.getPropertyPriority(property)).toBe('important');
}

describe('WeChat text-flow guards', () => {
  test('covers all eight selectable templates at both container and prose layers', () => {
    expect(SELECTABLE_WECHAT_THEME_DEFINITIONS).toHaveLength(8);

    for (const { id } of SELECTABLE_WECHAT_THEME_DEFINITIONS) {
      const containerStyle = id === 'paper-ink'
        ? PAPER_INK_THEME.container
        : id === 'soft-pastel'
          ? SOFT_PASTEL_CONTAINER_STYLE
          : isExtractedDesignTemplateId(id)
            ? buildExtractedDesignContainerStyle(id)
            : '';
      const paragraphStyle = id === 'paper-ink'
        ? PAPER_INK_THEME.paragraph
        : id === 'soft-pastel'
          ? SOFT_PASTEL_PARAGRAPH_STYLE
          : isExtractedDesignTemplateId(id)
            ? buildExtractedDesignParagraphStyle(id)
            : '';

      for (const style of [containerStyle, paragraphStyle]) {
        expect(style, id).toContain(WECHAT_TEXT_FLOW_RESET_STYLE);
        expect(style, id).toContain(WECHAT_TEXT_WRAP_GUARD_STYLE);
        expect(style, id).not.toContain('text-align:justify');
        expect(style, id).not.toContain('text-indent:2em');
      }
    }
  });

  test('publishes a host-resistant inline style contract', () => {
    expect(WECHAT_TEXT_FLOW_RESET_STYLE).toContain('text-align:left!important');
    expect(WECHAT_TEXT_FLOW_RESET_STYLE).toContain('text-align-last:left!important');
    expect(WECHAT_TEXT_FLOW_RESET_STYLE).toContain('text-indent:0!important');
    expect(WECHAT_TEXT_FLOW_RESET_STYLE).toContain('text-justify:none!important');
    expect(WECHAT_TEXT_FLOW_RESET_STYLE).toContain('word-spacing:normal!important');
    expect(WECHAT_TEXT_WRAP_GUARD_STYLE).toContain('overflow-wrap:anywhere!important');
    expect(WECHAT_TEXT_WRAP_GUARD_STYLE).toContain('word-break:break-word!important');
  });

  test('forces prose and flat-list content while preserving decorative regions', () => {
    const paragraph = new TestElement();
    const flatRow = new TestElement();
    const flatContent = new TestElement();
    const link = new TestElement();
    const decorativeParagraph = new TestElement(true);
    const root = new TestRoot(
      [paragraph, flatRow, flatContent, decorativeParagraph],
      [paragraph, flatRow, flatContent, link, decorativeParagraph],
      [flatContent],
    );

    applyWeChatTextFlowGuards(root as unknown as HTMLElement);

    for (const element of [root, paragraph, flatRow, flatContent]) {
      expectForced(element, 'text-align', 'left');
      expectForced(element, 'text-align-last', 'left');
      expectForced(element, 'text-indent', '0');
      expectForced(element, 'text-justify', 'none');
      expectForced(element, 'word-spacing', 'normal');
    }
    for (const element of [root, paragraph, flatRow, flatContent, link]) {
      expectForced(element, 'overflow-wrap', 'anywhere');
      expectForced(element, 'word-break', 'break-word');
    }
    expectForced(flatContent, 'min-width', '0');
    expectForced(flatContent, 'max-width', '100%');
    expect(decorativeParagraph.style.getPropertyValue('text-align')).toBe('');
    expect(decorativeParagraph.style.getPropertyValue('text-indent')).toBe('');
  });
});
