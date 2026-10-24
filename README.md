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

### Update

Any way works: reload after `git pull`, **Load unpacked** from a new folder, or **Remove** and load again. Your overlay pages are saved as bookmarks (see below), so they survive all of these.

FullyFrame checks GitHub for a newer version when Chrome starts, then once a day and when you open the popup (at most hourly). When one exists, the icon shows a green **↓** while the overlay is off, and the popup explains how to update and lists what's new. After you update, the popup lists the changes once, in a green banner at the bottom; click **×** to dismiss it.

### Releasing

Bump `version` in `manifest.json` and add an entry at the top of `changelog.json` (`{ "version": "…", "changes": ["…"] }`). Installed copies notice the new version once it's on `main`.

## Usage

Click the toolbar button to open the FullyFrame popup.

### Overlay pages

- The input field searches and adds:
  - Typing filters the saved pages. Matches are highlighted, and the list scrolls sideways to show the match in the first result. Long URLs can be scrolled horizontally.
  - If you type a URL that isn't saved yet, **Add URL** becomes available. Clicking it (or pressing **Enter**) saves the page to the list and selects it. `https://` is added if you leave it out.
  - If only one saved page matches, **Enter** selects it.
- Click a page in the list to select it (highlighted, with a checkmark). Click it again to deselect it, which switches back to fullscreen mode.
- Click **×** to remove a page from the list.
- The list is kept in the **Other bookmarks › FullyFrame** bookmarks folder, so it survives removing or reinstalling the extension and syncs with your Chrome profile. You can also edit it there; the popup updates live. Lists saved by older versions move there automatically the first time you open the popup.

Selecting another page while the overlay is open loads that page instead. Deselecting all pages closes the overlay.

### URL patterns

Instead of a fixed URL, you can add a pattern that is filled in from the page you're on, so the matching page opens without typing it every time. Type it in the same input; the button reads **Add pattern**.

| In the pattern | Becomes |
| --- | --- |
| `{path}` | the current page's path, e.g. `/us/en/page.html` |
| `{query}` | its query string with the `?` (empty if none) |
| `{hash}` | its `#fragment` (empty if none) |
| `{-'.html'}` | removes `.html` from the end of what comes before it, if it's there |
| `{+'.html'}` | adds `.html` to the end of what comes before it, unless it's already there or that ends with `/` |

Quotes are optional (`{-.html}` works too), and `https://` is added if you leave it out. For example, these two patterns compare any page of a site in both directions:

- `main--patients-stryker--aemdemos.aem.page{path}{-'.html'}` – on `https://patients.stryker.com/us/en/ivs/treatments/balloon-kyphoplasty.html` it opens `https://main--patients-stryker--aemdemos.aem.page/us/en/ivs/treatments/balloon-kyphoplasty`.
- `patients.stryker.com{path}{+'.html'}` – leads back from the `aem.page` site.

With a pattern selected, the popup shows the page it gives for the current one, and warns when that is the same page (select the pattern for the other site). On aemcoder the pattern is filled in from the EDS preview iframe's URL, and when the preview moves to another page, the overlay loads the matching one. On other sites, the overlay follows when you open another page while it's on (it reopens with the matching page).

In the bookmarks folder a pattern is stored with the pattern as its name and the site it points to as its URL.

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
- **Scrolling is synced automatically.** When you flip, the other page scrolls so the same content sits under the middle of the screen. Flipping back without scrolling returns you exactly where you were. When the overlay opens, it starts at the content shown on the initial page.
- **Click** a spot to make it the sync point (a purple dot): while it's in view, that spot is kept in place when you flip instead of the middle of the screen. Click the dot again to remove it.
- **Esc** closes the overlay or exits fullscreen.

On `aemcoder.adobe.io` the overlay is placed next to the original iframe in the page, so the site's own dropdowns and menus still show above it.

## Notes

- **Framing headers are removed.** Many sites refuse to be framed (`X-Frame-Options`, CSP `frame-ancestors`). While the overlay is open, the extension removes these response headers, but only for the overlay page's host, only in subframes, and only in that tab. The rule is removed when the overlay closes.
- **Shortcut conflicts.** If **Alt+Space** is taken (for example by Spotlight alternatives such as Alfred or Raycast on macOS), change it at `chrome://extensions/shortcuts`. While the overlay is open, Alt+Space also works directly inside the page and inside both pages.
- **DevTools device mode.** If an element wider than the device makes Chrome zoom the initial page out, the overlay still covers the whole visible area at the same zoom. Its page is laid out at the device width (so the same mobile breakpoints apply), and the extra width is filled with white. Fullscreen mode behaves the same way.
- **Scroll sync is approximate.** The two pages have different markup, so their text and images are paired up by content. Text or images that exist on only one page are skipped, and spots between paired content are estimated from the nearest pair. Only vertical scrolling is synced.
