import { useId, useState, type KeyboardEvent } from 'react';
import styles from './Routing.module.scss';

export type DenseInputProps = {
  /** Accessible name; shown before the input unless `hideLabel`. */
  label: string;
  hideLabel?: boolean;
  value: string;
  /** Live edits (settings fields). */
  onChange?: (value: string) => void;
  /**
   * Commit on blur / Enter instead of per keystroke. Used where a commit can
   * move the row (priority → tier regrouping), so typing never loses focus.
   */
  onCommit?: (value: string) => void;
  error?: string | null;
  placeholder?: string;
  disabled?: boolean;
  /** Width in ch of the input box. */
  size?: number;
  numeric?: boolean;
};

export function DenseInput({
  label,
  hideLabel = false,
  value,
  onChange,
  onCommit,
  error,
  placeholder,
  disabled = false,
  size = 6,
  numeric = false,
}: DenseInputProps) {
  const id = useId();
  const errorId = `${id}-error`;
  // null = not editing: show the prop value; otherwise the in-progress text.
  const [editing, setEditing] = useState<string | null>(null);
  const shown = onCommit ? (editing ?? value) : value;

  const commit = () => {
    if (onCommit && editing !== null && editing !== value) onCommit(editing);
    setEditing(null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!onCommit) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape' && editing !== null) {
      event.preventDefault();
      setEditing(null);
    }
  };

  return (
    <span className={styles.field}>
      <label htmlFor={id} className={hideLabel ? styles.srOnly : styles.fieldLabel}>
        {label}
      </label>
      <input
        id={id}
        className={styles.input}
        style={{ width: `calc(${size}ch + 18px)` }}
        value={shown}
        placeholder={placeholder}
        disabled={disabled}
        inputMode={numeric ? 'numeric' : undefined}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        title={error ?? undefined}
        onFocus={() => onCommit && setEditing(value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        onChange={(event) => {
          if (onCommit) setEditing(event.target.value);
          else onChange?.(event.target.value);
        }}
      />
      {error && (
        // Dense table cells keep the message for assistive tech + tooltip only.
        <span id={errorId} className={hideLabel ? styles.srOnly : styles.fieldError}>
          {error}
        </span>
      )}
    </span>
  );
}
