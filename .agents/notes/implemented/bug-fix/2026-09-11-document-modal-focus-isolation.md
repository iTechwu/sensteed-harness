# Agent Note: Document modal focus isolation

Status: implemented

English | [中文](2026-09-11-document-modal-focus-isolation.zh.md)

## Problem

AppFrame isolated only dialogs under `shell.overlay`. Settings renders under `sidebar.settings`, while the shared Modal renders through a body portal. Those paths could leave background controls interactive and keyboard focus outside a visible dialog. Nested plugin installation consent exposed the same gap. Independent Escape listeners could close both a child menu or dialog and its containing Settings panel.

## Decision

The AppFrame lifecycle owns one document-wide modal isolation effect. It recognizes visible `dialog` and `alertdialog` elements with `aria-modal="true"`, chooses the last eligible dialog in DOM order, and makes sibling branches outside that dialog inert. It preserves pre-existing inert state, skips hidden dialogs and externally inert trees, and leaves decorative masks available for the owning component's click-to-dismiss behavior.

A stack remembers the trigger when a dialog becomes active. Closing a child restores focus inside the parent; closing the outer dialog restores its connected, visible trigger. Tab and Shift+Tab wrap through enabled visible controls, and a dialog without any focusable control receives focus itself. Programmatic focus outside the active dialog is redirected. The disposer disconnects observers and event listeners before restoring background state, and queued focus work checks that its owner is still active.

A body-portaled Menu links itself to its anchor through `data-dsh-portal-owner`. The active dialog's owned portal branches remain interactive, including chained portals, while unrelated portals are isolated. Menu consumes Escape before parent dismissal handlers; Modal and Settings leave Escape to the dialog that contains focus. Feature components continue to own close actions, labels, authorization and persistence.

## Alternatives considered

Adding a separate focus trap to every feature dialog would duplicate lifecycle and nesting rules, leaving the next custom dialog outside the shared behavior. Restricting the existing observer to `shell.overlay` and moving Settings there would still miss body portals. Treating every body portal as interactive would permit keyboard focus into unrelated background controls. The document owner plus explicit portal ownership covers these cases without a new feature-plugin dependency.

## Consequences

This extends the ownership of shared client controls across AppFrame surfaces; it does not supersede each control's own close behavior or its local-control exceptions. The active dialog follows DOM order, not computed z-index. Custom interactive portals need an explicit owner marker; unmarked portals are treated as background. Standalone primitive consumers outside AppFrame still own focus isolation. No Session event, model request or API authorization changes.

## Verification

Focused component tests cover Settings in the sidebar, nested consent, body portals, owned menus, hidden and disabled controls, pre-existing inert state, forced outside focus, disposal, and nested Escape. The real Web Settings scenario checks focus containment and background isolation in the assembled application. The desktop Plugin Console browser harness installs the actual shared isolation effect around the real plugin bundle and checks consent keyboard order and background restoration while mocking its API writes.

The negative control without document-wide isolation fails the sidebar and body-portal background assertions. The layout package is excluded by the existing coverage configuration, so the focused coverage invocation reports no measured files; its passing tests are not evidence of 100% coverage. Browser and aggregate gate outcomes are recorded in the change handoff rather than inferred from component results.
