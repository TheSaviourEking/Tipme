'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import type { PayoutBank } from '@tipme/contracts';
import {
  arrangeBanks,
  type BankBadge,
  type DirectoryBank,
} from '@/lib/bank-directory';
import { matchCountText, searchBanks, type BankMatch } from '@/lib/bank-search';
import { nextActive } from '@/lib/listbox-navigation';

type Option =
  | {
      id: string;
      kind: 'bank';
      bank: DirectoryBank;
      marks?: BankMatch['marks'];
    }
  | { id: string; kind: 'more' };

type Section = { label: string; keys?: boolean; options: Option[] };

function Badge({ badge }: { badge: BankBadge }) {
  return (
    <span
      className="bank-badge"
      aria-hidden="true"
      style={
        badge.tone && badge.ink
          ? { background: badge.tone, color: badge.ink }
          : undefined
      }
    >
      {badge.initials}
    </span>
  );
}

/** The name with the matched letters underlined. */
function Marked({ name, marks }: { name: string; marks: BankMatch['marks'] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of marks) {
    if (start > at) parts.push(name.slice(at, start));
    parts.push(<mark key={start}>{name.slice(start, end)}</mark>);
    at = end;
  }
  if (at < name.length) parts.push(name.slice(at));
  return <>{parts}</>;
}

/**
 * The Bank field: an editable combobox with list autocomplete (WAI-ARIA APG). Typing searches the
 * partner's list; only choosing an option calls `onChange`, so typing never clears the choice.
 * Board: docs/design/redesign/boards/BankPicker.dc.html, section A.
 */
