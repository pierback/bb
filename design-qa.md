# Design QA: agentic workspace thread UX

final result: passed

## Comparison target

- Source visual truth paths:
  - `/Users/f.pieringer/Library/Caches/clipimg/objects/61f9f64f75c8a964a63da7d0d8761ed69847e71ed00c16acd0efcc9115946172.png` (message action placement)
  - `/Users/f.pieringer/Library/Caches/clipimg/objects/ab31739a8023f81bb89fff46ef57f0747ec8dbec46d53da22c3b174d63204b2b.png` (Codex thread utility menu)
- Implementation screenshot paths:
  - `/Users/f.pieringer/.bb/thread-storage/thr_rwy6zvgtrq/electron-retry-action-story.png` (full component story)
  - `/Users/f.pieringer/.bb/thread-storage/thr_rwy6zvgtrq/electron-retry-action-focus.png` (focused failed-message row)
  - `/Users/f.pieringer/.bb/thread-storage/thr_rwy6zvgtrq/electron-thread-actions-committed.png` (actual bb Electron thread with menu open)
  - `/Users/f.pieringer/.bb/thread-storage/thr_rwy6zvgtrq/electron-thread-actions-latest-snapshot.png` (latest-snapshot fork action in the actual thread menu)
  - `/Users/f.pieringer/.bb/thread-storage/thr_rwy6zvgtrq/electron-fork-latest-composer.png` (fork composer opened from that action)
- State: desktop Electron, dark theme. The retry story force-reveals hover actions. The actual thread menu is open from the thread-header ellipsis, and the fork-composer capture shows the resulting `Forking Agentic Workspace Demo` state.

## Viewport and density

- Retry source: `444 x 66` pixels. Its CSS size and density metadata are unavailable.
- Menu source: `476 x 672` pixels. Its CSS size and density metadata are unavailable.
- Retry implementation full view: `2560 x 1736` pixels from a `1280 x 868` CSS viewport at device-pixel ratio `2`.
- Retry implementation focused clip: `960 x 168` pixels from a `480 x 84` CSS clip at device-pixel ratio `2`.
- Menu implementation: `2560 x 1800` pixels from a `1280 x 900` CSS viewport at device-pixel ratio `2`.
- Density normalization: no resampling was applied. The Electron implementation was deliberately captured at Retina density (`2x`) to match the macOS screenshot character of the sources. Because source CSS metadata is unavailable, the comparison uses native-pixel crops for proportional, hierarchy, ordering, and icon-style judgment rather than claiming false pixel precision.

## Findings

- No actionable P0, P1, or P2 visual differences remain.
- The implementation preserves bb's established menu and message-action design system instead of copying Codex's typography or removing bb's native icons. This is intentional product consistency, while the requested action semantics and grouping match the references.

## Full-view comparison evidence

- The actual Electron menu keeps the existing thread actions first, then separates workspace/copy utilities, fork/continuation, and destructive actions. `Copy working directory`, `Copy thread ID`, `Copy deeplink`, `Fork from latest snapshot`, and `Continue in new thread` are fully visible without wrapping or clipping. `Delete` remains isolated and uses bb's destructive token.
- The Codex-only project-move and new-window actions are intentionally absent per the agreed scope. `Reveal in Finder` is present in the final capture after the demo host registered Finder as a directory target.
- The full message-action story shows the new failed-user-message state alongside existing agent, user, disabled, and side-chat states. Adding Retry does not shift or break the surrounding action variants.

## Focused-region comparison evidence

- The focused retry capture clearly shows `Copy -> Retry -> Add to chat` in one compact action row. Icon size, stroke weight, baseline, gap, foreground color, and hover-reveal treatment are consistent with the neighboring existing actions.
- The menu capture is readable at full view; the open menu itself is large enough to inspect item height, grouping dividers, icons, typography, and destructive color without a second crop.

## Required fidelity surfaces

- Fonts and typography: existing bb Inter typography is unchanged. Menu labels and story annotations retain the established size, weight, line height, antialiasing, hierarchy, and truncation behavior; no label wraps or clips.
- Spacing and layout rhythm: native menu item height, padding, dividers, icon gaps, corner radius, and elevation remain consistent. The Retry icon slots between Copy and Add to chat without changing the row height, and the latest-snapshot fork sits beside the existing thread-continuation action.
- Colors and visual tokens: the implementation reuses bb foreground, muted, border, surface, hover, disabled, and destructive tokens. Contrast remains consistent with adjacent controls.
- Image quality and asset fidelity: there are no raster or decorative image assets in scope. All visible controls use the product's existing Lucide icon family; no handcrafted SVG, CSS art, emoji, or placeholder asset was introduced.
- Copy and content: labels are concise and use bb's domain term `thread` rather than Codex's `session`/`chat`. `Retry message` is exposed as the control's accessible label and tooltip; `Fork from latest snapshot` distinguishes a native history fork from the handoff-based `Continue in new thread` action.
- Responsiveness and accessibility: desktop inline placement and the mobile overflow variant are covered. Retry is a semantic button with an accessible label, tooltip, visible enabled state, and disabled state while resend is pending.

## Interaction and console checks

