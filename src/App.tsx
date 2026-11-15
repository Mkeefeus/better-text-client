import { createEffect, createMemo, createSignal, Match, Switch } from 'solid-js';
import ConnectBar from './ui/ConnectBar';
import CommandInput from './ui/CommandInput';
import HintsView from './ui/HintsView';
import LogView from './ui/LogView';
import { hints } from './state/hints';
import { clearMessages, lastMessageId, messages } from './state/messages';
import './App.css';

type Tab = 'log' | 'hints';

function App() {
  const [tab, setTab] = createSignal<Tab>('log');

  // While the Hints tab is open, count log messages that arrived unseen so the Log tab can show a badge.
  const [seenMessageId, setSeenMessageId] = createSignal(0);
  createEffect(() => {
    if (tab() === 'log') setSeenMessageId(lastMessageId());
  });
  const unread = () => (tab() === 'log' ? 0 : lastMessageId() - seenMessageId());

  // The tab badge counts unfound hints for items you need, not every hint in the room.
  const unfoundHints = createMemo(() => hints().filter((hint) => hint.forMe && !hint.found).length);

  return (
    <div class="app">
      <ConnectBar />

      <nav class="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab() === 'log'}
          classList={{ active: tab() === 'log' }}
          onClick={() => setTab('log')}
        >
          Log
          {unread() > 0 && <span class="badge">{unread() > 99 ? '99+' : unread()}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab() === 'hints'}
          classList={{ active: tab() === 'hints' }}
          onClick={() => setTab('hints')}
          title="The badge counts unfound hints for items you need"
        >
          Hints
          {unfoundHints() > 0 && <span class="badge">{unfoundHints()}</span>}
        </button>

        {/* Always in the layout (hidden, not removed, on the Hints tab) so the tab bar never shifts. */}
        <button
          type="button"
          class="tab-action"
          classList={{ hidden: tab() !== 'log' }}
          onClick={clearMessages}
          disabled={messages().length === 0}
          title="Remove all messages from the log"
        >
          Clear log
        </button>
      </nav>

      <main class="content">
        {/* Only the active tab is mounted: a hidden virtualized list would measure zero-height rows. */}
        <Switch>
          <Match when={tab() === 'log'}>
            <LogView />
          </Match>
          <Match when={tab() === 'hints'}>
            <HintsView />
          </Match>
        </Switch>
      </main>

      <CommandInput />
    </div>
  );
}

export default App;
