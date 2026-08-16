# Third-Party Notices

Ailu is distributed under GNU AGPL-3.0-or-later. The notices
below preserve the copyright, license, and provenance of incorporated or
adapted third-party work.

## WeSight

Ailu is a substantially modified derivative of the
[WeSight Obsidian plugin 0.4.0](https://github.com/freestylefly/wesight-obsidian/tree/0.4.0),
whose tag resolves to commit
[`4fab17721cf1deecf8c6f882a7afbf30943e980c`](https://github.com/freestylefly/wesight-obsidian/commit/4fab17721cf1deecf8c6f882a7afbf30943e980c).

WeSight Obsidian plugin Copyright (C) 2026 WeSight contributors.

Ailu modifications Copyright (C) 2026 Ailu contributors. The Ailu modification
history began on 2026-08-05 and includes substantial changes to product
identity, Agent runtimes, storage, publishing workflows, security boundaries,
tests, documentation, and release tooling. The combined modified work is
distributed under the root `AGPL-3.0-or-later` license.

WeSight source releases through version 0.1.7 were made available under the
MIT License. That earlier history is preserved only as provenance and is not
the license of Ailu's direct WeSight 0.4.0 baseline. The previous MIT notice
remains available at `LICENSES/MIT.txt`.

## MP Preview

Ailu includes code adapted from
[MP Preview](https://github.com/Yeban8090/mp-preview).

Copyright (c) 2025 夜半Yeban.

License: MIT. The complete license notice is available at
`LICENSES/MP-PREVIEW-MIT.txt`.

## X Article in Obsidian

Ailu includes local preview code adapted from the user's
`x-article-in-obsidian` plugin. The legacy browser-injection and bundled
uploader scripts are not included; draft creation is delegated to the
independently installed `x-article-draft-uploader` Skill.

Copyright (c) 2026 Icy-Cat.

License: MIT. The complete license notice is available at
`LICENSES/X-ARTICLE-IN-OBSIDIAN-MIT.txt`.

## Open Design templates

Ailu's six local WeChat design themes adapt design direction, palette tokens,
and presentation patterns from the following templates in
[`nexu-io/open-design`](https://github.com/nexu-io/open-design), pinned for
provenance to commit
[`5580736c1ac6717f70d2f7f0aec4b3e7475e9f28`](https://github.com/nexu-io/open-design/tree/5580736c1ac6717f70d2f7f0aec4b3e7475e9f28):

- `open-design-landing`, licensed under Apache License 2.0. Copyright 2026
  Open Design contributors. The complete license is available at
  `LICENSES/OPEN-DESIGN-APACHE-2.0.txt`.
- `html-ppt-zhangzara-vellum`,
  `html-ppt-zhangzara-editorial-tri-tone`,
  `html-ppt-zhangzara-pink-script`, `html-ppt-zhangzara-playful`, and
  `html-ppt-zhangzara-capsule`, each licensed under the MIT License.
  Copyright (c) 2026 Zara Zhang. All five templates carry the same complete
  license notice, reproduced at `LICENSES/ZARA-ZHANG-TEMPLATES-MIT.txt`.

The five Zara Zhang template manifests in Open Design identify their original
sources in
[`zarazhangrui/beautiful-html-templates`](https://github.com/zarazhangrui/beautiful-html-templates).
Ailu's theme implementation is substantially modified for deterministic,
local WeChat rendering; no original template asset bundle is redistributed.

## qrcode

Ailu uses version 1.5.4 of the
[`qrcode`](https://github.com/soldair/node-qrcode) JavaScript package to render the
short-lived authorization URL returned by the independently installed
`lark-cli` as a local QR code.

Copyright (c) 2012 Ryan Day.

License: MIT. The complete license notice is available at
`LICENSES/QRCODE-MIT.txt`.

### dijkstrajs

`qrcode` includes version 1.0.3 of
[`dijkstrajs`](https://github.com/tcort/dijkstrajs) as a runtime dependency.

Copyright (C) 2008 Wyatt Baldwin. All rights reserved.

License: MIT. The complete upstream license notice is available at
`LICENSES/DIJKSTRAJS-MIT.txt`.

### pngjs

`qrcode` includes version 5.0.0 of
[`pngjs`](https://github.com/lukeapage/pngjs) as a runtime dependency.

pngjs2 original work Copyright (c) 2015 Luke Page & Original Contributors.
pngjs derived work Copyright (c) 2012 Kuba Niegowski.

License: MIT. The complete license notice is available at
`LICENSES/PNGJS-MIT.txt`.

## entities

Ailu uses version 4.5.0 of the
[`entities`](https://github.com/fb55/entities) JavaScript
package to decode HTML character references exactly when comparing Markdown
image anchors with the rendered X Article text.

Copyright (c) Felix Böhm. All rights reserved.

License: BSD-2-Clause. The complete license notice is available at
`LICENSES/ENTITIES-BSD-2-CLAUSE.txt`.