- Retry was clicked in the Electron-rendered component story. The inspected control was visible, enabled, and labeled `Retry message`; the click completed with zero console errors.
- The thread-header utility menu was opened in the actual isolated bb Electron app. The final capture produced zero console errors.
- `Fork from latest snapshot` was clicked in the actual Electron app. It opened the existing root composer with `Forking Agentic Workspace Demo`, reused the source worktree, and produced zero console errors; the app was then returned to the source thread with its menu open.
- Focused tests cover retry click/disabled/mobile behavior, failed-message association, clipboard values, deeplink generation, Finder callback wiring, latest-snapshot fork availability and navigation seed, and handoff navigation.

## Comparison history

- Pass 1: source and final implementation were opened together for both the retry action and thread utility menu. No P0/P1/P2 finding was identified, so no visual-fix iteration was required. The dedicated failed-message story was added to make the production action state inspectable; it was not a response to a fidelity defect.
- Pass 2: the latest-snapshot fork action and resulting fork composer were captured in the actual Electron app. The additional native menu row did not introduce clipping, wrapping, spacing drift, or visual hierarchy issues.

## Implementation checklist

- [x] Preserve the native bb action bar and menu styling.
- [x] Place Retry with the existing failed user message actions.
- [x] Place latest-snapshot fork beside the existing continuation action.
- [x] Group thread utilities coherently and isolate destructive actions.
- [x] Verify actual Electron rendering and interaction behavior.
- [x] Verify console output and focused automated tests.

## Session Fabric sidebar integration

### Comparison target

- Source visual truth: `/Users/f.pieringer/.bb/thread-storage/thr_4ydmt8mrjt/Attachments/image-1786272892068-p6xuok.png` (`1926 x 116` pixels), showing the connected worktree, bb conversation, provider-session UUID, and add control in the previous horizontal strip.
- Rendered implementation:
  - `/Users/f.pieringer/.bb/thread-storage/thr_4ydmt8mrjt/session-fabric-sidebar-full.png` (`2560 x 1800` pixels), the actual bb Electron app at a `1280 x 900` CSS viewport and DPR `2`.
  - `/Users/f.pieringer/.bb/thread-storage/thr_4ydmt8mrjt/session-fabric-sidebar-963x700@2x.png` (`1926 x 1400` pixels), the same connected thread at a source-width-matched `963 x 700` CSS viewport and DPR `2`.
  - `/Users/f.pieringer/.bb/thread-storage/thr_4ydmt8mrjt/session-fabric-thread-menu.png` (`2560 x 1800` pixels), the actual thread-actions menu open in Electron.
- Same-input comparison artifacts:
  - `/Users/f.pieringer/.bb/thread-storage/thr_4ydmt8mrjt/session-fabric-comparison-full.png` (`1926 x 1620` pixels), source and full matched-width implementation stacked together.
  - `/Users/f.pieringer/.bb/thread-storage/thr_4ydmt8mrjt/session-fabric-comparison-focus.png` (`1926 x 980` pixels), source and focused connected-navigation region stacked together.
- State: project `proj_dy2pcc4ww4`, thread `thr_879sv9dubt`, worktree environment `env_33qe82hp8h`, connected Codex conversation `019fe598-8d69-77d0-a654-9d993d4b58b3`, dark desktop Electron.

### Findings

- No actionable P0, P1, or P2 visual differences remain.
- The previous three-part strip and its detached `+` control are gone. This eliminates the duplicated navigation surface the user rejected.
- The selected bb conversation now carries the Codex provider icon and a small live-status dot in the sidebar, making the conversation-to-provider-session relationship visible at the navigation point.
- The thread header retains only the compact `Codex · Connected` status pill. It does not expose or truncate the provider UUID in permanent chrome.
- Worktree context remains available in the existing thread context bar, while full thread/session identifiers and workspace actions live in the established thread `…` menu.
- The layout remains readable at both `1280` and `963` CSS-pixel widths. No new overlap, clipping, wrapping, or horizontal overflow is visible.

### Full-view and focused comparison evidence

- The full comparison confirms the selected conversation, compact header status, transcript, composer, and existing worktree context bar coexist without introducing a second navigation row.
- The focused comparison confirms that the large worktree/conversation/session strip is fully removed and that its useful connection signal is represented twice at lower visual weight: once on the selected sidebar row and once beside the thread title.
- Existing bb spacing, borders, corner radii, typography, foreground hierarchy, provider iconography, and success-state color tokens are preserved.

### Interaction and console checks

- The thread-header `…` menu was opened in the actual Electron renderer. It contained exactly one each of `Copy working directory`, `Copy thread ID`, `Copy session ID`, and `Copy deeplink`, plus `Reveal in Finder`, fork, continuation, and destructive actions.
- The connected page and open-menu captures completed with zero runtime or console errors.
- An initial hot reload encountered a stale pre-commit Vite module URL while the source tree was changing. A fresh Electron navigation loaded the committed graph successfully; the error did not recur in either final capture.
- DOM inspection confirmed the legacy provider UUID strip text is absent and the compact connected status is present.

### Comparison history

- Pass 1: the live page briefly rendered blank because the long-running Vite client retained a removed module URL across the branch update. This was an environment refresh issue, not a layout finding.
- Pass 2: fresh navigation rendered the committed implementation. Source and implementation were combined at the same `1926`-pixel width for both full and focused review; no P0/P1/P2 issue was found.
- Pass 3: the actual menu was opened and inspected. Copy utilities were deduplicated during the retry/session integration rebase, and the final menu rendered without clipping or console errors.
