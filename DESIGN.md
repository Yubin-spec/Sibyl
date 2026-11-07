---
version: alpha
name: AI Bridge
description: A compact Chinese workspace for collaboration between coding tools and their original conversations.
colors:
  primary: "#007aff"
  primaryDark: "#0a84ff"
  background: "#f2f2f7"
  surface: "#ffffff"
  ink: "#1c1c1e"
  muted: "#6e6e73"
typography:
  sans:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif'
  mono:
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'
rounded:
  control: "10px"
  card: "16px"
  dialog: "18px"
spacing:
  sidebar: "200px"
  contentMax: "1120px"
  cardPadding: "20px"
  stackGap: "12px"
components:
  button: {}
  card: {}
  dialog: {}
  input: {}
---

# AI Bridge Design System

## Overview

### Creative North Star

A compact cross-platform utility workspace: a quiet sidebar, familiar blue actions, grouped project cards and a transcript that gives each tool an explicit identity. Preserve this established identity in the Windows desktop application.

### Product context and register

The product serves developers who connect AI tools on one computer or paired computers. Its single job is to make collaboration and its delivery state visible. The register is a working tool, with Simplified Chinese interface copy and recognizable tool names. Chinese locale does not establish a specific market or regulated workflow. There is no Japanese-market requirement.

The maintained product evidence is README.md, the original-session MCP implementation and docs/superpowers/plans/2026-11-06-windows-mcp.md. The Windows deliverable is a first-class desktop application, not an externally opened browser page. Keep macOS behavior and add Codex beside Claude Code and Cursor without a new visual system. Avoid marketing heroes, decorative motion and claims that configuration automatically attaches or wakes an existing chat.

Token ownership stays in desktop.css. Frontmatter above mirrors its current light-theme values and primary dark-theme color; it does not generate CSS. Change runtime tokens and this document together if the visual system changes.

## Windows Desktop Target

The Windows product form is an installed desktop application with a native window lifecycle. Use Tauri 2 with the system WebView2 runtime and reuse desktop.html, desktop.css and desktop.js. The existing Node 26 control service is a bundled sidecar; users must not need to install Node.js separately.

The desktop application owns:

- launch from the Start menu and a single-instance lock;
- a normal resizable window, close-to-tray behavior and an explicit quit action;
- graceful backend startup and shutdown, including recovery after an unclean exit;
- in-app update checks, signed update manifests and installer handoff;
- NSIS or MSI packaging with the Node sidecar and application icon included.

The external-browser launcher is a development and fallback path only. It must not be the documented Windows installation path or the basis for acceptance. The desktop shell must not expose bridge credentials, pairing secrets or model credentials to the web UI beyond the existing authenticated local API.

Acceptance requires real Windows 11 hardware: install, first launch, close-to-tray, restart, update, uninstall, and a bidirectional Codex/Claude original-session MCP exchange. Platform simulation tests are not sufficient. Cross-computer pairing behavior is unchanged unless separately designed. The checked-in browser launcher is a compatibility baseline, not evidence that the desktop target is complete.

## Colors

Use --bg for the workspace, --elevated for cards and conversation surfaces, --ink for content and --muted for guidance. --blue owns primary actions, selection and focus. The existing prefers-color-scheme rule owns dark colors; do not add screen-local palettes. Status remains explicit in text rather than relying on color.

## Typography

Use the existing platform sans stack with Chinese fallback. Body text is 13px/1.5; headings use 26px, 17px and 15px. Technical paths, logs and MCP instructions use the existing monospace stack, with wrapping for long paths and Chinese directory names. No font downloads are needed.

## Layout

Retain the 200px sidebar, 1120px content limit, 20px card padding, 12px stacked-card gap and 18px two-column gap. At widths up to 1050px the existing compact sidebar and spacing rules apply. MCP configuration buttons wrap within the existing row so adding Codex retains access to every action. At 850px and below, form columns and conversation panes stack, controls wrap and the transcript retains its own bounded scroll area. At 760px and below the same five navigation items form a top row, device/connection status stays visible, and content uses 16px side padding. This removes the old 850px minimum width without hiding actions or clipping long MCP configuration paths. Desktop geometry remains unchanged.

## Elevation & Depth

Use existing borders, subtle light-theme shadows and sidebar blur. Dark mode removes the card shadow and uses tonal separation. Keep configuration feedback inside the existing instruction panel and shared notice area.

## Shapes

Controls retain 10px corners, cards 16px, dialog and transcript bubbles 18px. Badges remain pills. Codex uses the same button shape and emphasis as the other MCP actions.

## Components

### Foundational visual states

Shared button CSS owns hover, pressed, disabled and focus-visible states. desktop.js action() disables the triggering button while its request runs and restores it on completion. Configuration failures use notice(); success also reveals nativeInstructions, a persistent role=status region. Preserve labels and geometry while requests are pending.

### Buttons and actions

Use native buttons with explicit action labels. The MCP actions are equal neutral choices: 配置 Codex MCP, 配置 Claude Code MCP and 配置 Cursor MCP. All call connectNative(), which uses the selected nativeProject and the common API/error path. Native macOS capabilities use the existing window.webkit bridge. The Windows desktop target uses a Tauri command bridge for the same capabilities. The external-browser fallback explains manual absolute-path entry and backend shutdown through the stop script.

### Navigation and data display

Retain the five sidebar pages and their existing navigation. Original-session registration and received questions stay on 本机 AI, separately from managed CLI conversation history. Local original sessions require no computer pairing. Keep tool identity, delivery and reply states explicit.

### Forms and overlays

The existing native select is the canonical owner for project and tool selection; platform-owned popup geometry and keyboard behavior are accepted. Reuse existing labels and options(). Do not add a second select or notification system. Native MCP configuration validates the selected project before dispatch. Existing project-form validation and deletion confirmation are legacy behavior; this addition does not claim a broader form or dialog migration.

### Iconography

Keep the existing text labels and sidebar symbols. The added MCP action needs no logo or icon.

### Motion

Retain the existing short button hover/pressed feedback. Add no new motion, skeletons or loading layout changes.

### Content and data visualization

Use concrete Chinese action and status text. Configuration success means a file was written. Original chats still need to enable the connector, register, receive and reply. Plain MCP does not automatically wake an idle chat. Windows desktop copy must describe desktop behavior; browser fallback copy must describe browser behavior. macOS installer and close-to-tray controls must identify their native scope.

## Do's and Don'ts

- Reuse existing card, row, button, notice and instruction-panel owners.
- Preserve source configuration, unrelated servers and the first backup; show errors without discarding the selected project.
- Keep names and feedback consistent across Codex, Claude Code and Cursor.
- Do not present managed CLI sessions as the user's already open original chats.
- Do not redesign unrelated screens or introduce new tokens for a single connector.
