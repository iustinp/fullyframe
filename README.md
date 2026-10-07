# FullyFrame

A Chrome extension for working with page previews embedded in iframes. It has two modes.

- **Fullscreen mode** (default): the toolbar button expands the detected iframe to fill the window.
- **Overlay mode** (when a custom page URL is set): the toolbar button lays your custom page exactly over the detected iframe, so you can flip between the two to compare them.

The detected iframe is the one titled `Page Preview`, else one whose URL contains `previewToken` or `preview-aemcoder`, else the largest iframe on the page.

## Install

1. Clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repository folder.

## Usage

### Fullscreen mode

Click the toolbar button (or press **Alt+Space**, **⌥ Space** on macOS) to make the iframe fullscreen. Click again or press **Esc** to restore it. The badge shows **ON** while active.

### Overlay mode

1. Open the extension's **Options** and set a custom page URL (http/https).
2. Click the toolbar button: the custom page is loaded over the iframe, at the same size and position.
3. Click again, or press **Alt+Space**, to switch between the two pages. Neither page reloads when you switch, and each keeps its own scroll position.
   - **Src**: the custom page is showing.
   - **EDS**: the original iframe is showing.
4. **Alt+click** (⌥+click) any text to align the pages. The same text on the other page is scrolled to the same height. When text appears more than once, the copy with the most similar surrounding text and section heading is chosen.
5. Press **Esc** to close the overlay.

The overlay is placed next to the original iframe in the page, so the host page's own dropdowns and menus still show above it.

To go back to fullscreen mode, clear the URL in Options.

## Notes

- **Framing headers are removed.** Many sites refuse to be framed (`X-Frame-Options`, CSP `frame-ancestors`). While the overlay is open, the extension removes these response headers, but only for the custom page's host, only in subframes, and only in that tab. The rule is removed when the overlay closes.
- **Shortcut conflicts.** If **Alt+Space** is taken (for example by Spotlight alternatives such as Alfred or Raycast on macOS), change it at `chrome://extensions/shortcuts`. While the overlay is open, Alt+Space also works directly inside the page and inside both iframes.
- **Text alignment is approximate.** Alt+click alignment depends on similar text existing on both pages, so it may pick the wrong spot if the surrounding content is very different.
