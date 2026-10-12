# FullyFrame

A Chrome extension for comparing a page with any other page laid exactly on top of it, or for making an embedded preview iframe fullscreen.

- **Compare mode** (when an overlay page is selected): the overlay page is laid over the initial page (the one you have open) so you can flip between the two.
  - On `aemcoder.adobe.io` it covers the EDS preview iframe at the same size and position; there the overlay is usually the source page.
  - On any other site it covers the whole viewport.
- **Fullscreen mode** (no overlay page selected): the detected iframe expands to fill the window.

The detected iframe is the one titled `Page Preview`, else one whose URL contains `previewToken` or `preview-aemcoder`, else the largest iframe on the page.

## Install

1. Clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repository folder.

## Usage

Click the toolbar button to open the FullyFrame popup.

### Overlay pages

- The input field searches and adds:
  - Typing filters the saved pages.
  - If you type a URL that isn't saved yet, **Add URL** becomes available. Clicking it (or pressing **Enter**) saves the page to the list and selects it. `https://` is added if you leave it out.
  - If only one saved page matches, **Enter** selects it.
- Click a page in the list to select it (highlighted, with a checkmark). Click it again to deselect it, which switches back to fullscreen mode.
- Click **×** to remove a page from the list.

Selecting another page while the overlay is open loads that page instead. Deselecting all pages closes the overlay.

### View

- **Compare mode:** the **Initial / Overlay** switch flips between the page you opened and the selected overlay page (on aemcoder it reads **EDS / Source**). The first switch to Overlay loads the overlay; after that, neither page reloads when you flip, and each keeps its own scroll position.
- **Fullscreen mode:** the **Fullscreen iframe** switch turns fullscreen on or off.

The toolbar badge shows what is on screen:

| Badge | Showing | On aemcoder |
| --- | --- | --- |
| **Init** | the initial page you opened | **EDS** |
| **Over** | the selected overlay page | **Src** |
| **ON** | fullscreen iframe | **ON** |

### Keyboard and mouse

- **Alt+Space** (**⌥ Space** on macOS) flips between the initial and overlay page. With no overlay page selected, it toggles fullscreen.
- **Alt+click** (⌥+click) any text to align the pages: the same text on the other page is scrolled to the same height. When text appears more than once, the copy with the most similar surrounding text and section heading is chosen.
- **Esc** closes the overlay or exits fullscreen.

On `aemcoder.adobe.io` the overlay is placed next to the original iframe in the page, so the site's own dropdowns and menus still show above it.

## Notes

- **Framing headers are removed.** Many sites refuse to be framed (`X-Frame-Options`, CSP `frame-ancestors`). While the overlay is open, the extension removes these response headers, but only for the overlay page's host, only in subframes, and only in that tab. The rule is removed when the overlay closes.
- **Shortcut conflicts.** If **Alt+Space** is taken (for example by Spotlight alternatives such as Alfred or Raycast on macOS), change it at `chrome://extensions/shortcuts`. While the overlay is open, Alt+Space also works directly inside the page and inside both pages.
- **Text alignment is approximate.** Alt+click alignment depends on similar text existing on both pages, so it may pick the wrong spot if the surrounding content is very different.
