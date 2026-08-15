import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { editorInfoField, TFile } from 'obsidian';

import { PublishingEditorScrollSync } from './publishingSourceScroll';

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function createMarkdownEditorScrollExtension(
  scrollSync: PublishingEditorScrollSync,
): Extension {
  return ViewPlugin.fromClass(class {
    private readonly sourceId = scrollSync.registerSource();
    private frame: number | null = null;
    private readonly frameWindow: Window | null;
    private readonly onScroll = (): void => this.schedulePublish();

    constructor(private readonly view: EditorView) {
      this.frameWindow = view.dom.ownerDocument.defaultView;
      view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
      this.schedulePublish();
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || update.geometryChanged) {
        this.schedulePublish();
      }
    }

    destroy(): void {
      this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
      if (this.frame !== null) this.frameWindow?.cancelAnimationFrame(this.frame);
      this.frame = null;
      scrollSync.unregisterSource(this.sourceId);
    }

    private schedulePublish(): void {
      if (this.frame !== null) return;
      if (!this.frameWindow) {
        this.publish();
        return;
      }
      this.frame = this.frameWindow.requestAnimationFrame(() => {
        this.frame = null;
        this.publish();
      });
    }

    private publish(): void {
      if (!this.view.inView) return;
      const info = this.view.state.field(editorInfoField, false);
      if (!(info?.file instanceof TFile)) return;
      const viewportBounds = this.view.scrollDOM.getBoundingClientRect();
      // Obsidian keeps CodeMirror instances alive for background tabs. Those
      // editors can retain a different scroll position for the same file, but
      // their scrollers have no rendered area and must not become the source.
      if (viewportBounds.width <= 0 || viewportBounds.height <= 0) return;
      const viewportTop = viewportBounds.top;
      const sourceHeight = Math.max(0, (viewportTop - this.view.documentTop) / this.view.scaleY + 1);
      const block = this.view.lineBlockAtHeight(sourceHeight);
      const line = this.view.state.doc.lineAt(block.from);
      const lineProgress = block.height > 0
        ? clamp((sourceHeight - block.top) / block.height, 0, 1)
        : 0;
      scrollSync.publish(this.sourceId, {
        filePath: info.file.path,
        line: line.number - 1,
        lineProgress,
        lineCount: this.view.state.doc.lines,
      });
    }
  });
}
