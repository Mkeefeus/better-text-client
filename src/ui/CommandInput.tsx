import { createEffect, createSignal } from 'solid-js';
import { sendText } from '../adapter/archipelago';
import { status } from '../state/connection';

const MAX_HISTORY = 100;
// Kept at module level so it survives the component being re-created.
const history: string[] = [];

export default function CommandInput() {
  let inputElement!: HTMLInputElement;
  const [text, setText] = createSignal('');
  // -1 means "not browsing history"; otherwise an index into `history`.
  let historyIndex = -1;
  let draft = '';

  const connected = () => status() === 'connected';

  // Put the cursor in the box as soon as it becomes usable.
  createEffect(() => {
    if (connected()) inputElement.focus();
  });

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const value = text().trim();
    if (!value) return;

    const result = sendText(value);
    if (result === 'not-connected') return; // keep what was typed

    if (history[history.length - 1] !== value) history.push(value);
    if (history.length > MAX_HISTORY) history.shift();
    historyIndex = -1;
    setText('');
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'ArrowUp') {
      if (history.length === 0) return;
      event.preventDefault();
      if (historyIndex === -1) {
        draft = text();
        historyIndex = history.length - 1;
      } else if (historyIndex > 0) {
        historyIndex -= 1;
      }
      setText(history[historyIndex]);
    } else if (event.key === 'ArrowDown') {
      if (historyIndex === -1) return;
      event.preventDefault();
      if (historyIndex < history.length - 1) {
        historyIndex += 1;
        setText(history[historyIndex]);
      } else {
        historyIndex = -1;
        setText(draft);
      }
    }
  }

  return (
    <form class="command-input" onSubmit={submit}>
      <input
        ref={inputElement}
        value={text()}
        onInput={(event) => {
          historyIndex = -1;
          setText(event.currentTarget.value);
        }}
        onKeyDown={onKeyDown}
        placeholder={connected() ? 'Chat, or a command such as !hint Item Name or !help' : 'Connect to send messages'}
        aria-label="Message or command"
        spellcheck={false}
        autocomplete="off"
        disabled={!connected()}
      />
      <button type="submit" class="primary" disabled={!connected() || !text().trim()}>
        Send
      </button>
    </form>
  );
}
