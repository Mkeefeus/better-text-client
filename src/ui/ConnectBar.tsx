import { createSignal, Show } from 'solid-js';
import { connect, disconnect } from '../adapter/archipelago';
import { hintPoints, identity, loadProfile, saveProfile, status } from '../state/connection';

export default function ConnectBar() {
  const saved = loadProfile();
  const [url, setUrl] = createSignal(saved.url);
  const [slot, setSlot] = createSignal(saved.slot);
  const [password, setPassword] = createSignal('');

  const busy = () => status() === 'connecting';
  const active = () => status() === 'connecting' || status() === 'connected';

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!slot().trim() || !url().trim()) return;
    saveProfile({ url: url().trim(), slot: slot().trim() });
    void connect({ url: url(), slot: slot().trim(), password: password() });
  }

  return (
    <form class="connect-bar" onSubmit={submit}>
      <input
        class="field-url"
        value={url()}
        onInput={(event) => setUrl(event.currentTarget.value)}
        placeholder="host:port"
        title="Server address (host:port, or ws://… / wss://…)"
        aria-label="Server address"
        spellcheck={false}
        disabled={active()}
      />
      <input
        class="field-slot"
        value={slot()}
        onInput={(event) => setSlot(event.currentTarget.value)}
        placeholder="Slot name"
        title="Slot name"
        aria-label="Slot name"
        spellcheck={false}
        disabled={active()}
      />
      <input
        class="field-password"
        type="password"
        value={password()}
        onInput={(event) => setPassword(event.currentTarget.value)}
        placeholder="Password (optional)"
        title="Room password, if the room has one. It is never saved."
        aria-label="Password"
        disabled={active()}
      />
      <Show
        when={active()}
        fallback={
          <button type="submit" class="primary" disabled={!slot().trim() || !url().trim()}>
            Connect
          </button>
        }
      >
        <button type="button" onClick={disconnect}>
          {busy() ? 'Cancel' : 'Disconnect'}
        </button>
      </Show>
      <span class={`status-chip status-${status()}`}>
        {status() === 'connected' && identity() ? `${identity()!.name} · ${identity()!.game}` : status()}
      </span>
      <Show when={status() === 'connected' && hintPoints()}>
        {(points) => (
          <span class="hint-points" title="Hint points you have / points needed for one hint">
            Hint points {points().points} / {points().cost}
          </span>
        )}
      </Show>
    </form>
  );
}