export function BankPicker({
  id,
  banks,
  value,
  onChange,
  disabled = false,
}: {
  /** From the card's useId, so the label stays `${id}-bank`. */
  id: string;
  banks: readonly PayoutBank[];
  /** The chosen bank code, '' for none. */
  value: string;
  /** Only on choosing an option, never while typing. */
  onChange(code: string): void;
  disabled?: boolean;
}) {
  const directory = useMemo(() => arrangeBanks(banks), [banks]);
  const chosen = useMemo(
    () =>
      [...directory.all, ...directory.more].find(
        (bank) => bank.code === value,
      ) ?? null,
    [directory, value],
  );
  const chosenName = chosen?.name ?? '';
  // What the person has typed since they last chose or closed; null shows the chosen name.
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [moreOpen, setMoreOpen] = useState(false);
  const [counted, setCounted] = useState({ query: '', text: '' });
  const input = useRef<HTMLInputElement>(null);

  const text = draft ?? chosenName;
  // The chosen name in the field counts as no query, so reopening shows the grouped view.
  const query = draft === null || draft === chosenName ? '' : draft;
  const results = useMemo(
    () => searchBanks(directory, query),
    [directory, query],
  );

  const sections: Section[] = useMemo(() => {
    const bankOption = (bank: DirectoryBank, popular = false): Option => ({
      id: `${id}-bank-${popular ? 'popular-' : ''}${bank.code}`,
      kind: 'bank',
      bank,
    });
    if (results)
      return [
        {
          label: '',
          options: results.map(({ bank, marks }) => ({
            ...bankOption(bank),
            marks,
          })),
        },
      ];
    const grouped: Section[] = [];
    if (directory.popular.length)
      grouped.push({
        label: 'Popular',
        keys: true,
        options: directory.popular.map((bank) => bankOption(bank, true)),
      });
    grouped.push({
      label: 'All banks, A to Z',
      options: directory.all.map((bank) => bankOption(bank)),
    });
    if (directory.more.length)
      grouped.push({
        label: 'More banks: microfinance and mortgage',
        options: moreOpen
          ? directory.more.map((bank) => bankOption(bank))
          : [{ id: `${id}-bank-more`, kind: 'more' }],
      });
    return grouped;
  }, [results, directory, moreOpen, id]);
  const options = useMemo(() => sections.flatMap((s) => s.options), [sections]);
  const activeOption = open ? options[active] : undefined;

  // The live count, once typing has paused, so a screen reader isn't talked over.
  useEffect(() => {
    if (!query || !results) return;
    const timer = setTimeout(
      () => setCounted({ query, text: matchCountText(results.length, query) }),
      300,
    );
    return () => clearTimeout(timer);
  }, [query, results]);
  const status = query && counted.query === query ? counted.text : '';

  useEffect(() => {
    if (!activeOption) return;
    document
      .getElementById(activeOption.id)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeOption]);

  const close = () => {
    setOpen(false);
    setActive(-1);
    setDraft(null);
  };
  const choose = (option: Option) => {
    if (option.kind === 'more') {
      // Unfolds the group; the first bank in it takes the place of this row.
      setMoreOpen(true);
      setActive(options.indexOf(option));
      return;
    }
    onChange(option.bank.code);
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Home':
      case 'End':
        if (!open) {
          if (event.key !== 'ArrowDown') return;
          event.preventDefault();
          setOpen(true);
          setActive(nextActive(-1, 'ArrowDown', options.length));
          return;
        }
        event.preventDefault();
        setActive(nextActive(active, event.key, options.length));
        return;
      case 'Enter':
        // Never submits the form: Enter here only ever chooses.
        event.preventDefault();
        if (activeOption) choose(activeOption);
        return;
      case 'Escape':
        if (open) {
          event.preventDefault();
          close();
        }
        return;
    }
  };

  const listId = `${id}-banks`;
  const noMatch = results !== null && results.length === 0;

  return (
    <div className="tm-field bank-picker">
      <label htmlFor={`${id}-bank`}>Bank</label>
      <div className="bank-picker__field">
        <input
          ref={input}
          id={`${id}-bank`}
          className="tm-input bank-picker__input"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={activeOption?.id}
          placeholder="Search your bank"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          value={text}
          onFocus={(event) => {
            event.currentTarget.select();
            setOpen(true);
          }}
          onClick={() => setOpen(true)}
          onBlur={close}
          onChange={(event) => {
            const next = event.target.value;
            const nextQuery = next === chosenName ? '' : next;
            setDraft(next);
            setOpen(true);
            setActive(
              nextQuery && searchBanks(directory, nextQuery)?.length ? 0 : -1,
            );
          }}
          onKeyDown={onKeyDown}
        />
        <span className="bank-picker__caret" aria-hidden="true">
          ⌄
        </span>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
      <div className="bank-picker__popup" hidden={!open}>
        <div
          id={listId}
          role="listbox"
          aria-label="Banks"
          className="bank-picker__list"
          hidden={!open || noMatch}
        >
          {open &&
            sections.map((section, index) =>
              section.label ? (
                <div
                  key={section.label}
                  role="group"
                  aria-labelledby={`${listId}-group-${index}`}
                  className="bank-picker__group"
                >
                  <div
                    role="presentation"
                    id={`${listId}-group-${index}`}
                    className="bank-picker__heading"
                  >
                    {section.label}
                  </div>
                  <div
                    className={
                      section.keys ? 'bank-picker__keys' : 'bank-picker__rows'
                    }
                  >
                    {section.options.map((option) =>
                      renderOption(option, section.keys),
                    )}
                  </div>
                </div>
              ) : (
                section.options.map((option) => renderOption(option))
              ),
            )}
        </div>
        {open && noMatch && (
          <p className="bank-picker__none">{matchCountText(0, query)}</p>
        )}
        {open && !noMatch && (
          <p className="tm-hint bank-picker__hint">
            ↑ ↓ to move, Enter to choose, Esc to close.
          </p>
        )}
      </div>
    </div>
  );

  function renderOption(option: Option, key = false) {
    const isActive = option === activeOption;
    const common = {
      id: option.id,
      role: 'option' as const,
      'aria-selected': isActive,
      // Keeps focus in the field, so choosing never blurs (and closes) it first.
      onPointerDown: (event: PointerEvent) => event.preventDefault(),
      onClick: () => choose(option),
    };
    if (option.kind === 'more')
      return (
        <div
          key={option.id}
          {...common}
          className="bank-picker__option bank-picker__more"
        >
          More banks: microfinance and mortgage
          <span aria-hidden="true">⌄</span>
        </div>
      );
    const { bank, marks } = option;
    const isChosen = bank.code === value;
    return (
      <div
        key={option.id}
        {...common}
        className={key ? 'bank-picker__key' : 'bank-picker__option'}
        data-chosen={isChosen || undefined}
      >
        <Badge badge={bank.badge} />
        <span className="bank-picker__name">
          {key ? (
            bank.popularLabel
          ) : marks ? (
            <Marked name={bank.name} marks={marks} />
          ) : (
            bank.name
          )}
        </span>
        {isChosen && (
          <span className="bank-picker__tick" aria-hidden="true">
            ✓
          </span>
        )}
      </div>
    );
  }
}
