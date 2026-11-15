import { createMemo, For } from 'solid-js';
import type { JSX } from 'solid-js';
import { roster } from '../state/connection';
import { compareText } from '../state/filtering';
import type { ClassFilter, SortDir } from '../state/filtering';

// Controls shared by the Hints and History tabs.

/** A "pick a player" dropdown. The value is a slot number as a string, or '' for anyone. */
export function PlayerSelect(props: { label: string; title: string; value: string; onChange: (value: string) => void }) {
  /** Every slot in the room: you first, then alphabetically. */
  const players = createMemo(() =>
    [...roster()].sort((a, b) => Number(b.isMe) - Number(a.isMe) || compareText(a.name, b.name)),
  );

  return (
    <label title={props.title}>
      {props.label}
      <select value={props.value} onChange={(event) => props.onChange(event.currentTarget.value)}>
        <option value="" selected={props.value === ''}>
          Anyone
        </option>
        <For each={players()}>
          {(player) => (
            <option value={String(player.slot)} selected={props.value === String(player.slot)}>
              {player.name}
              {player.isMe ? ' (you)' : ''}
            </option>
          )}
        </For>
      </select>
    </label>
  );
}

export function ItemTypeSelect(props: { value: ClassFilter; onChange: (value: ClassFilter) => void }) {
  return (
    <label>
      Item type
      <select value={props.value} onChange={(event) => props.onChange(event.currentTarget.value as ClassFilter)}>
        <option value="any">Any</option>
        <option value="progression">Progression</option>
        <option value="useful">Useful</option>
        <option value="trap">Trap</option>
        <option value="filler">Filler</option>
      </select>
    </label>
  );
}

/** The clickable text of a sortable column header, with an arrow when it is the active sort. */
export function SortButton(props: { active: boolean; dir: SortDir; onClick: () => void; children: JSX.Element }) {
  return (
    <button type="button" class="th-button" onClick={props.onClick}>
      {props.children}
      {props.active ? (props.dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </button>
  );
}
