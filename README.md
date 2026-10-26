# AskChatty

A personal rebuild of the "SubChat — AI side-chat" extension's core feature:
highlight text on any page and ask Claude follow-ups in a floating widget.

## Install
1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → pick this repo's folder.
3. Be signed in to claude.ai (or add an Anthropic API key in the settings page).

## Use
- Select text → click **Ask**, or press **Alt+Shift+S**, or right-click → *AskChatty: ask about…*.
- PDFs: Chrome's PDF viewer hides selections from extensions, so select text and
  right-click → *AskChatty: ask about…* there.
- Enter sends, Shift+Enter is a newline, **Stop** cancels a reply.
- **Keep** saves the chat to your claude.ai history; otherwise the hidden
  conversation is deleted when the widget closes.
- Click the toolbar icon for settings and searchable history.

## How it works (from reverse-engineering the original)
- **On claude.ai:** creates a hidden conversation named `↪ AskChatty` via
  `/api/organizations/{org}/chat_conversations`, streams `/completion` (SSE), and
  chains turns with `parent_message_uuid`.
- **On other sites:** the widget opens a port to the background worker, which runs
  the same request inside a claude.ai tab (opening a pinned background tab if
  needed) and streams it back. If that fails and you've saved a key, it falls back
  to the Anthropic Messages API.
- Cleanup: deletes run in a claude.ai tab; if none is open they're queued and
  drained on the next claude.ai load. Orphaned `↪ AskChatty` threads idle 15+ min
  are swept.

Removed from the original: payments/Pro gating, ChatGPT/Gemini adapters, the
"Web Mind" memory and embedding system, and file uploads.
